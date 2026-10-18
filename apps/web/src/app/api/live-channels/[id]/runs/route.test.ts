import { beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.fn();
vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({
		prisma: { liveChannelRun: { findMany } },
	}),
}));

import { GET } from "./route";

const ID = "00000000-0000-4000-8000-0000000000e1";

beforeEach(() => vi.clearAllMocks());

describe("GET /api/live-channels/[id]/runs (ledger #108 PR4)", () => {
	it("lists the run history newest-first, C6-capped, lean select", async () => {
		findMany.mockResolvedValueOnce([
			{ id: "r2", seq: 2, status: "RUNNING" },
			{ id: "r1", seq: 1, status: "STOPPED" },
		]);
		const res = await GET(new Request("http://test"), {
			params: Promise.resolve({ id: ID }),
		});
		expect(res.status).toBe(200);
		const args = findMany.mock.calls[0]?.[0] as {
			orderBy: unknown;
			take: number;
			select: Record<string, boolean>;
		};
		expect(args.orderBy).toEqual({ seq: "desc" });
		expect(args.take).toBe(100);
		// Lean: assert the ALLOWED set, not a deny-list of two names —
		// review-245 measured the deny-list's blind spot (a planted
		// liveToVod: true stayed GREEN while the list got heavy). The
		// enumerate-vs-name lesson, applied to a select.
		expect(Object.keys(args.select).sort()).toEqual(
			[
				"id",
				"seq",
				"status",
				"bitmovinEncodingId",
				"outputPrefix",
				"runningSince",
				"endedAt",
				// #160 PR1: the sampler's per-run queue time rides the history.
				"queueSeconds",
				"programStartAt",
				"programEndAt",
				"error",
				"lastHeartbeatAt",
				"createdAt",
			].sort(),
		);
		const json = (await res.json()) as { runs: { seq: number }[] };
		expect(json.runs.map((r) => r.seq)).toEqual([2, 1]);
	});

	it("400s a non-UUID id before touching the DB", async () => {
		const res = await GET(new Request("http://test"), {
			params: Promise.resolve({ id: "nope" }),
		});
		expect(res.status).toBe(400);
		expect(findMany).not.toHaveBeenCalled();
	});
});
