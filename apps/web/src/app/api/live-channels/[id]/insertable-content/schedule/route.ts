import { createHash, randomUUID } from "node:crypto";
import { ScheduledInsertableContent } from "@bitmovin/api-sdk";
import { redactSecrets } from "@bitovp/core";
import {
	appendLiveEffectStepLogEntry,
	assertLiveEffectCurrent,
	beginLiveEffect,
	markLiveEffectAcked,
	markLiveEffectAmbiguous,
	markLiveEffectFailed,
} from "@bitovp/db";
import { NextResponse } from "next/server";
import { z } from "zod";
import { customerErrorDetails } from "@/lib/customer-error";
import {
	sanitizeScheduledContent,
	scheduleContentCreateSchema,
} from "@/lib/live-runtime/schemas";
import { auditedBitmovinCall } from "@/lib/server/bitmovin";
import { getServerContext } from "@/lib/server/context";
import {
	invalidIdResponse,
	jsonError,
	readJson,
	routeError,
	validationError,
} from "@/lib/server/http";
import { resolveLiveEncoding } from "@/lib/server/live-channel-encoding";

type RouteParams = { params: Promise<{ id: string }> };

const bodySchema = z.strictObject({
	bitmovinAccountId: z.uuid(),
	requestId: z.uuid(),
	schedule: scheduleContentCreateSchema,
});

/**
 * POST /api/live-channels/[id]/insertable-content/schedule — play a piece of
 * READY content instead of the live feed.
 *
 * `runAt` absent ⇒ as soon as possible. `durationInSeconds` is REQUIRED by
 * Bitmovin for image content (an image has no intrinsic duration) and optional
 * for movie files, where it truncates a longer file and loops a shorter one; we
 * cannot tell image from movie from the ids alone, so the requirement is surfaced
 * as UI copy and Bitmovin's 422 passes through.
 */
export async function POST(req: Request, { params }: RouteParams) {
	const { id } = await params;
	const invalid = invalidIdResponse(id);
	if (invalid) {
		return invalid;
	}
	const parsed = bodySchema.safeParse(await readJson(req));
	if (!parsed.success) {
		return validationError(parsed.error);
	}
	const { bitmovinAccountId, requestId, schedule } = parsed.data;
	const requestSha256 = createHash("sha256")
		.update(
			JSON.stringify({
				bitmovinAccountId,
				contentId: schedule.contentId,
				runAt: schedule.runAt ?? null,
				durationInSeconds: schedule.durationInSeconds ?? null,
			}),
		)
		.digest("hex");
	// Compatibility for claims created before the account identity became part
	// of the digest. A legacy digest is accepted only after the replay path also
	// proves the request account is still the channel's current account, plus the
	// exact current run/provider/action identity below.
	const legacyRequestSha256 = createHash("sha256")
		.update(
			JSON.stringify({
				contentId: schedule.contentId,
				runAt: schedule.runAt ?? null,
				durationInSeconds: schedule.durationInSeconds ?? null,
			}),
		)
		.digest("hex");
	const idempotencyKey = `manual:slate-insert:${id}:${requestId}`;
	try {
		const ctx = await getServerContext();
		const existing = await ctx.prisma.liveEffectClaim.findUnique({
			where: { idempotencyKey },
			select: {
				requestSha256: true,
				liveChannelRunId: true,
				providerEncodingId: true,
				action: true,
				state: true,
				providerResultId: true,
			},
		});
		if (
			existing &&
			existing.requestSha256 !== requestSha256 &&
			existing.requestSha256 !== legacyRequestSha256
		) {
			return jsonError(
				409,
				"This request ID is already bound to a different content insertion",
				customerErrorDetails("CONTENT_REQUEST_CONFLICT"),
			);
		}
		const claimRequestSha256 =
			existing?.requestSha256 === legacyRequestSha256
				? legacyRequestSha256
				: requestSha256;
		if (existing) {
			const [replayChannel, replayRun] = await Promise.all([
				ctx.prisma.liveChannel.findUnique({
					where: { id },
					select: { bitmovinAccountId: true, bitmovinEncodingId: true },
				}),
				ctx.prisma.liveChannelRun.findFirst({
					where: { liveChannelId: id },
					orderBy: { seq: "desc" },
					select: { id: true, bitmovinEncodingId: true },
				}),
			]);
			const replayEncodingId =
				replayRun?.bitmovinEncodingId ?? replayChannel?.bitmovinEncodingId;
			if (
				replayChannel?.bitmovinAccountId !== bitmovinAccountId ||
				existing.liveChannelRunId !== replayRun?.id ||
				existing.providerEncodingId !== replayEncodingId ||
				existing.action !== "SLATE_INSERT"
			) {
				return jsonError(
					409,
					"This request ID is already bound to a different content insertion",
					customerErrorDetails("CONTENT_REQUEST_CONFLICT"),
				);
			}
			if (existing.state === "ACKED") {
				return NextResponse.json({
					...(existing.providerResultId
						? { id: existing.providerResultId }
						: {}),
					requestId,
					acknowledged: true,
					idempotentReplay: true,
				});
			}
		}
		const resolved = await resolveLiveEncoding({
			ctx,
			channelId: id,
			bitmovinAccountId,
			requireRunning: true,
			// review-228 I6: the #95 fix gated the SCHEDULED slate path on a
			// proven-connected ingest; this manual path could still insert at
			// Ingest waiting: a 200 response does not prove content rendered; the incident through
			// the other door.
			requireIngestConnected: true,
			subject: "Scheduling insertable content",
		});
		if (!resolved.ok) {
			return resolved.response;
		}
		const { api, encodingId } = resolved;
		const [channel, currentRun] = await Promise.all([
			ctx.prisma.liveChannel.findUnique({
				where: { id },
				select: {
					status: true,
					bitmovinEncodingId: true,
					liveEffectFenceVersion: true,
				},
			}),
			ctx.prisma.liveChannelRun.findFirst({
				where: { liveChannelId: id },
				orderBy: { seq: "desc" },
				select: { id: true, bitmovinEncodingId: true },
			}),
		]);
		if (
			channel?.status !== "RUNNING" ||
			!currentRun ||
			(currentRun.bitmovinEncodingId ?? channel.bitmovinEncodingId) !==
				encodingId
		) {
			return jsonError(
				409,
				"Scheduling insertable content was refused because the current run or provider encoding changed",
				customerErrorDetails("CONTENT_STATE_CHANGED"),
			);
		}
		const now = new Date();
		const begun = await beginLiveEffect(ctx.prisma, {
			idempotencyKey,
			requestSha256: claimRequestSha256,
			liveChannelId: id,
			liveChannelRunId: currentRun.id,
			providerEncodingId: encodingId,
			expectedFenceVersion: channel.liveEffectFenceVersion,
			action: "SLATE_INSERT",
			targetId: schedule.contentId,
			ownerId: `web:${randomUUID()}`,
			now,
			expiresAt: new Date(now.getTime() + 2 * 60_000),
			allowedChannelStatuses: ["RUNNING"],
		});
		if (begun.kind === "ACKED") {
			return NextResponse.json({
				...(begun.providerResultId ? { id: begun.providerResultId } : {}),
				requestId,
				acknowledged: true,
				idempotentReplay: true,
			});
		}
		if (begun.kind !== "EXECUTE") {
			return jsonError(
				409,
				begun.reason,
				customerErrorDetails("CONTENT_REQUEST_BLOCKED"),
			);
		}
		let crossedSendBoundary = false;
		let failedBeforeSend = false;
		const outcome = await auditedBitmovinCall({
			req,
			ctx,
			bitmovinAccountId,
			method: "POST",
			path: `/encoding/encodings/${encodingId}/live/insertable-content/${schedule.contentId}/schedule`,
			request: schedule,
			call: async () => {
				if (
					!(await assertLiveEffectCurrent(ctx.prisma, begun.claim, new Date()))
				) {
					await markLiveEffectFailed(
						ctx.prisma,
						begun.claim,
						"manual slate insert lost its run/generation fence before send",
					);
					failedBeforeSend = true;
					throw new Error("LIVE_EFFECT_STALE_BEFORE_SEND");
				}
				crossedSendBoundary = true;
				return api.encoding.encodings.live.insertableContent.schedule.create(
					encodingId,
					schedule.contentId,
					new ScheduledInsertableContent({
						...(schedule.runAt ? { runAt: new Date(schedule.runAt) } : {}),
						...(schedule.durationInSeconds !== undefined
							? { durationInSeconds: schedule.durationInSeconds }
							: {}),
					}),
				);
			},
			responseSnapshot: (result) => sanitizeScheduledContent(result),
		});
		if (!outcome.ok) {
			if (crossedSendBoundary) {
				await markLiveEffectAmbiguous(
					ctx.prisma,
					begun.claim,
					"manual slate insert crossed the provider send boundary without a confirmed response; inspect provider state before retry",
				);
			} else if (!failedBeforeSend) {
				await markLiveEffectFailed(
					ctx.prisma,
					begun.claim,
					"manual slate insert failed before the provider send boundary",
				);
			}
			return outcome.response;
		}
		const providerResultId =
			typeof (outcome.result as { id?: unknown }).id === "string"
				? (outcome.result as { id: string }).id
				: undefined;
		/* Record every provider insertion before acknowledging it. Otherwise the slate guard can mistake an unrecorded insertion for a lost response and skip a later scheduled insertion. Bind the record to the claimed run; only its current DISPATCHING claim may update the channel, including when a response arrives after stop or restart. */
		const insertedAt = new Date().toISOString();
		try {
			const persisted = await appendLiveEffectStepLogEntry(
				ctx.prisma,
				begun.claim,
				redactSecrets({
					step: `slate:${insertedAt}`,
					kind: "SLATE_INSERTED",
					payload: {
						at: insertedAt,
						insertableContentId: schedule.contentId,
						...(schedule.durationInSeconds !== undefined
							? { durationSeconds: schedule.durationInSeconds }
							: {}),
						// Provenance: this insertion came through the direct route,
						// not the scheduler, so it has no schedule row to name.
						viaDirectRoute: true,
						/* Persist the provider entry ID. The guard matches insertion identity, so a record without an ID cannot account for this insertion and can incorrectly suppress the next one. */
						...(typeof (outcome.result as { id?: unknown }).id === "string"
							? {
									providerEntryId: (outcome.result as { id: string }).id,
								}
							: {}),
					},
					refs: { encodingId },
					status: "DONE",
					startedAt: insertedAt,
					finishedAt: insertedAt,
				}),
			);
			if (persisted.runUpdated !== 1) {
				console.error(
					`[live-channel] ${id}: insertable content ${schedule.contentId} was scheduled but could not be bound to claimed run ${begun.claim.liveChannelRunId}`,
				);
			}
		} catch (err) {
			// The insertion HAS landed; failing the request would invite a retry
			// of a call that already succeeded. But a lost record means the
			// worker's guard can no longer account for this insertion, so it is
			// loud rather than swallowed.
			console.error(
				`[live-channel] ${id}: insertable content ${schedule.contentId} was scheduled but its step-log record could not be written — a scheduled slate for the same content may be wrongly skipped:`,
				err instanceof Error ? err.message : err,
			);
		}
		await markLiveEffectAcked(ctx.prisma, begun.claim, new Date(), {
			...(providerResultId ? { providerResultId } : {}),
		});
		return NextResponse.json(
			{
				...sanitizeScheduledContent(outcome.result),
				requestId,
				idempotentReplay: false,
			},
			{
				status: 201,
			},
		);
	} catch (err) {
		return routeError(err);
	}
}
