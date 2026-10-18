import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 *  PR2, review-185 I2: the row whitelist is the only thing
 * keeping this response narrow — pinned here so a widened mapping (job
 * opts, stacktrace, raw data fields beyond the union's kind/occurredAt/
 * link) goes RED instead of quietly shipping.
 */

const getFailed = vi.fn();
const getCompleted = vi.fn();
vi.mock("@/lib/server/queue", () => ({
	getNotifyQueue: () => ({ getFailed, getCompleted }),
}));

import { GET } from "./route";

beforeEach(() => {
	vi.clearAllMocks();
	getFailed.mockResolvedValue([
		{
			id: "j1",
			data: {
				kind: "JOB_ERROR",
				occurredAt: "2026-08-12T00:00:00.000Z",
				link: "https://ovp.example.com/vod/jobs/x",
				// Fields a widened mapping might leak:
				jobId: "secret-adjacent",
				error: "boom",
			},
			attemptsMade: 5,
			failedReason: "notify delivery failed for ops hook (HTTP 500)",
			opts: { attempts: 5 },
			stacktrace: ["at doFetch (https://hooks.example.com/services/T/B/X)"],
		},
	]);
	getCompleted.mockResolvedValue([
		{
			id: "j2",
			data: { kind: "JOB_FINISHED", occurredAt: "t", link: "l" },
			attemptsMade: 1,
		},
	]);
});

describe("GET /api/notifications/deliveries", () => {
	it("maps the whitelist and NOTHING else — no opts, stacktrace, or payload tails", async () => {
		const res = await GET();
		const body = (await res.json()) as {
			failed: Record<string, unknown>[];
			completed: Record<string, unknown>[];
		};
		expect(body.failed[0]).toEqual({
			id: "j1",
			state: "FAILED",
			kind: "JOB_ERROR",
			occurredAt: "2026-08-12T00:00:00.000Z",
			link: "https://ovp.example.com/vod/jobs/x",
			attemptsMade: 5,
			failedReason: "notify delivery failed for ops hook (HTTP 500)",
		});
		expect(body.completed[0]).toEqual({
			id: "j2",
			state: "DELIVERED",
			kind: "JOB_FINISHED",
			occurredAt: "t",
			link: "l",
			attemptsMade: 1,
			failedReason: null,
		});
		// The stacktrace carried the vault URL in this fixture — the response
		// must not (review-185 N5's residual, made structural).
		expect(JSON.stringify(body)).not.toContain("hooks.example.com");
	});

	it("requests the newest 20 of each state", async () => {
		await GET();
		expect(getFailed).toHaveBeenCalledWith(0, 19);
		expect(getCompleted).toHaveBeenCalledWith(0, 19);
	});
});
