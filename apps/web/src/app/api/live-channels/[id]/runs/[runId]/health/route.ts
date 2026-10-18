import {
	deriveRunHealth,
	deriveRunTimeline,
	RUN_HEALTH_SPAN_GAP_MS,
	type RunHealth,
	type RunTimeline,
	type RunTimelineAction,
} from "@bitovp/core";
import { NextResponse } from "next/server";
import { getServerContext } from "@/lib/server/context";
import { invalidIdResponse, jsonError, routeError } from "@/lib/server/http";
import { pushHeartbeatRow } from "@/lib/server/live-heartbeat-reception";

type RouteParams = { params: Promise<{ id: string; runId: string }> };

/**
 * Run health (2026-08-23, owner ask): the three-layer answer to "is this
 * broadcast healthy" — ingest arriving / encoder up / output produced — as
 * per-poll points and from→to spans, derived in core from the run's OWN
 * heartbeat rows. Serves both faces of the feature: the RUNNING channel's
 * live lamps (latest point) and a finished run's timeline (lanes).
 *
 * A cap, stated rather than silent: a run's heartbeats at the 30s cadence
 * reach ~120 rows/hour; `take` bounds a run at its NEWEST 2,880 rows (24h)
 * and the response says when it truncated, because a timeline that silently
 * dropped its HEAD would read as "the broadcast started here" — and the "now"
 * lamps must always see the newest poll (the copy `live.health.truncated`
 * says which end was cut: the earlier samples).
 */
const MAX_ROWS = 2_880;
/**
 *  (owner): the state lines follow PUSH wherever a verified Push
 * sample exists and Poll everywhere else. Both carry the same provider
 * heartbeat, so their union is one truth at two cadences: span edges land on
 * the 2 s Push samples, and a Push outage never opens a gap because the 30 s
 * Poll rows still fill it. The same row budget as Poll — at 2 s that is the
 * newest ~96 minutes; older stretches stay Poll-drawn and the response says so.
 */
const MAX_PUSH_ROWS = 2_880;

export type RunHealthResponse = RunHealth & {
	run: {
		id: string;
		seq: number;
		status: string;
		createdAt: string;
		/** 's measured queue/allocation seconds (null pre-#160). */
		queueSeconds: number | null;
	};
	truncated: boolean;
	/** False for a DASH-only plan — the output lane is unobservable, not down. */
	outputObservable: boolean;
	/** : the absolute-time window + discrete events. */
	timeline: RunTimeline;
	/** True when the content-action record hit its cap (first 100 kept). */
	actionsTruncated: boolean;
	/** : which source drew the state lines. */
	laneSources: {
		/** At least one verified Push sample of this run entered the series. */
		push: boolean;
		pushSamples: number;
		/** Oldest Push sample used — Poll alone draws anything earlier. */
		pushOldestAtMs: number | null;
		/** The Push budget was hit: an earlier Push-covered stretch is Poll-drawn. */
		pushTruncated: boolean;
	};
};

/**
 * START_LIVE_ENCODING's timestamps out of the persisted step log — the
 * start request (axis origin) and Bitmovin's acceptance (queue entry).
 * The log is untyped Json here; a malformed/absent entry yields undefined
 * fields and the timeline falls back to createdAt without claiming events.
 */
function startStepTimes(stepLog: unknown): {
	requestedAtMs?: number;
	queuedAtMs?: number;
} {
	if (!Array.isArray(stepLog)) {
		return {};
	}
	for (const entry of stepLog) {
		const e = entry as {
			kind?: string;
			startedAt?: string;
			finishedAt?: string;
		} | null;
		if (e?.kind !== "START_LIVE_ENCODING") {
			continue;
		}
		const requested = e.startedAt ? Date.parse(e.startedAt) : Number.NaN;
		const queued = e.finishedAt ? Date.parse(e.finishedAt) : Number.NaN;
		return {
			...(Number.isFinite(requested) ? { requestedAtMs: requested } : {}),
			...(Number.isFinite(queued) ? { queuedAtMs: queued } : {}),
		};
	}
	return {};
}

/** Bounded like MAX_ROWS — and like MAX_ROWS the response SAYS when it
 * truncated (review-294 S1: the first cut claimed "stated" while only the
 * heartbeat cap actually was). */
const MAX_ACTION_ROWS = 100;

export async function GET(_req: Request, { params }: RouteParams) {
	const { id, runId } = await params;
	const invalid = invalidIdResponse(id) ?? invalidIdResponse(runId);
	if (invalid) {
		return invalid;
	}
	try {
		const ctx = await getServerContext();
		// Channel-scoped lookup: a run id from ANOTHER channel must 404, not
		// leak — the where clause carries both ids.
		const run = await ctx.prisma.liveChannelRun.findFirst({
			where: { id: runId, liveChannelId: id },
			select: {
				id: true,
				seq: true,
				status: true,
				createdAt: true,
				stepLog: true,
				runningSince: true,
				endedAt: true,
				bitmovinEncodingId: true,
				// 's denormalized queue/allocation seconds — the
				// startup FIGURE the chart no longer shows as an axis region
				// .
				queueSeconds: true,
			},
		});
		if (!run) {
			return jsonError(404, "run not found on this channel");
		}
		// review-292 N3: the heartbeat's delivery block carries HLS ONLY
		// (measured, #161 PR0), so a DASH-only channel's output lane is
		// STRUCTURALLY unobservable — absence there is topology, not failure.
		// The plan says which; the response says so; the UI greys instead of
		// reddening.
		const channelRow = await ctx.prisma.liveChannel.findUnique({
			where: { id },
			select: { plan: true },
		});
		const plan = channelRow?.plan as {
			liveManifests?: { kind?: string }[];
		} | null;
		const outputObservable = (plan?.liveManifests ?? []).some(
			(m) => m.kind === "HLS",
		);
		const newestFirst = await ctx.prisma.liveHeartbeat.findMany({
			where: { liveChannelRunId: runId },
			// desc + reverse keeps the NEWEST rows on overflow. Retention grew
			// from ~6h to 7 days (2026-09-02), so a run can now hold far more
			// than MAX_ROWS (24h at 30s) — with asc + take the "now" lamps of a
			// second-day broadcast would have frozen on day-old state, exactly
			// what review-292 N5 said to flip to when retention grew. The
			// timeline loses its earliest hours instead, and `truncated` says so.
			orderBy: { at: "desc" },
			select: { at: true, raw: true },
			take: MAX_ROWS + 1,
		});
		const truncated = newestFirst.length > MAX_ROWS;
		const rows = (truncated ? newestFirst.slice(0, MAX_ROWS) : newestFirst)
			.slice()
			.reverse();
		const nowMs = Date.now();
		// Bounded to the run's own lifetime (review-543 R1): WebhookEvent has no
		// run-id index, so an unbounded run-id filter would walk the receivedAt
		// index across every channel's receipts; the sibling reader
		// (readHeartbeatReception) bounds the same way. A `(liveChannelRunId,
		// receivedAt)` index is the follow-up, not this route's fix.
		const encodingId = run.bitmovinEncodingId;
		const pushNewestFirst = encodingId
			? await ctx.prisma.webhookEvent.findMany({
					where: {
						eventType: "LIVE_ENCODING_HEARTBEAT",
						signatureValid: true,
						liveChannelRunId: runId,
						receivedAt: { gte: run.createdAt, lte: new Date(nowMs) },
					},
					orderBy: { receivedAt: "desc" },
					select: { raw: true },
					take: MAX_PUSH_ROWS + 1,
				})
			: [];
		const pushTruncated = pushNewestFirst.length > MAX_PUSH_ROWS;
		// One row per provider sample time (review-543 O1): a redelivered
		// receipt must neither double a point nor spend a budget slot.
		const seenSampleMs = new Set<number>();
		const pushRows = encodingId
			? pushNewestFirst.slice(0, MAX_PUSH_ROWS).flatMap((row) => {
					const parsed = pushHeartbeatRow(row.raw, encodingId);
					if (!parsed || seenSampleMs.has(parsed.at.getTime())) return [];
					seenSampleMs.add(parsed.at.getTime());
					return [parsed];
				})
			: [];
		// ONE gap feeds BOTH derivations (review-294 delta note: the required
		// param closes omission drift but not divergence — a route passing
		// 600s here against 90s lanes kept 17/17 tests green. One binding,
		// two consumers, no way to diverge).
		const spanGapMs = RUN_HEALTH_SPAN_GAP_MS;
		const health = deriveRunHealth(
			[
				...rows.map((r) => ({
					at: r.at,
					raw: r.raw,
				})),
				...pushRows,
			],
			// The clock gates the "now" lamps (review-292 N1): a dead encoder
			// stops producing rows, and without this the lamps freeze green.
			{ nowMs, spanGapMs },
		);
		const laneSources: RunHealthResponse["laneSources"] = {
			push: pushRows.length > 0,
			pushSamples: pushRows.length,
			pushOldestAtMs:
				pushRows.length > 0
					? Math.min(...pushRows.map((row) => row.at.getTime()))
					: null,
			pushTruncated,
		};
		const lifecycle = {
			createdAtMs: run.createdAt.getTime(),
			...startStepTimes(run.stepLog),
			...(run.runningSince ? { runningAtMs: run.runningSince.getTime() } : {}),
			...(run.endedAt ? { endedAtMs: run.endedAt.getTime() } : {}),
		};
		const windowStart = new Date(
			lifecycle.requestedAtMs ?? lifecycle.createdAtMs,
		);
		const windowEnd = run.endedAt ?? new Date(nowMs);
		// : inserted-content actions THROUGH US, two records —
		// (a) the C7 audit rows of the schedule/stop proxy calls, keyed by the
		// run's OWN encoding id (each run gets a fresh encoding, so this is
		// run-scoped for free); (b) scheduler SLATE_IN rows that actually
		// FIRED (the worker path never crosses the web audit, so firedAt is
		// its only record). Three honesty rules from review-294:
		//   C2 — only paths ending /schedule are inserts: the content
		//        REGISTRATION call shares the prefix and registering a clip
		//        is not playing one.
		//   I2 — a schedule the operator CANCELLED (DELETE …/schedule/{id},
		//        matched via the POST's response.id) never happened; one
		//        whose runAt lies beyond the window's end never aired (a
		//        still-live run re-admits it once now passes runAt).
		//   The event time is the redacted request's runAt when present,
		//   else the call time.
		// Detailed lifecycle events:
		//   STOP_REQUESTED / RESTART_REQUESTED — audit rows of POST
		//   …/live/stop|restart. The WORKER's Bitmovin calls are audited
		//   into this same table (an earlier revision claimed otherwise —
		//   wrong), so operator, scheduler and maxRunMinutes-cap actions all
		//   land here uniformly at their true execution times. That is also
		//   why there is NO LiveSchedule.firedAt source anymore: the fired
		//   action's own audit row covers it, and reading both painted every
		//   scheduler slate/stop twice (self-caught while review-296 ran).
		//   The INVARIANT (review-296): one record per real event; where two
		//   records describe one event, the AUDIT row is canonical. SCTE35_CUE
		//   is the one stated exception: the worker appends the step-log record
		//   (with the cue payload) AND audits the same cue — the step record
		//   wins and the /live/scte-35-cue audit row is a deliberately ignored
		//   twin. /live/start is likewise ignored as START_REQUESTED's twin —
		//   distinct from unknown-suffix ignores.
		//   ESAM_SIGNAL — the audit row of …/live/esam/media-points, the
		//   SINGLE source. The first cut claimed the step log's
		//   ESAM_MEDIA_POINT records were a disjoint worker-fired source —
		//   false both ways (review-296 I8, demonstrated): no worker ESAM path
		//   exists (exec-live THROWS for the kind), and the one web writer
		//   records TWICE by its own docstring (audit + step entry), so
		//   harvesting both painted one media point as two dots whenever a
		//   later SCTE/slate mirrored the channel log onto the run.
		//   TIMESHIFT_RESET — …/live/reset-live-manifest-timeshift (a DVR
		//   shrink changes what viewers can seek to; review-296 S2).
		//   STOP/RESTART requests count REGARDLESS of statusCode: the REQUEST
		//   is the event (review-296 — a FAILED stop otherwise rendered
		//   ENCODER_STOPPED with no explanation, the exact gap this feature
		//   exists to explain). Content/ESAM/timeshift actions keep the 2xx
		//   gate — a refused action never happened.
		const actions: RunTimelineAction[] = [];
		let actionsTruncated = false;
		if (run.bitmovinEncodingId) {
			const livePrefix = `/encodings/${run.bitmovinEncodingId}/live/`;
			// review-296 I6: classification lives in the WHERE — with a shared
			// 100-row cap, ignored rows (an ad-heavy run's SCTE audit twins)
			// would fill the window and slice off the chronologically-last stop.
			const auditRowsRaw = await ctx.prisma.auditLog.findMany({
				where: {
					method: { in: ["POST", "DELETE"] },
					at: { gte: windowStart, lte: windowEnd },
					OR: [
						{ path: { endsWith: `${livePrefix}stop` } },
						{ path: { endsWith: `${livePrefix}restart` } },
						{
							path: {
								endsWith: `${livePrefix}reset-live-manifest-timeshift`,
							},
						},
						{ path: { endsWith: `${livePrefix}esam/media-points` } },
						{ path: { contains: `${livePrefix}insertable-content/` } },
					],
				},
				select: {
					at: true,
					method: true,
					path: true,
					statusCode: true,
					request: true,
					response: true,
				},
				orderBy: { at: "asc" },
				take: MAX_ACTION_ROWS + 1,
			});
			actionsTruncated = auditRowsRaw.length > MAX_ACTION_ROWS;
			const auditRows = actionsTruncated
				? auditRowsRaw.slice(0, MAX_ACTION_ROWS)
				: auditRowsRaw;
			const ok2xx = (row: { statusCode: number | null }) =>
				row.statusCode !== null &&
				row.statusCode >= 200 &&
				row.statusCode < 300;
			const cancelledIds = new Set<string>();
			for (const row of auditRows) {
				// review-296 I9: a REFUSED cancel (the slate aired anyway) must
				// not erase the insert — only a cancel Bitmovin ACCEPTED cancels.
				if (row.method !== "DELETE" || !ok2xx(row)) {
					continue;
				}
				const scheduledId = row.path.split("/schedule/")[1];
				if (scheduledId) {
					cancelledIds.add(scheduledId);
				}
			}
			for (const row of auditRows) {
				if (row.method !== "POST") {
					continue;
				}
				// Suffix classification (C2's discipline: anything unrecognised
				// is ignored, never guessed into an event).
				if (row.path.endsWith("/live/stop")) {
					actions.push({ atMs: row.at.getTime(), kind: "STOP_REQUESTED" });
					continue;
				}
				if (row.path.endsWith("/live/restart")) {
					actions.push({ atMs: row.at.getTime(), kind: "RESTART_REQUESTED" });
					continue;
				}
				if (row.path.endsWith("/live/reset-live-manifest-timeshift")) {
					if (ok2xx(row)) {
						actions.push({ atMs: row.at.getTime(), kind: "TIMESHIFT_RESET" });
					}
					continue;
				}
				if (row.path.endsWith("/live/esam/media-points")) {
					if (ok2xx(row)) {
						actions.push({ atMs: row.at.getTime(), kind: "ESAM_SIGNAL" });
					}
					continue;
				}
				if (row.path.endsWith("/insertable-content/stop")) {
					if (ok2xx(row)) {
						actions.push({ atMs: row.at.getTime(), kind: "CONTENT_STOPPED" });
					}
					continue;
				}
				if (!row.path.endsWith("/schedule") || !ok2xx(row)) {
					continue;
				}
				const scheduledId = (row.response as { id?: string } | null)?.id;
				if (scheduledId && cancelledIds.has(scheduledId)) {
					continue;
				}
				const runAtRaw = (row.request as { runAt?: string } | null)?.runAt;
				const runAtMs = runAtRaw ? Date.parse(runAtRaw) : Number.NaN;
				const atMs = Number.isFinite(runAtMs) ? runAtMs : row.at.getTime();
				if (atMs > windowEnd.getTime()) {
					continue;
				}
				actions.push({ atMs, kind: "CONTENT_INSERTED" });
			}
		}
		// The step log's runtime records — SCTE-35 ONLY (its audit twin is
		// ignored above; ESAM's step entry is the audit row's twin in the
		// OTHER direction and is skipped here — review-296 I8).
		if (Array.isArray(run.stepLog)) {
			for (const entry of run.stepLog) {
				const e = entry as {
					kind?: string;
					status?: string;
					startedAt?: string;
				} | null;
				if (e?.kind !== "SCTE35_CUE" || e.status !== "DONE") {
					continue;
				}
				const atMs = e.startedAt ? Date.parse(e.startedAt) : Number.NaN;
				if (!Number.isFinite(atMs)) {
					continue;
				}
				actions.push({ atMs, kind: "SCTE35_CUE" });
			}
		}
		const timeline = deriveRunTimeline({
			lifecycle,
			lanes: health.lanes,
			points: health.points,
			actions,
			// The same binding the lanes were derived with, by construction.
			spanGapMs,
		});
		const body: RunHealthResponse = {
			...health,
			run: {
				id: run.id,
				seq: run.seq,
				status: run.status,
				createdAt: run.createdAt.toISOString(),
				queueSeconds: run.queueSeconds,
			},
			truncated,
			outputObservable,
			timeline,
			actionsTruncated,
			laneSources,
		};
		return NextResponse.json(body);
	} catch (err) {
		return routeError(err);
	}
}
