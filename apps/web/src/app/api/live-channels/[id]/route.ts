import {
	effectiveLivePlanForRun,
	liveRunWindow,
	liveToVodFamilySupport,
	programEndBeyondRunWindow,
	stepLogSchema,
} from "@bitovp/core";
import { NextResponse } from "next/server";
import { z } from "zod";
import { ACTOR_HEADER } from "@/lib/auth/api-token-gate";
import { ROLE_HEADER } from "@/lib/auth/roles";
import { customerErrorDetails } from "@/lib/customer-error";
import { writeAuditLog } from "@/lib/server/audit";
import { getServerContext } from "@/lib/server/context";
import {
	VMAF_TERMINAL_STATUSES,
	VmafStillScoring,
} from "@/lib/server/delete-jobs";
import {
	invalidIdResponse,
	jsonError,
	readJson,
	routeError,
	validationError,
} from "@/lib/server/http";
import { readHeartbeatReception } from "@/lib/server/live-heartbeat-reception";
import {
	liveToVodFamiliesForRole,
	liveToVodForRole,
} from "@/lib/server/live-to-vod-view";
import { playbackLinksForLivePlan } from "@/lib/server/playback-links";

type RouteParams = { params: Promise<{ id: string }> };

/**
 * Full row incl. plan, step log and lastHeartbeat (snapshots are stored
 * redacted; the streamKey/encoderIp COLUMNS are the readable ingest
 * coordinates — the ledgered exception).
 */
export async function GET(req: Request, { params }: RouteParams) {
	const { id } = await params;
	const invalid = invalidIdResponse(id);
	if (invalid) {
		return invalid;
	}
	try {
		const ctx = await getServerContext();
		const row = await ctx.prisma.liveChannel.findUnique({
			where: { id },
			//  PR2 (reader move): the CURRENT run rides the detail
			// response — the channel columns stay dual-written for now, but
			// every panel reads currentRun-first so the later column drop is a
			// server-side change, not a UI hunt. Newest by seq; runs[0] or
			// absent for a never-run channel (the UI's fallback is the truth
			// there, not a default).
			include: {
				runs: {
					orderBy: { seq: "desc" },
					take: 1,
					select: {
						id: true,
						seq: true,
						status: true,
						cancelRequested: true,
						bitmovinEncodingId: true,
						encoderIp: true,
						streamKey: true,
						outputPrefix: true,
						runningSince: true,
						endedAt: true,
						programStartAt: true,
						programEndAt: true,
						error: true,
						lastHeartbeat: true,
						lastHeartbeatAt: true,
						// : the provider's view of this run's encoding —
						// the page derives amber "cannot be confirmed" and the
						// terminal hint from these, never from local status alone.
						providerStatus: true,
						providerStatusObservedAt: true,
						providerUnknownSince: true,
						providerTerminalAt: true,
						// review-242 A4: PR2b's step-timeline and live-to-VOD
						// panels need these — and they are safe to expose only
						// now that A1's mirrors feed them (exposing them
						// unmirrored would have exposed WRONG data).
						stepLog: true,
						liveToVod: true,
						// #161: the origin observer's per-run state — the detail
						// panel renders verdicts/unavailability from here.
						originObservation: true,
						createdAt: true,
					},
				},
			},
		});
		if (!row) {
			return jsonError(404, "Not found");
		}
		// `provisionClaimedAt` is an internal worker LEASE , not
		// part of this route's external contract — dropped here rather than
		// silently widening the documented response with a field no client can
		// use (review of that ledger row).
		const {
			runs,
			provisionClaimedAt: _lease,
			...channel
		} = row as typeof row & {
			runs?: unknown[];
		};
		const currentRun = row.runs[0] ?? null;
		// Password mode has one owner session and no role header. Users/token
		// modes must prove ADMIN through the proxy-resolved role. The proxy
		// overwrites ACTOR_HEADER and deletes/overwrites ROLE_HEADER on every
		// continuing request, so none/anonymous/unresolved tokens fail closed.
		const actor = req.headers.get(ACTOR_HEADER);
		const roleResolvedPrincipal =
			actor?.startsWith("user:") === true ||
			(actor?.startsWith("token:") === true && actor !== "token:unresolved");
		const technicalDetailsAllowed =
			actor === "session" ||
			(roleResolvedPrincipal && req.headers.get(ROLE_HEADER) === "ADMIN");
		const currentRunView = currentRun
			? {
					...currentRun,
					liveToVod: liveToVodForRole(
						currentRun.liveToVod,
						technicalDetailsAllowed,
					),
				}
			: null;
		// : links must name the paths the CURRENT run actually
		// writes — a re-aired run's subtree, or the plan's own paths for
		// seq 1 / pre-#155 runs (outputPrefix ""). effectiveLivePlanForRun
		// recomputes the rebase (exact — the plan is immutable after create)
		// and answers null when the stored prefix disagrees with this
		// build's derivation; [] links are honest there, guessed paths are
		// not. A never-run channel keeps the plan's own paths.
		const planForLinks = currentRun
			? effectiveLivePlanForRun(row.plan, currentRun)
			: row.plan;
		// : which live-to-VOD families THIS recording can carry — read
		// off the CHANNEL column, exactly the log the POST route judges
		// (`row.stepLog`, review-536), so the panel preselects only what will
		// not 422. An unreadable log is null; the POST says why.
		const familyLog = stepLogSchema.safeParse(channel.stepLog);
		const liveToVodFamilies = familyLog.success
			? liveToVodFamiliesForRole(
					liveToVodFamilySupport(familyLog.data),
					technicalDetailsAllowed,
				)
			: null;
		const observedNow = new Date();
		const heartbeatReception = await readHeartbeatReception(
			ctx.prisma,
			currentRun,
			observedNow,
		);
		// Derived here, not in the browser, for the same reason as the VOD route:
		// the credential's config never needs to cross .
		return NextResponse.json({
			...channel,
			liveToVod: liveToVodForRole(channel.liveToVod, technicalDetailsAllowed),
			liveToVodFamilies,
			currentRun: currentRunView,
			heartbeatReception,
			technicalDetailsAllowed,
			playbackLinks: planForLinks
				? await playbackLinksForLivePlan(ctx, planForLinks)
				: [],
			// review-260 127-A5 (folded into #126): heartbeat freshness must
			// not compare a WORKER-stamped `at` against the BROWSER clock — a
			// viewer 90 seconds ahead reads a healthy channel as disconnected. The client
			// anchors its ticking now to THIS server stamp instead.
			serverNow: new Date().toISOString(),
		});
	} catch (err) {
		return routeError(err);
	}
}

/** Sentinel: the atomic terminal-guard matched 0 rows → roll back, return 409. */
class ChannelNotDeletable extends Error {}

/**
 * Delete a non-running live channel and ITS local dependents — LOCAL records
 * only. We never call the Bitmovin API and never touch object storage; a
 * remote live encoding is left as-is (stop it first if it is still up).
 *
 * Terminal-only: only CREATED (never provisioned), STOPPED and ERROR are
 * deletable. PROVISIONING / RUNNING / STOPPING return 409 (stop the channel
 * first) so a live encoding the worker is still managing never loses its row.
 *
 * The terminal check is enforced ATOMICALLY inside the transaction (a
 * status-guarded deleteMany whose count is asserted), mirroring the
 * atomic-claim convention of the /actions route. The up-front findUnique only
 * serves the clean common-case 404/409 responses and reads bitmovinAccountId
 * for the audit — it does NOT gate the delete, so a channel that leaves a
 * terminal state between the read and the write (e.g. /actions claiming
 * CREATED|ERROR→PROVISIONING and enqueuing concurrently) is NOT deleted out
 * from under the worker (which would otherwise provision a deleted channel and
 * hit a missing-parent FK on the heartbeat write); the guarded deleteMany
 * affects 0 rows and the whole tx rolls back, surfacing a 409.
 *
 * Cascade: FeederSession and LiveHeartbeat are FK onDelete:Cascade → automatic.
 * LIVE VmafJobs are linked to a channel only by `params.liveChannelId` (a JSON
 * field, NOT a relation — capture-vmaf stores it there), so the FK can't reach
 * them; we delete them explicitly FIRST via that JSON path (each cascades its
 * VmafResults). Doing dependents before the guarded parent means a rollback
 * (guard miss) restores them too.
 */
export async function DELETE(req: Request, { params }: RouteParams) {
	const { id } = await params;
	const invalid = invalidIdResponse(id);
	if (invalid) {
		return invalid;
	}
	try {
		const ctx = await getServerContext();
		const row = await ctx.prisma.liveChannel.findUnique({
			where: { id },
			select: { id: true, status: true, bitmovinAccountId: true },
		});
		if (!row) {
			return jsonError(404, "Not found");
		}
		if (
			row.status === "PROVISIONING" ||
			row.status === "RUNNING" ||
			row.status === "STOPPING"
		) {
			return jsonError(
				409,
				`Channel is ${row.status} — stop it before deleting`,
				customerErrorDetails("LIVE_CHANNEL_STOP_BEFORE_DELETE", {
					status: row.status,
				}),
			);
		}
		// Interactive transaction: dependents first, then the atomically-guarded
		// parent delete. A 0-count guard throws the sentinel → tx rolls back.
		// The SAME guard the VOD delete grew, for the same reason: a report that
		// cannot be deleted directly must not be deletable through its parent. A
		// live capture (`POST …/capture-vmaf`) keeps scoring for minutes after the
		// channel stops, so deleting a STOPPED channel used to destroy a
		// PENDING/RUNNING report mid-write — while `DELETE /api/vmaf-jobs/{id}`
		// answered 409 for that same row. Two answers, one row (review catch: this
		// was the third sibling path, and consolidating the other two is what made
		// it an inconsistency rather than merely a gap).
		const scoring = await ctx.prisma.vmafJob.findFirst({
			where: {
				params: { path: ["liveChannelId"], equals: id },
				status: { notIn: [...VMAF_TERMINAL_STATUSES] },
			},
			select: { status: true },
		});
		if (scoring) {
			return jsonError(
				409,
				`A VMAF report for this channel is still ${scoring.status} — wait for it to finish before deleting`,
				customerErrorDetails("LIVE_CHANNEL_VMAF_IN_PROGRESS", {
					status: scoring.status,
				}),
			);
		}
		const deletedVmafJobs = await ctx.prisma.$transaction(async (tx) => {
			// Re-assert inside the tx: one that entered PENDING since the read above
			// must not be deleted out from under the scorer.
			const stillScoring = await tx.vmafJob.count({
				where: {
					params: { path: ["liveChannelId"], equals: id },
					status: { notIn: [...VMAF_TERMINAL_STATUSES] },
				},
			});
			if (stillScoring > 0) {
				throw new VmafStillScoring();
			}
			// Status-guarded, matching the assertion above, so the two cannot drift.
			const vmafJobs = await tx.vmafJob.deleteMany({
				where: {
					params: { path: ["liveChannelId"], equals: id },
					status: { in: [...VMAF_TERMINAL_STATUSES] },
				},
			});
			const { count } = await tx.liveChannel.deleteMany({
				where: {
					id,
					status: { notIn: ["PROVISIONING", "RUNNING", "STOPPING"] },
				},
			});
			if (count === 0) {
				throw new ChannelNotDeletable();
			}
			return vmafJobs.count;
		});
		await writeAuditLog(
			ctx,
			{
				method: "DELETE",
				path: `/api/live-channels/${id}`,
				statusCode: 200,
				bitmovinAccountId: row.bitmovinAccountId ?? undefined,
				response: { id, deletedVmafJobs },
			},
			req,
		);
		return NextResponse.json({ id, deleted: true });
	} catch (err) {
		if (err instanceof ChannelNotDeletable) {
			return jsonError(
				409,
				"Channel changed state and was not deleted — refresh and retry",
				customerErrorDetails("LIVE_CHANNEL_STATE_CHANGED"),
			);
		}
		if (err instanceof VmafStillScoring) {
			// The in-tx race guard. Without this branch the sentinel would surface
			// as an opaque 500 — the throw rolls the tx back either way, but the
			// operator needs to be told it was a state change, not a fault.
			return jsonError(
				409,
				"A VMAF report for this channel started scoring — wait for it to finish before deleting",
				customerErrorDetails("LIVE_CHANNEL_VMAF_IN_PROGRESS", {
					status: "RUNNING",
				}),
			);
		}
		return routeError(err);
	}
}

const patchSchema = z.strictObject({
	/**
	 * Runtime cap in minutes . null clears it. Ceiling is 7 days
	 * — a cap only means anything if it is shorter than "forever", and fat
	 * fingers adding a zero should fail here, not bill for a month.
	 */
	maxRunMinutes: z.number().int().min(1).max(10_080).nullable(),
});

/**
 * PATCH — channel settings the operator may change at any time. Currently
 * exactly one: maxRunMinutes. The sweep reads it live, so raising or
 * clearing it on a RUNNING channel takes effect on the next tick (≤30s).
 */
export async function PATCH(req: Request, { params }: RouteParams) {
	const { id } = await params;
	const invalid = invalidIdResponse(id);
	if (invalid) {
		return invalid;
	}
	const parsed = patchSchema.safeParse(await readJson(req));
	if (!parsed.success) {
		return validationError(parsed.error);
	}
	try {
		const ctx = await getServerContext();
		const existing = await ctx.prisma.liveChannel.findUnique({
			where: { id },
			// : the cap is the BACKSTOP and programEndAt is the
			// intent, so a new cap has to be measured against the window it
			// would cut short.
			select: {
				id: true,
				bitmovinAccountId: true,
				programEndAt: true,
				runningSince: true,
				createdAt: true,
			},
		});
		if (!existing) {
			return jsonError(404, "Not found");
		}
		/**
		 *  — a runtime cap shorter than the scheduled program.
		 * `program-schedule.ts` states the precedence: "the STOP row is the
		 * intended end; maxRunMinutes is the backstop", so a backstop that
		 * lands first is the misconfiguration and gets refused here rather
		 * than silently stopping the airing mid-program on the sweep's next
		 * tick. Only the knob this request changes is measured (plan `null`) —
		 * a PATCH that touches the cap must not fail over an unrelated
		 * auto-shutdown setting the operator did not just edit.
		 */
		if (parsed.data.maxRunMinutes !== null && existing.programEndAt) {
			const capRefusal = programEndBeyondRunWindow(
				liveRunWindow(null, existing.runningSince ?? existing.createdAt, {
					maxRunMinutes: parsed.data.maxRunMinutes,
				}),
				existing.programEndAt.getTime(),
			);
			if (capRefusal) {
				return jsonError(
					422,
					capRefusal,
					customerErrorDetails("LIVE_CHANNEL_RUNTIME_CAP_BEFORE_PROGRAM_END"),
				);
			}
		}
		const row = await ctx.prisma.liveChannel.update({
			where: { id },
			data: { maxRunMinutes: parsed.data.maxRunMinutes },
			select: { id: true, maxRunMinutes: true },
		});
		await writeAuditLog(
			ctx,
			{
				method: "PATCH",
				path: `/api/live-channels/${id}`,
				statusCode: 200,
				bitmovinAccountId: existing.bitmovinAccountId ?? undefined,
				request: parsed.data,
				response: row,
			},
			req,
		);
		return NextResponse.json(row);
	} catch (err) {
		return routeError(err);
	}
}
