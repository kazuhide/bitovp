import {
	isLiveRunStatus,
	liveChannelPlanSchema,
	liveRunWindow,
	liveRunWindowPlanFrom,
	readLiveAutoShutdownUpdate,
	resolveAutoLead,
	resolveStartupRegion,
	SCHEDULE_DEFAULT_LEAD_SECONDS,
	SCHEDULE_LEAD_MARGIN_SECONDS,
	scheduleBeyondRunWindow,
	startupProfile,
} from "@bitovp/core";
import { NextResponse } from "next/server";
import { customerErrorDetails } from "@/lib/customer-error";
import {
	LIST_LIMIT_MAX,
	liveScheduleArmSchema,
} from "@/lib/live-runtime/schemas";
import { bitmovinProxyError } from "@/lib/server/bitmovin";
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

/** Env override with core's default — NaN/absent falls back. */
function envInt(name: string, fallback: number): number {
	const raw = Number(process.env[name]);
	return Number.isInteger(raw) && raw > 0 ? raw : fallback;
}

/* One-shot application schedules dispatch START, STOP, or SLATE_IN through the live queue. They remain editable independently of channel state. Late starts and slate insertions become MISSED; stops remain eligible regardless of lateness. GET returns armed schedules and recent finished rows. */
/**
 * How many ARMED rows the list carries (audit 2026-08-29
 * IMPORTANT-3).
 *
 * The defect: one `orderBy fireAt desc, take 200` over the WHOLE table. A
 * channel with more than 200 rows armed into the future got the 200 FURTHEST
 * OUT — the nearest upcoming rows, the ones the panel exists to show, sorted
 * last in `desc` and fell off the end, and the history section fell off with
 * them (every future row sorts before every past one, so past rows only ever
 * survive on the leftovers). The operator saw next month's schedule and an
 * empty "not fired yet" list.
 *
 * The fix reads the panel's own partition instead of guessing a time
 * boundary: `schedule-panel.tsx` puts `status === "ARMED"` in **upcoming**
 * (ascending, unsliced) and everything else in **history** (descending,
 * sliced to 20). So the route asks for exactly those two sets, each in its
 * own order, and the nearest upcoming row cannot fall off any more — it is
 * the FIRST row of an ascending query, not the 201st of a descending one.
 *
 * Ascending over ARMED, not over `fireAt >= now`, on purpose: a row that is
 * due but blocked (the other half of  — a STOP waiting out a
 * PROVISIONING channel) stays ARMED with a fireAt in the PAST. Those are the
 * rows an operator most needs, and an upcoming-means-future filter would
 * push them into the history bucket to compete with finished rows.
 */
const UPCOMING_LIMIT = 200;

/**
 * How many finished rows accompany them. The panel renders 20; the headroom
 * is so the panel can show more without a route change. Its own query keeps
 * it from ever being crowded out by armed rows, which was the second half of
 * the defect above.
 */
const HISTORY_LIMIT = 50;

export async function GET(_req: Request, { params }: RouteParams) {
	const { id } = await params;
	const invalid = invalidIdResponse(id);
	if (invalid) {
		return invalid;
	}
	try {
		const ctx = await getServerContext();
		const channel = await ctx.prisma.liveChannel.findUnique({
			where: { id },
			select: { id: true },
		});
		if (!channel) {
			return jsonError(404, "Not found");
		}
		// Two queries, ONE flat array on the wire: the panel re-sorts each
		// bucket itself, so the response order is not a contract and the shape
		// stays backward-compatible. No `select` on either — the panel colours
		// a fired row from `outcome`, and narrowing is how those fields go
		// missing (the #238 pin below this file's tests).
		const [upcoming, history] = await Promise.all([
			ctx.prisma.liveSchedule.findMany({
				where: { liveChannelId: id, status: "ARMED" },
				orderBy: { fireAt: "asc" },
				take: UPCOMING_LIMIT,
			}),
			ctx.prisma.liveSchedule.findMany({
				where: { liveChannelId: id, status: { not: "ARMED" } },
				orderBy: { fireAt: "desc" },
				take: HISTORY_LIMIT,
			}),
		]);
		const rows = [...upcoming, ...history];
		/**
		 * rev367 S-2 — the LIVE phase of a switch row's staged session. The
		 * row's own `readyAt` is a write-once RECORD ("first became ready"),
		 * and a takeover RE-STAGES the session (its readiness is cleared, the
		 * download runs again) without touching the record — so a panel
		 * reading the record kept saying "ready to switch" over a source
		 * nobody held. The session is the truth the sweep's own commit gate
		 * reads; the panel gets the same four columns, attached per row. The
		 * key is added only where a session is named, so rows without one keep
		 * their exact prior shape.
		 */
		const sessionIds = rows
			.map((row) => row.feederSessionId)
			.filter(
				(sessionId): sessionId is string => typeof sessionId === "string",
			);
		const stagedSessions =
			sessionIds.length > 0
				? await ctx.prisma.feederSession.findMany({
						where: { id: { in: sessionIds } },
						select: {
							id: true,
							status: true,
							commitAt: true,
							readyAt: true,
							committedAt: true,
						},
					})
				: [];
		const sessionById = new Map(
			stagedSessions.map((session) => [session.id, session]),
		);
		return NextResponse.json(
			rows.map((row) =>
				typeof row.feederSessionId === "string"
					? {
							...row,
							stagedSession: sessionById.get(row.feederSessionId) ?? null,
						}
					: row,
			),
		);
	} catch (err) {
		return routeError(err);
	}
}

/** How many C6 pages the slate-content check walks before giving up. */
const CONTENT_LOOKUP_MAX_PAGES = 5;

/**
 * POST — arm a schedule. fireAt must be in the future (the sweep's late
 * policies exist for rows that BECAME late, not for arming the past).
 * SLATE_IN rows verify the named content exists on the channel's CURRENT
 * encoding and is READY — content ids die with their encoding, so a slate
 * can only be armed once the channel has one (Bitmovin's own runAt has the
 * same reality; ours at least says so).
 */
export async function POST(req: Request, { params }: RouteParams) {
	const { id } = await params;
	const invalid = invalidIdResponse(id);
	if (invalid) {
		return invalid;
	}
	const parsed = liveScheduleArmSchema.safeParse(await readJson(req));
	if (!parsed.success) {
		return validationError(parsed.error);
	}
	const body = parsed.data;
	try {
		const ctx = await getServerContext();
		const channel = await ctx.prisma.liveChannel.findUnique({
			where: { id },
			// : the run window needs the plan's auto-shutdown, our
			// own runtime cap, and the anchor those minutes count from.
			select: {
				id: true,
				plan: true,
				stepLog: true,
				maxRunMinutes: true,
				runningSince: true,
				createdAt: true,
			},
		});
		if (!channel) {
			return jsonError(404, "Not found");
		}
		// #160 PR3 — arm-time auto-lead: fireAt = airAt − (P90 + margin) from
		// the channel's resolved region profile, ONCE, here (never in the
		// sweep — design §5's index argument). Below the honesty bar the
		// DEFAULT lead applies and the response says so. A manually chosen
		// EARLIER fireAt wins (more lead is safe, less is not).
		let autoLead: ReturnType<typeof resolveAutoLead> | null = null;
		let fireAt: Date;
		if (body.autoLeadTime) {
			const airAtMs = Date.parse(body.airAt as string);
			const parsedPlan = liveChannelPlanSchema.safeParse(channel.plan);
			const region = parsedPlan.success
				? resolveStartupRegion(parsedPlan.data).region
				: "AUTO";
			const windowMs = 30 * 24 * 60 * 60 * 1000;
			const samples = await ctx.prisma.startupSample.findMany({
				where: {
					cloudRegion: region,
					// review-pr34 B1: CHANNEL only. A probe's 1-rendition plan
					// provisions faster than a real ladder, so a probe-fed P90
					// SHORTENS the lead in exactly the dangerous direction —
					// and one 20-probe batch would cross the honesty bar (n>=8)
					// on probe data alone. If probe data should ever feed
					// leads, the honest forms are max(channelP90, probeP90) or
					// a shape penalty — never a merged percentile.
					source: "CHANNEL",
					observedAt: { gte: new Date(Date.now() - windowMs) },
				},
				select: { outcome: true, queueSeconds: true, observedAt: true },
				take: 5000,
			});
			const profile = startupProfile(
				samples.map((sample) => ({
					outcome: sample.outcome as "RUNNING" | "FAILED" | "CENSORED",
					queueSeconds: sample.queueSeconds,
					observedAt: sample.observedAt,
				})),
				30,
				new Date(),
			);
			autoLead = resolveAutoLead(profile, {
				airAtMs,
				defaultLeadSeconds: envInt(
					"SCHEDULE_DEFAULT_LEAD_SECONDS",
					SCHEDULE_DEFAULT_LEAD_SECONDS,
				),
				leadMarginSeconds: envInt(
					"SCHEDULE_LEAD_MARGIN_SECONDS",
					SCHEDULE_LEAD_MARGIN_SECONDS,
				),
			});
			const manualMs = body.fireAt ? Date.parse(body.fireAt) : null;
			const effectiveMs =
				manualMs !== null && manualMs < autoLead.fireAtMs
					? manualMs
					: autoLead.fireAtMs;
			fireAt = new Date(effectiveMs);
			if (fireAt.getTime() <= Date.now()) {
				return jsonError(
					422,
					`air time is too close: the resolved lead is ${autoLead.leadSeconds}s, so provisioning would have to start in the past`,
					customerErrorDetails("SCHEDULE_LEAD_TIME_TOO_SHORT", {
						seconds: autoLead.leadSeconds,
					}),
				);
			}
		} else {
			fireAt = new Date(body.fireAt as string);
			if (fireAt.getTime() <= Date.now()) {
				return jsonError(
					422,
					"fireAt must be in the future",
					customerErrorDetails("SCHEDULE_FIRE_TIME_NOT_FUTURE"),
				);
			}
		}
		/**
		 *  — a row armed past the moment the run ends by itself.
		 * The 2026-08-29 audit armed feeder / slate / STOP rows minutes past a
		 * `streamTimeoutMinutes = 6`; the provider ended the encoding on time
		 * and the rows fired into nothing, recorded FIRED.
		 *
		 * Anchor: `runningSince` once the run is observed RUNNING, otherwise
		 * `createdAt` — the provision request, which since #125 is creation.
		 * Refused before the SLATE_IN content lookup below, so an impossible
		 * row costs no Bitmovin round-trips.
		 */
		const runWindow = liveRunWindow(
			// Read straight off the stored JSON, not through a whole-plan parse:
			// an old plan that no longer validates must not silently lose its
			// bound (`liveRunWindowPlanFrom`'s own reasoning).
			liveRunWindowPlanFrom(channel.plan),
			channel.runningSince ?? channel.createdAt,
			{
				maxRunMinutes: channel.maxRunMinutes,
				autoShutdownUpdate: readLiveAutoShutdownUpdate(channel.stepLog),
			},
		);
		const beyond = scheduleBeyondRunWindow(runWindow, {
			action: body.action,
			fireAtMs: fireAt.getTime(),
		});
		if (beyond) {
			return jsonError(
				422,
				beyond,
				customerErrorDetails("SCHEDULE_OUTSIDE_RUN_WINDOW"),
			);
		}
		if (body.action === "SLATE_IN") {
			// The schema's superRefine guarantees these three exist together.
			const contentId = body.insertableContentId as string;
			const resolved = await resolveLiveEncoding({
				ctx,
				channelId: id,
				bitmovinAccountId: body.bitmovinAccountId as string,
				// Content survives on a non-running encoding; only firing needs
				// RUNNING (the worker action guards that at fire time).
				requireRunning: false,
				subject: "Scheduling a slate",
			});
			if (!resolved.ok) {
				return resolved.response;
			}
			try {
				let found: { status?: unknown } | undefined;
				for (let page = 0; page < CONTENT_LOOKUP_MAX_PAGES; page++) {
					const result =
						await resolved.api.encoding.encodings.live.insertableContent.list(
							resolved.encodingId,
							{ offset: page * LIST_LIMIT_MAX, limit: LIST_LIMIT_MAX },
						);
					const items = result.items ?? [];
					found = items.find(
						(item) => (item as { id?: string }).id === contentId,
					);
					if (found || items.length < LIST_LIMIT_MAX) {
						break;
					}
				}
				if (!found) {
					return jsonError(
						422,
						"Insertable content not found on the channel's current encoding",
						customerErrorDetails("SCHEDULE_CONTENT_NOT_FOUND"),
					);
				}
				if (String(found.status) !== "READY") {
					return jsonError(
						422,
						`Insertable content is not READY yet (status: ${String(found.status)})`,
						customerErrorDetails("SCHEDULE_CONTENT_NOT_READY", {
							status: String(found.status),
						}),
					);
				}
			} catch (apiErr) {
				return bitmovinProxyError(apiErr);
			}
		}
		/**
		 * , review-358 IMPORTANT — bind EAGERLY when an airing is
		 * already on.
		 *
		 * `liveChannelRunId` is NULL for two different situations and the
		 * sweep's lazy bind cannot tell them apart:
		 *
		 *  - a creation-time row, written inside the channel's own create
		 *    transaction BEFORE any run existed. Those must stay lazy — a row
		 *    nailed to run 1 at provisioning would have its own programme
		 *    refused after an error and a re-air.
		 *  - a row armed from the panel WHILE run 1 was live, which is exactly
		 *    "armed for this airing". Left NULL, it is only bound when the
		 *    sweep first evaluates it as DUE; if its fireAt lands after run 1
		 *    ended and run 2 began, the row silently rebinds to run 2 and
		 *    fires into the wrong airing — the audited bug, one notch
		 *    narrower.
		 *
		 * This door knows which one it is, so it says so. The run lookup is
		 * the same one the feeder-sessions route uses.
		 *
		 * Only a LIVE run is stamped (`isLiveRunStatus` — the sweep's own
		 * notion, and the set the one-live-per-channel index enforces). A
		 * TERMINAL latest run must NOT be stamped: arming a STOP tonight for
		 * tomorrow's re-air is "stop whatever is airing then", and binding it
		 * to the airing that already ended would refuse the very run it is
		 * meant to stop.
		 */
		const currentRun = await ctx.prisma.liveChannelRun.findFirst({
			where: { liveChannelId: id },
			orderBy: { seq: "desc" },
			select: { id: true, status: true },
		});
		const armedForRun =
			currentRun && isLiveRunStatus(currentRun.status) ? currentRun.id : null;
		const row = await ctx.prisma.liveSchedule.create({
			data: {
				liveChannelId: id,
				liveChannelRunId: armedForRun,
				action: body.action,
				fireAt,
				insertableContentId: body.insertableContentId ?? null,
				slateDurationSeconds: body.slateDurationSeconds ?? null,
				// #160 PR2: the air-time deadline pair (margin defaults in the DB).
				airAt: body.airAt ? new Date(body.airAt) : null,
				...(body.deadlineMarginSeconds !== undefined
					? { deadlineMarginSeconds: body.deadlineMarginSeconds }
					: {}),
				...(autoLead
					? {
							autoLeadTime: true,
							// The stored resolution (raw values, note-precedent
							// mechanical English): re-arming re-resolves.
							note:
								autoLead.source === "P90"
									? `auto-lead: P90 ${autoLead.p90Seconds}s + margin -> lead ${autoLead.leadSeconds}s (n=${autoLead.n} CHANNEL)`
									: `auto-lead: default ${autoLead.leadSeconds}s (insufficient data, n=${autoLead.n} CHANNEL)`,
						}
					: {}),
			},
		});
		return NextResponse.json(
			{
				...row,
				...(autoLead ? { autoLead } : {}),
				// #247: the knobs that CAN still end this run early but cannot
				// be checked against a clock — named, never refused on.
				...(runWindow.conditional.length > 0
					? { autoShutdownWarnings: runWindow.conditional }
					: {}),
			},
			{ status: 201 },
		);
	} catch (err) {
		return routeError(err);
	}
}
