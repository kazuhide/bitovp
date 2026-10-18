import {
	type ProviderHeartbeatEvent,
	parseRunHeartbeatSummary,
	providerHeartbeatEvents,
	type RunHeartbeatSummary,
} from "@bitovp/core";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerContext } from "@/lib/server/context";
import {
	invalidIdResponse,
	jsonError,
	routeError,
	validationError,
} from "@/lib/server/http";

type RouteParams = { params: Promise<{ id: string; runId: string }> };

/** Rows per page; the query is `take: limit + 1` so a full page is not "the end". */
export const HEARTBEAT_LOG_PAGE_MAX = 500;
const HEARTBEAT_LOG_PAGE_DEFAULT = 200;

const querySchema = z
	.object({
		/** Inclusive lower bound on the poll time (ISO). */
		from: z.iso.datetime({ offset: true }).optional(),
		/** Inclusive upper bound on the poll time (ISO). */
		to: z.iso.datetime({ offset: true }).optional(),
		/** The `id` of the last row of the previous page (`nextCursor`). */
		cursor: z.uuid().optional(),
		limit: z.coerce
			.number()
			.int()
			.min(1)
			.max(HEARTBEAT_LOG_PAGE_MAX)
			.default(HEARTBEAT_LOG_PAGE_DEFAULT),
	})
	.refine(
		(value) =>
			!value.from ||
			!value.to ||
			Date.parse(value.from) <= Date.parse(value.to),
		{ message: "from must not be after to", path: ["from"] },
	);

/** One persisted poll, as the log table and the raw drawer read it. */
export type HeartbeatLogRow = {
	id: string;
	/** Poll time (ours), ISO. */
	at: string;
	/** The redacted provider sample — every field, known to the UI or not. */
	raw: unknown;
	/** The worker's per-poll counter deltas. */
	deltas: unknown;
};

export type HeartbeatLogResponse = {
	run: {
		id: string;
		seq: number;
		status: string;
		createdAt: string;
		endedAt: string | null;
		/** Present once the sweep summarized the ended run (7-day retention). */
		summary: RunHeartbeatSummary | null;
	};
	rows: HeartbeatLogRow[];
	/** Absent = the last page. A short page is NOT the end (constraint C6). */
	nextCursor?: string;
	/**
	 * The provider's cumulative event list as the run's NEWEST sample carries
	 * it (deduped) — the "persistent event list", sent with the FIRST page
	 * only so a paging client does not re-download it. It covers the current
	 * encoder's lifetime; a restart resets the provider's list, and the union
	 * across every row lives in `run.summary.events` once the run has ended.
	 */
	latestEvents?: ProviderHeartbeatEvent[];
};

/**
 * The per-run heartbeat LOG: every persisted poll of ONE run, oldest first,
 * paged by row id, optionally windowed by poll time. Rows are returned as
 * persisted — `raw` is the redacted provider sample in full, so a field the
 * UI does not know still reaches the operator through the raw drawer.
 *
 * Channel-scoped: the run must belong to the channel in the path, and the
 * row query carries both ids, so a foreign run id is a 404 and never another
 * channel's samples. OPERATOR floor (`ROUTE_RULES`): the log is diagnostic
 * detail, above the VIEWER read floor the channel page itself has.
 */
export async function GET(req: Request, { params }: RouteParams) {
	const { id, runId } = await params;
	const invalid = invalidIdResponse(id) ?? invalidIdResponse(runId);
	if (invalid) {
		return invalid;
	}
	const url = new URL(req.url);
	const parsed = querySchema.safeParse({
		from: url.searchParams.get("from") ?? undefined,
		to: url.searchParams.get("to") ?? undefined,
		cursor: url.searchParams.get("cursor") ?? undefined,
		limit: url.searchParams.get("limit") ?? undefined,
	});
	if (!parsed.success) {
		return validationError(parsed.error);
	}
	const { from, to, cursor, limit } = parsed.data;
	try {
		const ctx = await getServerContext();
		const run = await ctx.prisma.liveChannelRun.findFirst({
			where: { id: runId, liveChannelId: id },
			select: {
				id: true,
				seq: true,
				status: true,
				createdAt: true,
				endedAt: true,
				heartbeatSummary: true,
			},
		});
		if (!run) {
			return jsonError(404, "run not found on this channel");
		}
		const where = {
			liveChannelId: id,
			liveChannelRunId: runId,
			...(from || to
				? {
						at: {
							...(from ? { gte: new Date(from) } : {}),
							...(to ? { lte: new Date(to) } : {}),
						},
					}
				: {}),
		};
		const rows = await ctx.prisma.liveHeartbeat.findMany({
			where,
			// `at` then `id`: two polls cannot share a poll time on one run, but
			// the tiebreak keeps the cursor total if one ever does.
			// A `cursor` must come from a page of the SAME `from`/`to` window
			// (every cursor this route hands back does): Prisma applies
			// `skip: 1` to the filtered result, so a cursor row that falls
			// outside the window would cost the window's first row instead
			// of the cursor row (rev409 O2). The panel never mixes them.
			orderBy: [{ at: "asc" }, { id: "asc" }],
			take: limit + 1,
			...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
			select: { id: true, at: true, raw: true, deltas: true },
		});
		const page = rows.slice(0, limit);
		const body: HeartbeatLogResponse = {
			run: {
				id: run.id,
				seq: run.seq,
				status: run.status,
				createdAt: run.createdAt.toISOString(),
				endedAt: run.endedAt?.toISOString() ?? null,
				summary: parseRunHeartbeatSummary(run.heartbeatSummary),
			},
			rows: page.map((row) => ({
				id: row.id,
				at: row.at.toISOString(),
				raw: row.raw,
				deltas: row.deltas,
			})),
			...(rows.length > limit ? { nextCursor: page[page.length - 1]?.id } : {}),
		};
		if (!cursor) {
			// The newest sample of the WHOLE run (un-windowed): its cumulative
			// events[] is the event list as of the last poll.
			const newest = await ctx.prisma.liveHeartbeat.findFirst({
				where: { liveChannelId: id, liveChannelRunId: runId },
				orderBy: [{ at: "desc" }, { id: "desc" }],
				select: { raw: true },
			});
			body.latestEvents = newest ? providerHeartbeatEvents(newest.raw) : [];
		}
		return NextResponse.json(body);
	} catch (err) {
		return routeError(err);
	}
}
