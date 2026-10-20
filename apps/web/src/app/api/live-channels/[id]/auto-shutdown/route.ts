import { createHash } from "node:crypto";
import {
	deriveProviderLifecycle,
	liveAutoShutdownFingerprint,
	liveAutoShutdownUpdateParamsSchema,
	liveEffectIntentSchema,
	masterKeyFromEnv,
	readLiveAutoShutdownUpdate,
	stepLogSchema,
} from "@bitovp/core";
import { NextResponse } from "next/server";
import { z } from "zod";
import { customerErrorDetails } from "@/lib/customer-error";
import { getServerContext } from "@/lib/server/context";
import {
	invalidIdResponse,
	jsonError,
	readJson,
	routeError,
	validationError,
} from "@/lib/server/http";
import { getLiveChannelQueue } from "@/lib/server/queue";

type RouteParams = { params: Promise<{ id: string }> };
const requestSchema = z.strictObject({
	runId: z.uuid(),
	requestId: z.uuid(),
	expectedRevision: z.string().min(1).max(240).nullable(),
	configuration: liveAutoShutdownUpdateParamsSchema.shape.configuration,
});
const runSelect = {
	id: true,
	cancelRequested: true,
	bitmovinEncodingId: true,
	stepLog: true,
	providerStatus: true,
	providerStatusObservedAt: true,
	providerUnknownSince: true,
	providerTerminalAt: true,
} as const;
const queuedSchema = z.strictObject({
	liveChannelId: z.uuid(),
	action: z.literal("update-auto-shutdown"),
	params: liveAutoShutdownUpdateParamsSchema,
	effect: liveEffectIntentSchema.strict(),
});
const inProgress = new Set([
	"active",
	"waiting",
	"delayed",
	"waiting-children",
	"prioritized",
]);
const settled = new Set(["failed", "completed"]);
const beforeSendRefusalSchema = z.object({
	acknowledged: z.literal(true),
	liveChannelId: z.uuid(),
	action: z.literal("update-auto-shutdown"),
	status: z.enum([
		"SKIPPED_STALE_GENERATION",
		"EFFECT_REQUEST_CONFLICT",
		"EFFECT_REFUSED",
		"EFFECT_CLAIMED",
		"EFFECT_DISPATCHING",
		"EFFECT_FAILED",
		"EFFECT_RESOLVED",
	]),
});
function refusedBeforeSend(raw: unknown, channelId: string): boolean {
	const result = beforeSendRefusalSchema.safeParse(raw);
	return result.success && result.data.liveChannelId === channelId;
}
const requestKey = (id: string, requestId: string) =>
	`manual:auto-shutdown:${id}:${requestId}`;
const jobIdFor = (id: string, requestId: string) =>
	`${id}-auto-shutdown-${requestId}`;
const digest = (
	runId: string,
	params: z.infer<typeof liveAutoShutdownUpdateParamsSchema>,
) =>
	createHash("sha256")
		.update(
			liveAutoShutdownFingerprint(
				runId,
				params.configuration,
				params.expectedRevision,
			),
		)
		.digest("hex");
const conflict = (message: string) =>
	jsonError(409, message, customerErrorDetails("LIVE_ACTION_REQUEST_CONFLICT"));

/** Reads local receipts only; opening the panel does not poll the provider. */
export async function GET(req: Request, { params }: RouteParams) {
	const { id } = await params;
	const invalid = invalidIdResponse(id);
	if (invalid) return invalid;
	const query = z
		.object({ runId: z.uuid(), requestId: z.uuid().optional() })
		.safeParse(Object.fromEntries(new URL(req.url).searchParams));
	if (!query.success) return validationError(query.error);
	try {
		const { prisma } = await getServerContext();
		const channel = await prisma.liveChannel.findUnique({
			where: { id },
			select: { id: true, bitmovinEncodingId: true },
		});
		if (!channel) return jsonError(404, "Not found");
		const run = await prisma.liveChannelRun.findFirst({
			where: { liveChannelId: id },
			orderBy: { seq: "desc" },
			select: runSelect,
		});
		if (
			!run ||
			run.id !== query.data.runId ||
			!run.bitmovinEncodingId ||
			run.bitmovinEncodingId !== channel.bitmovinEncodingId
		)
			return conflict("The requested live run is no longer current");
		const entries = stepLogSchema.parse(run.stepLog);
		const receipt = readLiveAutoShutdownUpdate(entries);
		const start = entries.findLast(
			(entry) => entry.kind === "START_LIVE_ENCODING",
		);
		const starting = start
			? liveAutoShutdownUpdateParamsSchema.safeParse({
					configuration: start.payload.autoShutdownConfiguration ?? {},
				})
			: null;
		const key = query.data.requestId
			? requestKey(id, query.data.requestId)
			: undefined;
		const claim = await prisma.liveEffectClaim.findFirst({
			where: {
				liveChannelId: id,
				liveChannelRunId: run.id,
				providerEncodingId: run.bitmovinEncodingId,
				action: "AUTO_SHUTDOWN_UPDATE",
				...(key ? { idempotencyKey: key } : {}),
			},
			orderBy: { createdAt: "desc" },
			select: { idempotencyKey: true, state: true },
		});
		let state: string | null = claim?.state ?? null;
		if (
			claim?.state === "ACKED" &&
			!readLiveAutoShutdownUpdate(
				entries.filter(
					(entry) => entry.payload.requestId === claim.idempotencyKey,
				),
			)
		) {
			// The run was read before its receipt landed, but the claim after ACK.
			state = "AWAITING_RECEIPT";
		}
		if (!claim && query.data.requestId) {
			const queued = await getLiveChannelQueue().getJob(
				jobIdFor(id, query.data.requestId),
			);
			const data = queuedSchema.safeParse(queued?.data);
			if (
				queued &&
				data.success &&
				data.data.liveChannelId === id &&
				data.data.effect.idempotencyKey === key &&
				data.data.effect.liveChannelRunId === run.id &&
				data.data.effect.providerEncodingId === run.bitmovinEncodingId
			) {
				const queueState = await queued.getState();
				state = inProgress.has(queueState)
					? "QUEUED"
					: queueState === "failed" || refusedBeforeSend(queued.returnvalue, id)
						? "FAILED"
						: "AMBIGUOUS";
			}
		}
		return NextResponse.json({
			runId: run.id,
			configuration:
				receipt?.configuration ??
				(starting?.success ? starting.data.configuration : null),
			revision: receipt?.requestId ?? null,
			receipt,
			request: claim
				? { key: claim.idempotencyKey, state }
				: state
					? { key, state }
					: null,
		});
	} catch (err) {
		return routeError(err);
	}
}

/** The queue carries the full replacement bound to the exact run and request. */
export async function POST(req: Request, { params }: RouteParams) {
	const { id } = await params;
	const invalid = invalidIdResponse(id);
	if (invalid) return invalid;
	try {
		const body = requestSchema.safeParse(await readJson(req));
		if (!body.success) return validationError(body.error);
		masterKeyFromEnv();
		const { prisma } = await getServerContext();
		const channel = await prisma.liveChannel.findUnique({
			where: { id },
			select: {
				status: true,
				bitmovinEncodingId: true,
				liveEffectFenceVersion: true,
			},
		});
		if (!channel) return jsonError(404, "Not found");
		const run = await prisma.liveChannelRun.findFirst({
			where: { liveChannelId: id },
			orderBy: { seq: "desc" },
			select: runSelect,
		});
		if (
			channel.status !== "RUNNING" ||
			!run ||
			run.cancelRequested ||
			run.id !== body.data.runId ||
			!run.bitmovinEncodingId ||
			run.bitmovinEncodingId !== channel.bitmovinEncodingId
		)
			return conflict(
				"Automatic stop settings require the current RUNNING live run",
			);
		const updateParams = liveAutoShutdownUpdateParamsSchema.parse({
			configuration: body.data.configuration,
			expectedRevision: body.data.expectedRevision,
		});
		const requestSha256 = digest(run.id, updateParams);
		const key = requestKey(id, body.data.requestId);
		const existing = await prisma.liveEffectClaim.findUnique({
			where: { idempotencyKey: key },
		});
		if (
			existing &&
			(existing.liveChannelId !== id ||
				existing.liveChannelRunId !== run.id ||
				existing.providerEncodingId !== run.bitmovinEncodingId ||
				existing.requestSha256 !== requestSha256 ||
				existing.action !== "AUTO_SHUTDOWN_UPDATE")
		)
			return conflict(
				"This request ID is already bound to another automatic stop update",
			);
		if (existing?.state === "ACKED")
			return NextResponse.json({
				acknowledged: true,
				idempotentReplay: true,
				requestKey: key,
			});
		if (existing && existing.state !== "FAILED")
			return jsonError(
				409,
				"This update is pending or requires effect resolution; do not resend it",
				customerErrorDetails(
					existing.state === "AMBIGUOUS"
						? "LIVE_ACTION_REQUEST_AMBIGUOUS"
						: "LIVE_ACTION_REQUEST_IN_PROGRESS",
				),
			);
		const currentRevision =
			readLiveAutoShutdownUpdate(stepLogSchema.parse(run.stepLog))?.requestId ??
			null;
		if (currentRevision !== body.data.expectedRevision)
			return conflict(
				"Automatic stop settings changed; reload them before updating",
			);
		if (deriveProviderLifecycle(run, Date.now()) !== "RUNNING")
			return jsonError(
				409,
				"Wait for a fresh RUNNING provider observation before updating automatic stop settings",
				customerErrorDetails("LIVE_ACTION_PROVIDER_UNKNOWN"),
			);
		const effect = {
			idempotencyKey: key,
			requestSha256,
			liveChannelRunId: run.id,
			providerEncodingId: run.bitmovinEncodingId,
			admissionFenceVersion: channel.liveEffectFenceVersion,
			action: "AUTO_SHUTDOWN_UPDATE" as const,
		};
		const matches = (raw: unknown) => {
			const queued = queuedSchema.safeParse(raw);
			return (
				queued.success &&
				queued.data.liveChannelId === id &&
				queued.data.effect.action === effect.action &&
				queued.data.effect.idempotencyKey === key &&
				queued.data.effect.requestSha256 === requestSha256 &&
				queued.data.effect.liveChannelRunId === run.id &&
				queued.data.effect.providerEncodingId === run.bitmovinEncodingId &&
				queued.data.effect.scheduleId === undefined &&
				queued.data.effect.targetId === undefined &&
				digest(run.id, queued.data.params) === requestSha256
			);
		};
		const queue = getLiveChannelQueue();
		const jobId = jobIdFor(id, body.data.requestId);
		const previous = await queue.getJob(jobId);
		if (previous) {
			if (!matches(previous.data))
				return conflict("The queued update does not match this request");
			const state = await previous.getState();
			if (inProgress.has(state))
				return NextResponse.json(
					{ requestKey: key, handoffStatus: "QUEUED", idempotentReplay: true },
					{ status: 202 },
				);
			if (!settled.has(state))
				return conflict("The queued update has an unknown state");
			// A completed delivery without a durable ACK may have sent its request.
			if (
				state === "completed" &&
				existing?.state !== "FAILED" &&
				!refusedBeforeSend(previous.returnvalue, id)
			)
				return conflict(
					"The completed update needs effect resolution before another delivery",
				);
			await previous.remove();
		}
		await queue.add(
			"live-channel",
			{
				liveChannelId: id,
				action: "update-auto-shutdown",
				params: updateParams,
				effect,
			},
			{ jobId, attempts: 1, removeOnComplete: 1000, removeOnFail: 1000 },
		);
		const winner = await queue.getJob(jobId);
		if (!winner || !matches(winner.data))
			return conflict("Another payload won the queued update request");
		return NextResponse.json(
			{ requestKey: key, handoffStatus: "QUEUED" },
			{ status: 202 },
		);
	} catch (err) {
		return routeError(err);
	}
}
