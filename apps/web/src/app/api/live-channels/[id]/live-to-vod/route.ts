import { randomUUID } from "node:crypto";
import {
	deriveLiveToVodStatus,
	type LiveToVodErrorCode,
	type LiveToVodFamilyRecord,
	type LiveToVodRecord,
	liveToVodClaim,
	liveToVodFamilySupport,
	liveToVodParamsSchema,
	masterKeyFromEnv,
	normalizeLiveToVodRecord,
	redactSecrets,
	resolveLiveToVodTarget,
	stepLogSchema,
} from "@bitovp/core";
import { claimLiveToVodAttempt, persistLiveToVodAttempt } from "@bitovp/db";
import { NextResponse } from "next/server";
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

type LiveToVodRequestErrorCode =
	| LiveToVodErrorCode
	| "L2V_NOT_STOPPED"
	| "L2V_NO_ENCODING"
	| "L2V_NO_RUN"
	| "L2V_INVALID_STEP_LOG"
	| "L2V_INVALID_OUTPUT"
	| "L2V_INVALID_PATH"
	| "L2V_UNSUPPORTED_FAMILY"
	| "L2V_ALREADY_RUNNING"
	| "L2V_STATE_CHANGED";

function liveToVodRequestError(
	status: number,
	code: LiveToVodRequestErrorCode,
	error: string,
	details: Record<string, unknown> = {},
) {
	return jsonError(status, error, { code, ...details });
}

type QueueAttempt = {
	id?: string;
	data?: {
		liveChannelId?: string;
		action?: string;
		attemptId?: string;
		liveChannelRunId?: string;
		encodingId?: string;
	};
	getState?: () => Promise<string>;
};

const ACTIVE_QUEUE_STATES = new Set([
	"active",
	"delayed",
	"prioritized",
	"waiting",
	"waiting-children",
]);

function exactQueuedAttempt(
	job: QueueAttempt | undefined,
	args: {
		liveChannelId: string;
		attemptId: string;
		liveChannelRunId: string;
		encodingId: string;
		queueJobId: string;
	},
): boolean {
	return (
		job?.id === args.queueJobId &&
		job.data?.liveChannelId === args.liveChannelId &&
		job.data.action === "live-to-vod" &&
		job.data.attemptId === args.attemptId &&
		job.data.liveChannelRunId === args.liveChannelRunId &&
		job.data.encodingId === args.encodingId
	);
}

function failedRecord(
	claimed: LiveToVodRecord,
	code: LiveToVodErrorCode,
	detail: string,
): LiveToVodRecord {
	const safeDetail = String(redactSecrets(detail));
	const families = (claimed.families ?? []).map(
		(family): LiveToVodFamilyRecord => {
			if (family.status === "PENDING") {
				return {
					type: family.type,
					status: "ERROR" as const,
					errorCode: code,
					technicalDetail: safeDetail,
					...(family.providerIdentity
						? { providerIdentity: family.providerIdentity }
						: {}),
					...(family.createIntent ? { createIntent: family.createIntent } : {}),
				};
			}
			if (family.status === "CREATED" || family.status === "RUNNING") {
				return {
					type: family.type,
					status: "ERROR",
					errorCode: code,
					technicalDetail: safeDetail,
					providerIdentity: family.providerIdentity,
					manifestId: family.manifestId,
				};
			}
			return family;
		},
	);
	return {
		...claimed,
		status: deriveLiveToVodStatus(families),
		errorCode: code,
		technicalDetail: safeDetail,
		families,
	};
}

/**
 * live-to-VOD: turn a STOPPED channel's recording into VOD manifests.
 *
 * Bitmovin has NO live-to-VOD API — the worker generates DEFAULT VOD
 * manifests over the channel's own encoding with `manifestGenerator:
 * LEGACY` (C3's only exception), so this route just gates and enqueues.
 *
 * STOPPED-only: a channel still RUNNING is still writing segments, so a
 * manifest generated now would be truncated the moment it lands.
 *
 * Double-submit safety is an OPTIMISTIC LOCK on the row as read — the
 * claim's WHERE carries `status: "STOPPED"` and the `updatedAt` the route
 * just read, never a filter on the `liveToVod` JSON column (:
 * `{ equals: DB_NULL }` matched nothing in the deployed image on a SQL-NULL
 * column, so every roll 409ed). Live-to-VOD stays orthogonal to the channel
 * lifecycle — a failed generation must never mark the channel ERROR — and a
 * second concurrent submit, or any other write to the row in between (each
 * bumps `@updatedAt`, so the lock is row-wide, not field-scoped; that is
 * the safe direction: a spurious 409 the operator retries), matches zero
 * rows and 409s. The `RUNNING` precheck on an existing record still refuses
 * a roll over one in progress; a terminal record may be rolled again. The
 * worker is the only writer of the record's later states.
 */
export async function POST(req: Request, { params }: RouteParams) {
	const { id } = await params;
	const invalid = invalidIdResponse(id);
	if (invalid) {
		return invalid;
	}
	const parsed = liveToVodParamsSchema.safeParse((await readJson(req)) ?? {});
	if (!parsed.success) {
		return validationError(parsed.error);
	}
	try {
		// Fail fast: the worker must decrypt the account API key.
		masterKeyFromEnv();
		const ctx = await getServerContext();
		const row = await ctx.prisma.liveChannel.findUnique({
			where: { id },
			select: {
				id: true,
				status: true,
				bitmovinEncodingId: true,
				liveToVod: true,
				stepLog: true,
				updatedAt: true,
			},
		});
		if (!row) {
			return jsonError(404, "Not found");
		}
		if (row.status !== "STOPPED") {
			return liveToVodRequestError(
				409,
				"L2V_NOT_STOPPED",
				`live-to-VOD needs a STOPPED channel (status: ${row.status}) — stop it first so the recording is complete`,
			);
		}
		if (!row.bitmovinEncodingId) {
			return liveToVodRequestError(
				409,
				"L2V_NO_ENCODING",
				"Channel has no Bitmovin encoding to publish",
			);
		}
		const run = await ctx.prisma.liveChannelRun.findUnique({
			where: { bitmovinEncodingId: row.bitmovinEncodingId },
			select: { id: true, liveChannelId: true },
		});
		if (!run || run.liveChannelId !== id) {
			return liveToVodRequestError(
				409,
				"L2V_NO_RUN",
				"Channel has no exact run row for this recording; re-provision before publishing",
			);
		}
		// C35 : an explicit manifest path that is not a parent of the
		// recording's muxing paths can ONLY end in Bitmovin's `code 2701`. The
		// worker refuses it too — it is the single writer and holds the rule —
		// but a refusal there costs a claimed record, a queued job and its
		// retries before the operator learns they typed a sibling directory.
		// Same function, same step log, so the two answers cannot disagree.
		const entries = stepLogSchema.safeParse(row.stepLog);
		if (!entries.success) {
			// Not a silent pass-through (review-357 suggestion 4). Without a
			// readable step log there are no muxing paths, so NEITHER the check
			// below nor the worker's own derivation can run — claiming the record
			// and enqueueing would buy the operator a generic job failure minutes
			// later instead of the reason now.
			return liveToVodRequestError(
				400,
				"L2V_INVALID_STEP_LOG",
				"Channel step log is unreadable — live-to-VOD cannot work out where the recording was written; re-provision the channel",
			);
		}
		const outputKey =
			parsed.data.outputKey ??
			entries.data
				.find(
					(entry) =>
						entry.step.startsWith("output:") && entry.status === "DONE",
				)
				?.step.slice("output:".length);
		if (!outputKey) {
			return liveToVodRequestError(
				400,
				"L2V_INVALID_OUTPUT",
				"Channel step log carries no provisioned output; re-provision the channel",
			);
		}
		// Unconditional since : the DERIVED default can be unusable
		// too (a step log with no muxing entry), and that refusal belongs here
		// for the same reason the explicit one does.
		const target = resolveLiveToVodTarget(entries.data, parsed.data.path);
		if (!target.ok) {
			return liveToVodRequestError(400, "L2V_INVALID_PATH", target.reason);
		}
		// WHICH families is a property of
		// the recording. A DASH default manifest enumerates fMP4 muxings only, so
		// over a segmented-TS recording the provider refuses it (400 / code 2700)
		// — and the old default of "both" turned every TS-only roll's delivered
		// HLS into a whole-record ERROR. The default is now the supported set,
		// and an EXPLICIT family the recording cannot carry is refused with 422
		// here — before the claim, the queue and any provider call — with the
		// reason the worker would give (same function, same step log).
		const support = liveToVodFamilySupport(entries.data);
		const explicit = parsed.data.manifests !== undefined;
		const requested = parsed.data.manifests ?? support.supported;
		const refused = support.unsupported.find((u) =>
			requested.includes(u.family),
		);
		if (refused) {
			return liveToVodRequestError(
				422,
				"L2V_UNSUPPORTED_FAMILY",
				refused.reason,
				{
					supported: support.supported,
				},
			);
		}
		if (requested.length === 0) {
			// : a DERIVED default with nothing in it — the worker refuses
			// the same shape ("No manifest family is compatible"); say why here,
			// before the claim and the queue.
			return liveToVodRequestError(
				422,
				"L2V_UNSUPPORTED_FAMILY",
				support.unsupported[0]?.reason ??
					"No manifest family is compatible with this recording's muxings",
				{ supported: [] },
			);
		}
		const existing = normalizeLiveToVodRecord(row.liveToVod);
		if (existing?.errorCode === "L2V_RECORD_INVALID") {
			return liveToVodRequestError(
				409,
				"L2V_RECORD_INVALID",
				"The previous live-to-VOD record has an unresolved provider identity; an administrator must reconcile it before another publish",
			);
		}
		// A provider failure settles the family snapshot before this BullMQ
		// delivery rejects, but BullMQ may already have queued the SAME job for an
		// automatic retry. That queued exact attempt still owns the claim even
		// though the customer-facing outcome currently derives ERROR/PARTIAL.
		// Reconcile every identified non-successful attempt before minting a new
		// one; otherwise a click during backoff can race two provider creates.
		if (
			existing &&
			(existing.status === "RUNNING" ||
				existing.status === "ERROR" ||
				existing.status === "PARTIAL") &&
			existing.attemptId &&
			existing.queueJobId &&
			existing.liveChannelRunId &&
			existing.revision !== undefined
		) {
			const queue = getLiveChannelQueue();
			let job: QueueAttempt | undefined;
			try {
				job = (await queue.getJob(existing.queueJobId)) as
					| QueueAttempt
					| undefined;
			} catch {
				return liveToVodRequestError(
					503,
					"L2V_QUEUE_STATE_UNKNOWN",
					"The queue could not confirm the existing live-to-VOD request; retry after status refresh",
					{ attemptId: existing.attemptId },
				);
			}
			if (
				exactQueuedAttempt(job, {
					liveChannelId: id,
					attemptId: existing.attemptId,
					liveChannelRunId: existing.liveChannelRunId,
					encodingId: row.bitmovinEncodingId,
					queueJobId: existing.queueJobId,
				})
			) {
				let state: string;
				try {
					state = job?.getState ? await job.getState() : "unknown";
				} catch {
					state = "unknown";
				}
				if (
					state !== "failed" &&
					state !== "completed" &&
					!ACTIVE_QUEUE_STATES.has(state)
				) {
					return liveToVodRequestError(
						503,
						"L2V_QUEUE_STATE_UNKNOWN",
						"The queue could not resolve the exact live-to-VOD job state; do not resubmit until status refresh",
						{ attemptId: existing.attemptId },
					);
				}
				if (ACTIVE_QUEUE_STATES.has(state)) {
					return NextResponse.json({
						id,
						action: "live-to-vod",
						status: "RUNNING",
						attemptId: existing.attemptId,
						liveChannelRunId: existing.liveChannelRunId,
						reconciled: true,
					});
				}
			} else if (job !== undefined) {
				return liveToVodRequestError(
					503,
					"L2V_QUEUE_STATE_UNKNOWN",
					"The queue id is occupied by a different live-to-VOD identity; do not resubmit until an operator resolves it",
					{ attemptId: existing.attemptId },
				);
			}
			if (existing.status === "RUNNING") {
				const released = failedRecord(
					existing,
					"L2V_JOB_DIED",
					"The exact queue job is absent or settled while its record is still RUNNING",
				);
				await persistLiveToVodAttempt(ctx.prisma, {
					liveChannelId: id,
					liveChannelRunId: existing.liveChannelRunId,
					encodingId: row.bitmovinEncodingId,
					attemptId: existing.attemptId,
					expectedRevision: existing.revision,
					record: released,
				});
			}
		}
		if (existing?.status === "RUNNING") {
			return liveToVodRequestError(
				409,
				"L2V_ALREADY_RUNNING",
				"A live-to-VOD run is already in progress",
			);
		}
		// A fresh roll claims RUNNING with the planned families PENDING; a RETRY
		// over a PARTIAL/ERROR record carries its families forward so the worker
		// re-runs only the failed ones and keeps every finished manifest's id
		// (§14.6 LF-02 item 5) — the worker verifies the destination matches
		// before treating them as its own.
		const attemptId = randomUUID();
		const queueJobId = `${id}-live-to-vod-${attemptId}`;
		const claimed = liveToVodClaim({
			existing,
			requested,
			explicit,
			support,
			requestedAt: new Date().toISOString(),
			attemptId,
			queueJobId,
			liveChannelRunId: run.id,
			outputKey,
		});
		// The claim: only the row exactly as it was READ wins, so two concurrent
		// submits cannot both enqueue. The lock is `updatedAt` (bumped by every
		// write, @updatedAt), NOT a filter on the Json column: the first cut
		// filtered `liveToVod: { equals: DB_NULL }` and matched NOTHING in the
		// deployed web image although the column was a SQL NULL — the paid run
		// reaudit-C  got 409 "state changed" on every
		// STOPPED channel, and the same predicate from a plain process matched.
		// A Json-null sentinel filter is a bundling hazard; a timestamp is not.
		const won = await claimLiveToVodAttempt(ctx.prisma, {
			liveChannelId: id,
			liveChannelRunId: run.id,
			encodingId: row.bitmovinEncodingId,
			attemptId,
			updatedAt: row.updatedAt,
			record: claimed,
		});
		if (!won) {
			return liveToVodRequestError(
				409,
				"L2V_STATE_CHANGED",
				"Channel state changed — refresh and retry",
			);
		}
		const queue = getLiveChannelQueue();
		const queueData = {
			liveChannelId: id,
			action: "live-to-vod" as const,
			params: parsed.data,
			attemptId,
			liveChannelRunId: run.id,
			encodingId: row.bitmovinEncodingId,
		};
		try {
			await queue.add("live-channel", queueData, {
				jobId: queueJobId,
				attempts: 5,
				backoff: { type: "exponential", delay: 5_000 },
				removeOnComplete: 1000,
				removeOnFail: 1000,
			});
		} catch (enqueueErr) {
			// `queue.add` may have committed and only lost its response. Reconcile
			// the deterministic id before releasing the claim; creating a second
			// attempt here would allow two provider creates.
			let found: QueueAttempt | undefined;
			try {
				found = (await queue.getJob(queueJobId)) as QueueAttempt | undefined;
			} catch {
				return liveToVodRequestError(
					503,
					"L2V_QUEUE_STATE_UNKNOWN",
					"The queue response was lost and its state could not be confirmed; do not resubmit until status refresh",
					{ attemptId },
				);
			}
			if (
				exactQueuedAttempt(found, {
					liveChannelId: id,
					attemptId,
					liveChannelRunId: run.id,
					encodingId: row.bitmovinEncodingId,
					queueJobId,
				})
			) {
				return NextResponse.json({
					id,
					action: "live-to-vod",
					status: "RUNNING",
					attemptId,
					liveChannelRunId: run.id,
					reconciled: true,
				});
			}
			if (found !== undefined) {
				// The deterministic id exists, but it does not carry this exact
				// attempt/run/encoding tuple. That job may still execute. Releasing
				// the DB claim here would authorize another attempt concurrently.
				return liveToVodRequestError(
					503,
					"L2V_QUEUE_STATE_UNKNOWN",
					"The queue id is occupied by a different live-to-VOD identity; do not resubmit until an operator resolves it",
					{ attemptId },
				);
			}
			const released = failedRecord(
				claimed,
				"L2V_ENQUEUE_FAILED",
				enqueueErr instanceof Error ? enqueueErr.message : String(enqueueErr),
			);
			await persistLiveToVodAttempt(ctx.prisma, {
				liveChannelId: id,
				liveChannelRunId: run.id,
				encodingId: row.bitmovinEncodingId,
				attemptId,
				expectedRevision: 0,
				record: released,
			});
			console.error(
				"[live-to-vod] enqueue failed:",
				String(
					redactSecrets(
						enqueueErr instanceof Error
							? enqueueErr.message
							: String(enqueueErr),
					),
				),
			);
			return liveToVodRequestError(
				503,
				"L2V_ENQUEUE_FAILED",
				"The live-to-VOD request could not be queued",
			);
		}
		return NextResponse.json({
			id,
			action: "live-to-vod",
			status: "RUNNING",
			attemptId,
			liveChannelRunId: run.id,
		});
	} catch (err) {
		return routeError(err);
	}
}
