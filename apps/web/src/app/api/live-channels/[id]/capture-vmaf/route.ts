import {
	DEFAULT_VMAF_MODEL,
	effectiveLivePlanForRun,
	enumerateLiveCaptureTargets,
	liveChannelPlanSchema,
	masterKeyFromEnv,
	VMAF_SCORING_VERSION,
	vmafModelNameSchema,
	vmafSourceFor,
} from "@bitovp/core";
import type { Prisma } from "@bitovp/db";
import { NextResponse } from "next/server";
import { z } from "zod";
import { customerErrorDetails } from "@/lib/customer-error";
import { getServerContext } from "@/lib/server/context";
import { requireQcVmafEnabled } from "@/lib/server/feature-flags";
import {
	invalidIdResponse,
	jsonError,
	readJson,
	routeError,
	validationError,
} from "@/lib/server/http";
import {
	checkLiveCaptureReadiness,
	LIVE_CAPTURE_READ_TIMEOUT_MS,
} from "@/lib/server/live-capture-readiness";
import { getVmafQueue } from "@/lib/server/queue";
import { browserForCredentialId } from "@/lib/server/storage";

type RouteParams = { params: Promise<{ id: string }> };
const channelSelect = {
	id: true,
	status: true,
	plan: true,
	bitmovinEncodingId: true,
} as const;
const runSelect = {
	id: true,
	seq: true,
	status: true,
	bitmovinEncodingId: true,
	outputPrefix: true,
	createdAt: true,
} as const;
const unobservable = () =>
	jsonError(
		409,
		"Capture readiness could not be verified. Check output settings and read access, then try again.",
		customerErrorDetails("LIVE_VMAF_READINESS_UNOBSERVABLE"),
	);

/**
 * "Capture VMAF" on a pseudo-live channel (P4-PR6b). Creates a LIVE VmafJob
 * whose params name the channel + a capture window, then enqueues it on the
 * vmaf-runner queue (the worker dispatches LIVE → the live VMAF processor).
 *
 * Gated to RUNNING channels that have an attached feeder session — the live
 * VMAF capture needs the looping feeder source as the reference, so a real
 * external feed (no known source) cannot be scored this way. The window is
 * the recent-segment span to align (default 120s).
 */
const bodySchema = z.object({
	/** Recent-output capture window in seconds (the DVR tail to score). */
	windowSeconds: z.coerce.number().int().min(10).max(600).default(120),
	/** libvmaf model (filename-safe charset; see vmafModelNameSchema). */
	model: vmafModelNameSchema.default(DEFAULT_VMAF_MODEL),
});

export async function POST(req: Request, { params }: RouteParams) {
	// : OFF means this surface does not exist for the deployment.
	// The recovery pair (qc-override, qc-report) is deliberately NOT gated.
	const disabled = await requireQcVmafEnabled();
	if (disabled) {
		return disabled;
	}
	const { id } = await params;
	const invalid = invalidIdResponse(id);
	if (invalid) {
		return invalid;
	}
	const parsed = bodySchema.safeParse((await readJson(req)) ?? {});
	if (!parsed.success) {
		return validationError(parsed.error);
	}
	const { windowSeconds, model } = parsed.data;
	try {
		// Fail fast: the worker must decrypt the output + source credentials to
		// list/download segments — a broken MASTER_KEY would just wedge the job.
		masterKeyFromEnv();
		const ctx = await getServerContext();
		const channel = await ctx.prisma.liveChannel.findUnique({
			where: { id },
			select: channelSelect,
		});
		if (!channel) {
			return jsonError(404, "Not found");
		}
		if (channel.status !== "RUNNING") {
			return jsonError(
				409,
				`VMAF capture needs a RUNNING channel (status: ${channel.status})`,
				customerErrorDetails("LIVE_VMAF_NOT_RUNNING", {
					status: channel.status,
				}),
			);
		}
		// (d): the worker's capture throws when the target output
		// cannot be read back — but only AFTER the job is queued and the
		// operator has walked away. Refuse HERE, so the channel learns at the
		// click rather than from a failed job.
		//
		// The predicate was `kind !== "S3"`, mirrored from the worker, and the
		// worker's own message said "S3-family" while its check said S3.
		// Akamai Object Storage is
		// GENERIC_S3 (C10), so an AOS channel could not be measured at all —
		// while the capture primitive it would have used lists through a
		// provider-agnostic browser and explicitly handles S3-compatible
		// stores. Both sites now ask the same shared rule, which is the point:
		// this rail exists to say what the worker will say, and it can only do
		// that if it is the same sentence.
		const parsedPlan = liveChannelPlanSchema.safeParse(channel.plan);
		if (!parsedPlan.success) return unobservable();
		if (parsedPlan.success) {
			// EVERY target, not just the first (review of #190).
			//
			// `enumerateLiveCaptureTargets` returns one per VIDEO rendition and
			// each carries its own `destination.outputKey`; the worker scores all
			// of them. Inspecting `[0]` made this rail the same SENTENCE as the
			// worker over a different POPULATION — a plan whose first rendition
			// lands on readable storage and whose second lands on MSL returned
			// 201 here and threw there, which is exactly the walked-away failure
			// (d) exists to prevent.
			for (const target of enumerateLiveCaptureTargets(parsedPlan.data)) {
				const output = parsedPlan.data.outputs.find(
					(o) => o.key === target.outputKey,
				);
				if (!output) {
					continue;
				}
				const source = vmafSourceFor(output);
				if (!source.streamable) {
					return jsonError(
						409,
						`live VMAF capture cannot use output "${output.key}" (${output.kind}) for rendition "${target.renditionKey}": ${source.reason}`,
						customerErrorDetails("LIVE_VMAF_OUTPUT_UNREADABLE", {
							output: output.key,
							rendition: target.renditionKey,
						}),
					);
				}
			}
		}
		// Pseudo-live only: the capture aligns the looping feeder source. Require
		// at least one feeder session that has (or had) a source on this channel.
		const feeder = await ctx.prisma.feederSession.findFirst({
			where: {
				liveChannelId: id,
				status: { in: ["PUSHING", "DOWNLOADING", "STOPPED"] },
			},
			select: { id: true },
		});
		if (!feeder) {
			return jsonError(
				409,
				"VMAF capture needs an attached pseudo-live feeder (the looping source is the reference) — this channel has none",
				customerErrorDetails("LIVE_VMAF_FEEDER_REQUIRED"),
			);
		}

		// Pin the exact running generation before any storage I/O.
		const currentRun = await ctx.prisma.liveChannelRun.findFirst({
			where: { liveChannelId: id },
			orderBy: { seq: "desc" },
			select: runSelect,
		});

		if (
			currentRun?.status !== "RUNNING" ||
			!currentRun.bitmovinEncodingId ||
			currentRun.bitmovinEncodingId !== channel.bitmovinEncodingId
		)
			return unobservable();
		const effectivePlan = effectiveLivePlanForRun(parsedPlan.data, currentRun);
		if (!effectivePlan) return unobservable();
		// #253: the HLS observer's sticky, any-rendition publish flag is not
		// capture readiness. Inspect the worker's actual TS/fMP4 targets instead.
		const readiness = await checkLiveCaptureReadiness(
			effectivePlan,
			currentRun.createdAt,
			(credentialId) =>
				browserForCredentialId(ctx, credentialId, undefined, {
					readTimeoutMs: LIVE_CAPTURE_READ_TIMEOUT_MS,
				}),
		);
		if (readiness.kind === "unobservable") return unobservable();
		if (readiness.kind === "awaiting") {
			return jsonError(
				409,
				"Not every capture target has current-run segments yet. Check the input and output, wait briefly, then capture again.",
				customerErrorDetails("LIVE_VMAF_FIRST_SEGMENT_PENDING"),
			);
		}
		const job = await ctx.prisma.$transaction(async (tx) => {
			// Existing writers use both channel → run (Start) and run → channel
			// (terminal reconcile). Never wait while holding either row: a busy
			// exact identity is a retryable refusal, not readiness. Returning null
			// ends this read-only transaction and releases any acquired lock.
			const channels = await tx.$queryRaw<
				{ id: string }[]
			>`SELECT "id" FROM "LiveChannel" WHERE "id" = ${id}::uuid FOR UPDATE SKIP LOCKED`;
			if (channels.length !== 1) return null;
			const runs = await tx.$queryRaw<
				{ id: string }[]
			>`SELECT "id" FROM "LiveChannelRun" WHERE "id" = ${currentRun.id}::uuid FOR UPDATE SKIP LOCKED`;
			if (runs.length !== 1) return null;
			const latestChannel = await tx.liveChannel.findUnique({
				where: { id },
				select: channelSelect,
			});
			const latestRun = await tx.liveChannelRun.findFirst({
				where: { liveChannelId: id },
				orderBy: { seq: "desc" },
				select: runSelect,
			});
			if (
				Date.now() >= readiness.expiresAt ||
				JSON.stringify(latestChannel) !== JSON.stringify(channel) ||
				JSON.stringify(latestRun) !== JSON.stringify(currentRun)
			)
				return null;
			return tx.vmafJob.create({
				data: {
					mode: "LIVE",
					model,
					// Explicit, not the column default: the default is 1 so the migration
					// labels historical rows correctly, which means a new row relying on
					// it would claim to be pre-fix.
					scoringVersion: VMAF_SCORING_VERSION,
					status: "PENDING",
					params: {
						liveChannelId: id,
						windowSeconds,
						liveChannelRunId: currentRun.id,
					} as Prisma.InputJsonValue,
				},
				select: { id: true },
			});
		});
		if (!job) return unobservable();
		try {
			// jobId = vmafJobId dedupes any retry/redelivery at the queue.
			await getVmafQueue().add(
				"vmaf",
				{ vmafJobId: job.id },
				{ jobId: job.id, removeOnComplete: 1000, removeOnFail: 1000 },
			);
		} catch (enqueueErr) {
			await ctx.prisma.vmafJob.update({
				where: { id: job.id },
				data: { status: "ERROR", error: "Enqueue failed — capture again" },
			});
			throw enqueueErr;
		}
		return NextResponse.json(
			{ id: job.id, mode: "LIVE", status: "PENDING", windowSeconds },
			{ status: 201 },
		);
	} catch (err) {
		return routeError(err);
	}
}
