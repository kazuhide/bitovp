import "server-only";
import { createHash } from "node:crypto";
import { stepLogSchema } from "@bitovp/core";
import type { AppPrismaClient, AppTransactionClient } from "@bitovp/db";
import { z } from "zod";
import { roleAtLeast } from "@/lib/auth/roles";
import { AuthContextError } from "@/lib/auth/tenancy";
import {
	MOQ_OBSERVATION_LIMITS,
	type MoqObservationSession,
	moqObservationSessionSchema,
	moqObservationUpdateSchema,
} from "@/lib/moq-player/observations";
import { writeAuditLog } from "./audit";
import { getServerContext, type ServerContext } from "./context";
import { readMoqHeartbeatHistory } from "./moq-heartbeat";
import { writeMoqObservationStore } from "./moq-observation-store";
import { readPlayerSettings } from "./player-config";

export class MoqObservationError extends Error {
	constructor(
		public readonly status: number,
		public readonly code: string,
	) {
		super(code);
	}
}
export type MoqObservationParams = {
	id: string;
	runId: string;
	sessionId?: string;
};
const storedSessionSchema = moqObservationSessionSchema.safeExtend({
	actor: z.string().min(1).max(256),
	archiveUploadSha256: z
		.string()
		.regex(/^[0-9a-f]{64}$/)
		.optional(),
	analyticsLicenseKeySha256: z
		.string()
		.regex(/^[0-9a-f]{64}$/)
		.optional(),
});
const storedSchema = z.strictObject({
	version: z.literal(1),
	sessions: z.array(storedSessionSchema).max(MOQ_OBSERVATION_LIMITS.sessions),
});
export type StoredMoqObservationSession = z.infer<typeof storedSessionSchema>;
export function parseMoqObservationStore(value: unknown) {
	const parsed = storedSchema.safeParse(value);
	if (!parsed.success)
		throw new MoqObservationError(503, "MOQ_HISTORY_UNAVAILABLE");
	return parsed.data;
}
export function publicMoqSession(
	session: StoredMoqObservationSession,
): MoqObservationSession {
	const {
		actor: _actor,
		archiveUploadSha256: _upload,
		analyticsLicenseKeySha256: _license,
		...result
	} = session;
	return result;
}
export async function moqObservationContext(
	req: Request,
	params: MoqObservationParams,
	write = false,
	allowedQueryKeys: readonly string[] = [],
) {
	// Filesystem UUID components are lowercase; reject aliases before any row/owner lookup.
	const ids = [
		params.id,
		params.runId,
		...(params.sessionId === undefined ? [] : [params.sessionId]),
	];
	if (
		ids.some((id) => id !== id.toLowerCase()) ||
		!z.uuid().safeParse(params.id).success ||
		!z.uuid().safeParse(params.runId).success ||
		(params.sessionId !== undefined &&
			!z.uuid().safeParse(params.sessionId).success) ||
		[...new URL(req.url).searchParams.keys()].some(
			(key) => !allowedQueryKeys.includes(key),
		)
	)
		throw new MoqObservationError(400, "MOQ_HISTORY_INVALID_REQUEST");
	const ctx = await getServerContext();
	if (
		!ctx.tenant ||
		!roleAtLeast(ctx.tenant.role, "OPERATOR") ||
		(write && ctx.tenant.isImpersonating)
	)
		throw new MoqObservationError(403, "MOQ_HISTORY_FORBIDDEN");
	return ctx;
}
export async function readMoqObservationRun(
	ctx: ServerContext,
	params: MoqObservationParams,
	prisma: AppPrismaClient | AppTransactionClient = ctx.prisma,
) {
	const run = await prisma.liveChannelRun.findFirst({
		where: { id: params.runId, liveChannelId: params.id },
		select: {
			id: true,
			organizationId: true,
			liveChannelId: true,
			status: true,
			bitmovinEncodingId: true,
			stepLog: true,
			moqObservations: true,
			endedAt: true,
			updatedAt: true,
		},
	});
	if (
		!run ||
		run.id !== params.runId ||
		run.liveChannelId !== params.id ||
		run.organizationId !== ctx.tenant?.organizationId
	)
		throw new MoqObservationError(404, "MOQ_HISTORY_RUN_NOT_FOUND");
	const encodingId = z.uuid().safeParse(run.bitmovinEncodingId);
	const log = stepLogSchema.safeParse(run.stepLog);
	if (!encodingId.success || !log.success)
		throw new MoqObservationError(409, "MOQ_HISTORY_RUN_UNBOUND");
	const outputs = log.data.filter((entry) =>
		entry.kind.startsWith("CREATE_OUTPUT_"),
	);
	const encodings = log.data.filter(
		(entry) => entry.kind === "CREATE_ENCODING",
	);
	const output = outputs[0],
		encoding = encodings[0];
	if (
		outputs.length !== 1 ||
		output?.kind !== "CREATE_OUTPUT_MOQ" ||
		output.status !== "DONE" ||
		!z.uuid().safeParse(output.resourceId).success ||
		encodings.length !== 1 ||
		encoding?.status !== "DONE" ||
		encoding.resourceId !== encodingId.data ||
		!log.data.some(
			(entry) =>
				entry.kind === "CREATE_MUXING_FMP4" &&
				entry.status === "DONE" &&
				entry.refs.encodingId === encoding.step &&
				entry.refs.outputId === output.step,
		)
	)
		throw new MoqObservationError(409, "MOQ_HISTORY_RUN_UNBOUND");
	const auditSelect = {
		organizationId: true,
		bitmovinAccountId: true,
		request: true,
		response: true,
	} as const;
	const [encodingAudits, outputAudits] = await Promise.all([
		prisma.auditLog.findMany({
			where: {
				method: "POST",
				path: "/encoding/encodings",
				statusCode: { gte: 200, lt: 300 },
				response: { path: ["id"], equals: encodingId.data },
			},
			select: auditSelect,
			take: 2,
		}),
		prisma.auditLog.findMany({
			where: {
				method: "POST",
				path: "/encoding/outputs/moq",
				statusCode: { gte: 200, lt: 300 },
				response: { path: ["id"], equals: output.resourceId },
			},
			select: auditSelect,
			take: 2,
		}),
	]);
	const proof = z.tuple([
		z.object({
			organizationId: z.uuid(),
			bitmovinAccountId: z.uuid(),
			request: z.unknown().optional(),
			response: z.object({ id: z.uuid() }),
		}),
	]);
	const encodingProof = proof.safeParse(encodingAudits),
		outputProof = proof.safeParse(outputAudits);
	if (
		!encodingProof.success ||
		!outputProof.success ||
		encodingProof.data[0].organizationId !== run.organizationId ||
		outputProof.data[0].organizationId !== run.organizationId ||
		encodingProof.data[0].response.id !== encodingId.data ||
		outputProof.data[0].response.id !== output.resourceId ||
		encodingProof.data[0].bitmovinAccountId !==
			outputProof.data[0].bitmovinAccountId
	)
		throw new MoqObservationError(409, "MOQ_HISTORY_PROVENANCE_UNAVAILABLE");
	const outputConfiguration = z.object({
		trackNamespace: z.array(z.string().min(1).max(1_024)).min(1).max(32),
		draftVersion: z.enum(["DRAFT_16", "DRAFT_18"]),
	});
	const storedConfiguration = outputConfiguration.safeParse(output.payload),
		originalConfiguration = outputConfiguration.safeParse(
			outputProof.data[0].request,
		);
	const configuration =
		storedConfiguration.success &&
		originalConfiguration.success &&
		storedConfiguration.data.draftVersion ===
			originalConfiguration.data.draftVersion &&
		JSON.stringify(storedConfiguration.data.trackNamespace) ===
			JSON.stringify(originalConfiguration.data.trackNamespace)
			? {
					namespace: originalConfiguration.data.trackNamespace,
					draftVersion:
						originalConfiguration.data.draftVersion === "DRAFT_18"
							? (18 as const)
							: (16 as const),
					catalogTrackName: "catalog" as const,
				}
			: undefined;
	return {
		...run,
		...(configuration ? { configuration } : {}),
		bitmovinEncodingId: encodingId.data,
		originalBitmovinAccountId: encodingProof.data[0].bitmovinAccountId,
	};
}
export async function assertMoqObservationWritable(
	ctx: ServerContext,
	params: MoqObservationParams,
	run: Awaited<ReturnType<typeof readMoqObservationRun>>,
	session: StoredMoqObservationSession | undefined,
	prisma: AppPrismaClient | AppTransactionClient = ctx.prisma,
) {
	const now = Date.now();
	if (session) {
		if (session.actor !== ctx.tenant?.actor)
			throw new MoqObservationError(403, "MOQ_HISTORY_SESSION_OWNER");
		if (
			now - Date.parse(session.createdAt) >
			MOQ_OBSERVATION_LIMITS.durationMs + MOQ_OBSERVATION_LIMITS.flushMs
		)
			throw new MoqObservationError(409, "MOQ_HISTORY_FLUSH_EXPIRED");
		if (
			run.status !== "RUNNING" &&
			(!run.endedAt ||
				now - run.endedAt.getTime() > MOQ_OBSERVATION_LIMITS.flushMs)
		)
			throw new MoqObservationError(409, "MOQ_HISTORY_FLUSH_EXPIRED");
		return;
	}
	const [channel, latest] = await Promise.all([
		prisma.liveChannel.findUnique({
			where: { id: params.id },
			select: {
				id: true,
				organizationId: true,
				status: true,
				bitmovinEncodingId: true,
			},
		}),
		prisma.liveChannelRun.findFirst({
			where: { liveChannelId: params.id },
			orderBy: { seq: "desc" },
			select: { id: true },
		}),
	]);
	if (
		run.status !== "RUNNING" ||
		!channel ||
		channel.organizationId !== ctx.tenant?.organizationId ||
		channel.status !== "RUNNING" ||
		channel.bitmovinEncodingId !== run.bitmovinEncodingId ||
		latest?.id !== run.id
	)
		throw new MoqObservationError(409, "MOQ_HISTORY_NEW_SESSION_REQUIRES_LIVE");
}
export async function readMoqBoundedBody(
	req: Request,
	limit: number,
	timeoutMs = MOQ_ARCHIVE_BODY_TIMEOUT_MS,
): Promise<Buffer> {
	const length = req.headers.get("content-length");
	if (
		length !== null &&
		(!/^\d+$/.test(length) ||
			!Number.isSafeInteger(Number(length)) ||
			Number(length) > limit)
	)
		throw new MoqObservationError(413, "MOQ_HISTORY_BODY_TOO_LARGE");
	if (!req.body)
		throw new MoqObservationError(400, "MOQ_HISTORY_INVALID_REQUEST");
	const reader = req.body.getReader(),
		chunks: Uint8Array[] = [];
	let size = 0;
	let complete = false,
		expired = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => {
			expired = true;
			reject(new MoqObservationError(408, "MOQ_HISTORY_BODY_TIMEOUT"));
		}, timeoutMs);
	});
	const read = async () => {
		while (true) {
			const result = await reader.read();
			if (expired)
				throw new MoqObservationError(408, "MOQ_HISTORY_BODY_TIMEOUT");
			if (result.done) {
				complete = true;
				if (length !== null && size !== Number(length))
					throw new MoqObservationError(400, "MOQ_HISTORY_INVALID_REQUEST");
				break;
			}
			size += result.value.byteLength;
			if (size > limit) {
				throw new MoqObservationError(413, "MOQ_HISTORY_BODY_TOO_LARGE");
			}
			chunks.push(result.value);
		}
		return Buffer.concat(chunks, size);
	};
	try {
		return await Promise.race([read(), deadline]);
	} finally {
		clearTimeout(timer);
		// Cancellation is best-effort and must not extend the aggregate deadline.
		if (!complete) void reader.cancel().catch(() => {});
		try {
			reader.releaseLock();
		} catch {
			/* An underlying pending read may still be settling. */
		}
	}
}
export function moqHistoryError(error: unknown) {
	if (error instanceof AuthContextError)
		return Response.json(
			{
				error: "MoQ history is unavailable",
				details: { code: "MOQ_HISTORY_AUTH_REQUIRED" },
			},
			{
				status: error.status,
				headers: { "Cache-Control": "private, no-store" },
			},
		);
	const safe =
		error instanceof MoqObservationError
			? error
			: new MoqObservationError(503, "MOQ_HISTORY_UNAVAILABLE");
	return Response.json(
		{ error: "MoQ history is unavailable", details: { code: safe.code } },
		{ status: safe.status, headers: { "Cache-Control": "private, no-store" } },
	);
}
export async function auditMoqHistory(
	ctx: ServerContext,
	req: Request,
	params: MoqObservationParams,
	statusCode: number,
) {
	await writeAuditLog(
		ctx,
		{
			method: req.method,
			path: new URL(req.url).pathname,
			statusCode,
			request: {
				runId: params.runId,
				...(params.sessionId ? { sessionId: params.sessionId } : {}),
			},
			response: { runId: params.runId, statusCode },
		},
		req,
	);
}
export async function getMoqObservations(
	req: Request,
	params: MoqObservationParams,
) {
	try {
		const ctx = await moqObservationContext(req, params);
		const run = await readMoqObservationRun(ctx, params);
		const store = parseMoqObservationStore(run.moqObservations);
		const heartbeat = await readMoqHeartbeatHistory(
			ctx.prisma,
			run.id,
			run.bitmovinEncodingId,
		);
		await auditMoqHistory(ctx, req, params, 200);
		return Response.json(
			{
				runId: run.id,
				...(run.configuration ? { configuration: run.configuration } : {}),
				sessions: store.sessions.map(publicMoqSession),
				heartbeat,
			},
			{ headers: { "Cache-Control": "private, no-store" } },
		);
	} catch (error) {
		return moqHistoryError(error);
	}
}
export async function putMoqObservation(
	req: Request,
	params: MoqObservationParams,
) {
	try {
		const ctx = await moqObservationContext(req, params, true);
		if (!params.sessionId || !ctx.tenant?.actor)
			throw new MoqObservationError(400, "MOQ_HISTORY_INVALID_REQUEST");
		let json: unknown;
		try {
			json = JSON.parse(
				(await readMoqBoundedBody(req, 256 * 1024)).toString("utf8"),
			);
		} catch (error) {
			if (error instanceof MoqObservationError) throw error;
			throw new MoqObservationError(400, "MOQ_HISTORY_INVALID_REQUEST");
		}
		const parsed = moqObservationUpdateSchema.safeParse(json);
		if (!parsed.success)
			throw new MoqObservationError(400, "MOQ_HISTORY_INVALID_REQUEST");
		const input = parsed.data;
		const { analyticsLicenseKeySha256: submittedDigest, ...observation } =
			input;
		const analyticsKey = input.analyticsImpressionId
			? (await readPlayerSettings(ctx.prisma)).analyticsLicenseKey
			: "";
		const currentAnalyticsDigest = analyticsKey
			? createHash("sha256").update(analyticsKey).digest("hex")
			: undefined;
		const saved = await ctx.prisma.$transaction(async (tx) => {
			await tx.$queryRaw`SELECT id FROM "LiveChannelRun" WHERE id = ${params.runId}::uuid FOR UPDATE`;
			const run = await readMoqObservationRun(ctx, params, tx);
			const store = parseMoqObservationStore(run.moqObservations);
			const previous = store.sessions.find(
				(session) => session.id === params.sessionId,
			);
			await assertMoqObservationWritable(ctx, params, run, previous, tx);
			if (
				input.analyticsImpressionId &&
				store.sessions.some(
					(session) =>
						session.id !== params.sessionId &&
						session.analyticsImpressionId === input.analyticsImpressionId,
				)
			)
				throw new MoqObservationError(
					409,
					"MOQ_HISTORY_ANALYTICS_IMPRESSION_CONFLICT",
				);
			if (
				input.analyticsImpressionId &&
				(previous?.analyticsImpressionId
					? !previous.analyticsLicenseKeySha256 ||
						previous.analyticsLicenseKeySha256 !== submittedDigest
					: !currentAnalyticsDigest ||
						currentAnalyticsDigest !== submittedDigest)
			)
				throw new MoqObservationError(
					409,
					"MOQ_HISTORY_ANALYTICS_LICENSE_CHANGED",
				);
			if (
				previous &&
				(previous.startedAt !== input.startedAt ||
					(previous.analyticsImpressionId &&
						input.analyticsImpressionId !== undefined &&
						previous.analyticsImpressionId !== input.analyticsImpressionId) ||
					JSON.stringify(input.samples.slice(0, previous.samples.length)) !==
						JSON.stringify(previous.samples) ||
					JSON.stringify(input.events.slice(0, previous.events.length)) !==
						JSON.stringify(previous.events) ||
					(previous.endedAt !== null &&
						(previous.endedAt !== input.endedAt ||
							input.samples.length !== previous.samples.length ||
							input.events.length !== previous.events.length)))
			)
				throw new MoqObservationError(409, "MOQ_HISTORY_SESSION_CONFLICT");
			if (!previous && store.sessions.length >= MOQ_OBSERVATION_LIMITS.sessions)
				throw new MoqObservationError(409, "MOQ_HISTORY_SESSION_LIMIT");
			const now = new Date().toISOString();
			const analyticsImpressionId =
				input.analyticsImpressionId ?? previous?.analyticsImpressionId ?? null;
			const session: StoredMoqObservationSession = {
				...observation,
				id: params.sessionId as string,
				actor: ctx.tenant?.actor as string,
				createdAt: previous?.createdAt ?? now,
				updatedAt: now,
				archive: previous?.archive ?? null,
				analyticsImpressionId,
				...(analyticsImpressionId
					? {
							analyticsVideoId: `bitovp-moq:${run.bitmovinEncodingId}:${run.id}`,
						}
					: {}),
				...(previous?.archiveUploadSha256
					? { archiveUploadSha256: previous.archiveUploadSha256 }
					: {}),
				...(previous?.analyticsLicenseKeySha256
					? { analyticsLicenseKeySha256: previous.analyticsLicenseKeySha256 }
					: !previous?.analyticsImpressionId &&
							analyticsImpressionId &&
							currentAnalyticsDigest
						? {
								analyticsLicenseKeySha256: currentAnalyticsDigest,
							}
						: {}),
			};
			store.sessions = [
				...store.sessions.filter((entry) => entry.id !== session.id),
				session,
			];
			await writeMoqObservationStore(
				tx,
				{ runId: run.id, organizationId: ctx.tenant?.organizationId },
				store,
			);
			return publicMoqSession(session);
		});
		await auditMoqHistory(ctx, req, params, 200);
		return Response.json(
			{ runId: params.runId, session: saved },
			{ headers: { "Cache-Control": "private, no-store" } },
		);
	} catch (error) {
		return moqHistoryError(error);
	}
}

import { MOQ_ARCHIVE_BODY_TIMEOUT_MS } from "../../../config/moq-policy";
