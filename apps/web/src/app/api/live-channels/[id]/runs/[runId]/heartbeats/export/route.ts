import { parseRunHeartbeatSummary } from "@bitovp/core";
import { getServerContext } from "@/lib/server/context";
import { invalidIdResponse, jsonError, routeError } from "@/lib/server/http";

type RouteParams = { params: Promise<{ id: string; runId: string }> };

/** Rows read per database round-trip while streaming. */
export const HEARTBEAT_EXPORT_BATCH = 500;

/**
 * The run's heartbeat log as ONE JSON document, streamed: a header with the
 * channel/run identity and the run's summary, then every persisted poll
 * `{ id, at, raw, deltas }` oldest first, read in `HEARTBEAT_EXPORT_BATCH`
 * batches by row id so a 7-day run (~20k rows, ~23 MB) never sits in memory
 * whole. Served as a file download; ADMIN floor (`ROUTE_RULES`) — a bulk
 * pull of the provider's telemetry is an admin act, and the route is listed
 * in `docs/API-USAGE.md` for that reason.
 *
 * Rows are the redacted samples as persisted (the worker's `redactSecrets`
 * pass; measured: `rtmpUserIngestInfo.streamKey` lands as `[REDACTED]`), so
 * nothing here re-redacts — and nothing here may add a field the store does
 * not carry.
 */
export async function GET(_req: Request, { params }: RouteParams) {
	const { id, runId } = await params;
	const invalid = invalidIdResponse(id) ?? invalidIdResponse(runId);
	if (invalid) {
		return invalid;
	}
	try {
		const ctx = await getServerContext();
		const run = await ctx.prisma.liveChannelRun.findFirst({
			where: { id: runId, liveChannelId: id },
			select: {
				id: true,
				seq: true,
				status: true,
				bitmovinEncodingId: true,
				createdAt: true,
				runningSince: true,
				endedAt: true,
				heartbeatSummary: true,
			},
		});
		if (!run) {
			return jsonError(404, "run not found on this channel");
		}
		const prisma = ctx.prisma;
		const encoder = new TextEncoder();
		const head = JSON.stringify({
			channelId: id,
			run: {
				id: run.id,
				seq: run.seq,
				status: run.status,
				bitmovinEncodingId: run.bitmovinEncodingId,
				createdAt: run.createdAt.toISOString(),
				runningSince: run.runningSince?.toISOString() ?? null,
				endedAt: run.endedAt?.toISOString() ?? null,
				summary: parseRunHeartbeatSummary(run.heartbeatSummary),
			},
			exportedAt: new Date().toISOString(),
		});
		const stream = new ReadableStream<Uint8Array>({
			async start(controller) {
				try {
					// `{"channelId":…,"run":{…},"rows":[` — the head minus its
					// closing brace, then the rows, then `]}`.
					controller.enqueue(encoder.encode(`${head.slice(0, -1)},"rows":[`));
					let cursor: string | undefined;
					let first = true;
					for (;;) {
						const rows = await prisma.liveHeartbeat.findMany({
							where: { liveChannelId: id, liveChannelRunId: runId },
							orderBy: [{ at: "asc" }, { id: "asc" }],
							take: HEARTBEAT_EXPORT_BATCH,
							...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
							select: { id: true, at: true, raw: true, deltas: true },
						});
						for (const row of rows) {
							const line = JSON.stringify({
								id: row.id,
								at: row.at.toISOString(),
								raw: row.raw,
								deltas: row.deltas,
							});
							controller.enqueue(encoder.encode(first ? line : `,${line}`));
							first = false;
						}
						if (rows.length < HEARTBEAT_EXPORT_BATCH) {
							break;
						}
						cursor = rows[rows.length - 1]?.id;
					}
					controller.enqueue(encoder.encode("]}"));
					controller.close();
				} catch (err) {
					controller.error(err);
				}
			},
		});
		const stem = `heartbeats-${id.slice(0, 8)}-run${run.seq}`;
		return new Response(stream, {
			status: 200,
			headers: {
				"content-type": "application/json; charset=utf-8",
				"content-disposition": `attachment; filename="${stem}.json"`,
				"cache-control": "no-store",
			},
		});
	} catch (err) {
		return routeError(err);
	}
}
