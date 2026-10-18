import "server-only";
import type { AppPrismaClient } from "@bitovp/db";

/**
 * The newest `LiveChannelRun` per channel, in ONE query whose per-channel row
 * count is bounded BY THE SQL — .
 *
 * The defect this replaces: both fleet reads asked Prisma for
 * `runs: { orderBy: { seq: "desc" }, take: 1, select: {…} }` and described it
 * as "one query, not a fetch per row". The round trip really is one. The
 * VOLUME is not: `packages/db/prisma/schema.prisma` does not enable
 * `previewFeatures = ["relationJoins"]`, and Prisma's default relation
 * strategy does not push a nested to-many `take` into SQL (prisma/prisma#16168
 * — maintainer-confirmed: fetch all of modelB, then pick the first N per
 * modelA in the engine). Read off Prisma's own query log on this tree against
 * the compose Postgres, the second statement the list route's page of 51
 * channels emitted was (table qualifiers elided for width):
 *
 *     SELECT "id", "lastHeartbeat", "runningSince", "endedAt",
 *            "originObservation", "liveChannelId"
 *     FROM "public"."LiveChannelRun"
 *     WHERE "liveChannelId" IN ($1,…,$51)
 *     ORDER BY "seq" DESC OFFSET $52
 *
 * — an OFFSET with no LIMIT anywhere. Every airing every channel on the page
 * has ever had is read, `lastHeartbeat` (1.3 kB average on the dev database)
 * and `originObservation` (0.6 kB) included, and all but one row per channel
 * is thrown away in the engine. The live list polls this every 10 s while any
 * channel is active, and a channel accrues one run per re-air forever.
 *
 * WHY LATERAL AND NOT `DISTINCT ON`. Both bound what CROSSES to Node; only
 * LATERAL bounds what Postgres READS, because the per-channel `LIMIT 1` is the
 * thing Prisma failed to push down and `DISTINCT ON` has no per-group limit to
 * push. Measured 2026-08-29 on a throwaway database — a table with this
 * model's columns and its `@@unique([liveChannelId, seq])` index, 200 channels
 * × 30 runs = 6,000 rows, JSON sized like the dev database's — for a page of
 * 51 channels, `EXPLAIN (ANALYZE, BUFFERS)`:
 *
 *   today (nested take:1)            1,530 rows scanned  1,503 buffers  5.075 ms
 *   DISTINCT ON, JSON in the SELECT  1,530 rows sorted   1,503 buffers  2.089 ms
 *                                    (quicksort, 3 MB — the JSON goes into the sort)
 *   LATERAL … ORDER BY seq DESC LIMIT 1   51 rows          153 buffers  0.122 ms
 *
 * `DISTINCT ON` planned as Seq Scan → Sort → Unique: it RETURNS 51 rows after
 * reading and sorting all 1,530, so it fixes the wire and leaves the read.
 * Reordering it to match the index (`ORDER BY "liveChannelId" DESC, "seq"
 * DESC`, which a backward index scan could satisfy) did not help either —
 * still a Sort over 1,530 rows, 4.243 ms. The LATERAL form planned as one
 * `Index Scan Backward … Limit 1` per channel on that unique index, which is
 * O(page), not O(history).
 *
 * WHAT WAS DELIBERATELY NOT DONE: `previewFeatures = ["relationJoins"]` would
 * fix the nested `take` in place, and it changes the join strategy of EVERY
 * relation query in the app. That is its own measured decision, not a
 * side-effect of this one.
 *
 * A channel with no runs yields no row and is simply absent from the map —
 * callers already treat "no run" as the presence-level answer (review-243 R1:
 * a channel that has never aired reads as "not started", never as the previous
 * airing's afterglow).
 */

/** The newest run of one channel, projected to what the fleet reads. */
export type LatestRun = {
	id: string;
	liveChannelId: string;
	/** Per-channel airing number — what picks the winner, so it is returned. */
	seq: number;
	lastHeartbeat: unknown;
	runningSince: Date | null;
	endedAt: Date | null;
	originObservation: unknown;
	providerStatus: string | null;
	providerStatusObservedAt: Date | null;
	providerUnknownSince: Date | null;
	providerTerminalAt: Date | null;
};

/**
 * One row per channel id, keyed by `liveChannelId`. Ids with no run are absent.
 *
 * The projection is FIXED rather than per-caller: two callers, one statement,
 * one shape to pin. The dashboard reads only `lastHeartbeat` and therefore
 * carries `originObservation` it discards — a bounded constant per RUNNING
 * channel, which is the property being bought here, in place of an unbounded
 * number of heartbeat blobs.
 */
export async function latestRunsFor(
	prisma: AppPrismaClient,
	channelIds: readonly string[],
): Promise<Map<string, LatestRun>> {
	// No ids, no round trip: an empty page must not become `unnest('{}')`.
	if (channelIds.length === 0) {
		return new Map();
	}
	/*
	 * Tagged template: the id list crosses as ONE bound `uuid[]` parameter, so
	 * nothing here is assembled from a value. `unnest` turns it into the
	 * driving side of the LATERAL join, which is what gives each channel its
	 * own `LIMIT 1`.
	 */
	const rows = await prisma.$queryRaw<LatestRun[]>`
		SELECT newest."liveChannelId", newest."id", newest."seq",
			newest."lastHeartbeat", newest."runningSince", newest."endedAt",
			newest."originObservation", newest."providerStatus",
			newest."providerStatusObservedAt", newest."providerUnknownSince",
			newest."providerTerminalAt"
		FROM unnest(${[...channelIds]}::uuid[]) AS channel(id)
		CROSS JOIN LATERAL (
			SELECT r."liveChannelId", r."id", r."seq", r."lastHeartbeat",
				r."runningSince", r."endedAt", r."originObservation",
				r."providerStatus", r."providerStatusObservedAt",
				r."providerUnknownSince", r."providerTerminalAt"
			FROM "LiveChannelRun" r
			WHERE r."liveChannelId" = channel.id
			ORDER BY r."seq" DESC
			LIMIT 1
		) AS newest
	`;
	const byChannel = new Map<string, LatestRun>();
	for (const row of rows) {
		byChannel.set(row.liveChannelId, row);
	}
	return byChannel;
}
