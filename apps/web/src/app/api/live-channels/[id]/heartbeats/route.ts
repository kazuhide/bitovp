import { NextResponse } from "next/server";
import { getServerContext } from "@/lib/server/context";
import {
	downsampleHeartbeats,
	type HeartbeatHistoryPoint,
	type PushHeartbeatSample,
	projectHeartbeatRow,
	pushHeartbeatPoints,
} from "@/lib/server/heartbeat-history";
import { invalidIdResponse, routeError } from "@/lib/server/http";

type RouteParams = { params: Promise<{ id: string }> };

/** Default lookback for the trend chart (minutes). */
const DEFAULT_WINDOW_MINUTES = 120;
/**
 * Hard cap on the lookback. Retention is 7 days now (2026-09-02), so this is
 * a CHART bound, not the table's: the trend chart is the on-air readout and
 * six hours is as far back as a downsampled 500-point line stays legible;
 * the per-run heartbeat log is the surface for anything older.
 */
const MAX_WINDOW_MINUTES = 360;

export type HeartbeatHistoryResponse = {
	windowMinutes: number;
	points: HeartbeatHistoryPoint[];
	/**
	 * Which source the points came from. Push (~2s) supersedes poll (~30s) for
	 * the run(s) in view when present: the two carry the same fields, so mixing
	 * their per-sample deltas on one axis would fake spikes at the 30s samples.
	 * Push points fall back to poll when no verified push receipt exists.
	 */
	source: "push" | "poll";
};

/**
 * Bounded push read: WebhookEvent has no (liveChannelRunId) index yet, so a
 * take caps the scan. The 360-minute max window at the 2s push cadence is
 * ~10,800 samples, so the cap sits just above that: a fully-covered window is
 * never truncated. A run-scoped (un-windowed) view of a run longer than the cap
 * reads as truncated and falls back to the complete poll series (see GET),
 * rather than superseding poll with a push series that drops the run's tail.
 */
const MAX_PUSH_ROWS = 11_000;

/** Parse a verified push receipt into a heartbeat sample (`value` is the body). */
function pushSampleFromRaw(
	raw: unknown,
	receivedAt: Date,
): PushHeartbeatSample | null {
	const envelope =
		raw !== null && typeof raw === "object"
			? (raw as Record<string, unknown>)
			: null;
	const value =
		envelope && typeof envelope.value === "object" && envelope.value !== null
			? envelope.value
			: null;
	if (!value) {
		return null;
	}
	const timestamp = (value as Record<string, unknown>).timestamp;
	const ms = typeof timestamp === "string" ? Date.parse(timestamp) : Number.NaN;
	return { at: Number.isFinite(ms) ? new Date(ms) : receivedAt, value };
}

function parseWindowMinutes(raw: string | null): number {
	const parsed = raw === null ? Number.NaN : Number(raw);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		return DEFAULT_WINDOW_MINUTES;
	}
	return Math.min(Math.floor(parsed), MAX_WINDOW_MINUTES);
}

/**
 * Heartbeat history for the dashboard trend chart: the channel's recent
 * LiveHeartbeat rows within `windowMinutes` (default 120, cap 360), ordered by
 * `at`, projected to per-poll delta series + ingest status + a representative
 * bitrate/fps, and downsampled past HEARTBEAT_POINT_CAP so a spike always
 * survives. Secret-free (the rows are already redacted). Empty window → [].
 */
export async function GET(req: Request, { params }: RouteParams) {
	const { id } = await params;
	const invalid = invalidIdResponse(id);
	if (invalid) {
		return invalid;
	}
	try {
		const url = new URL(req.url);
		const windowMinutes = parseWindowMinutes(
			url.searchParams.get("windowMinutes"),
		);
		// Run-scoped review : a FINISHED run's
		// samples, un-windowed — the post-mortem needs the whole run, not the
		// last 2h relative to NOW (which for an old run is empty). Still
		// channel-scoped so a foreign run id reads as no rows, never a leak.
		// Retention caveat (verified against live-processor's prune, not
		// hearsay): each poll prunes THIS CHANNEL's rows older than 7 days
		// relative to the new sample, in capped batches. So with no later run
		// the samples persist indefinitely; once a later run polls, anything
		// older than 7 days of that newest sample drains over the next few
		// sweeps — and the run's `heartbeatSummary` outlives its rows.
		const runId = url.searchParams.get("runId");
		const invalidRun = runId ? invalidIdResponse(runId) : null;
		if (invalidRun) {
			return invalidRun;
		}
		const since = new Date(Date.now() - windowMinutes * 60_000);
		const ctx = await getServerContext();
		const rows = await ctx.prisma.liveHeartbeat.findMany({
			where: runId
				? { liveChannelId: id, liveChannelRunId: runId }
				: { liveChannelId: id, at: { gte: since } },
			orderBy: { at: "asc" },
			select: { at: true, raw: true, deltas: true, liveChannelRunId: true },
		});
		// Push supersedes poll for the run(s) in view when any verified receipt
		// exists (finer 2s cadence, same fields). Runs come from the poll rows,
		// so no push read runs when the channel never polled these runs.
		const runIds = runId
			? [runId]
			: [
					...new Set(
						rows
							.map((row) => row.liveChannelRunId)
							.filter((value): value is string => value !== null),
					),
				];
		let points: HeartbeatHistoryPoint[] | null = null;
		let source: HeartbeatHistoryResponse["source"] = "poll";
		if (runIds.length > 0) {
			const pushRows = await ctx.prisma.webhookEvent.findMany({
				where: {
					eventType: "LIVE_ENCODING_HEARTBEAT",
					signatureValid: true,
					liveChannelRunId: { in: runIds },
					...(runId ? {} : { receivedAt: { gte: since } }),
				},
				orderBy: { receivedAt: "asc" },
				take: MAX_PUSH_ROWS + 1,
				select: { raw: true, receivedAt: true },
			});
			// A truncated push read would supersede poll with an incomplete
			// series (dropping the tail), so only supersede when push is whole.
			if (pushRows.length <= MAX_PUSH_ROWS) {
				const samples = pushRows
					.map((row) => pushSampleFromRaw(row.raw, row.receivedAt))
					.filter((value): value is PushHeartbeatSample => value !== null);
				if (samples.length > 0) {
					points = downsampleHeartbeats(pushHeartbeatPoints(samples));
					source = "push";
				}
			}
		}
		if (points === null) {
			points = downsampleHeartbeats(rows.map(projectHeartbeatRow));
		}
		const payload: HeartbeatHistoryResponse = { windowMinutes, points, source };
		return NextResponse.json(payload);
	} catch (err) {
		return routeError(err);
	}
}
