import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 *  PR2, review-185 I2: the row whitelist is the only thing
 * keeping this response narrow — pinned here so a widened mapping (job
 * opts, stacktrace, raw data fields beyond the union's kind/occurredAt/
 * link) goes RED instead of quietly shipping.
 */

const findMany = vi.fn();
vi.mock("@/lib/server/context", () => ({
	getServerContext: async () => ({
		prisma: { liveStopNotification: { findMany } },
	}),
}));
const getFailed = vi.fn();
const getCompleted = vi.fn();
vi.mock("@/lib/server/queue", () => ({
	getNotifyQueue: () => ({ getFailed, getCompleted }),
}));

import { GET } from "./route";

beforeEach(() => {
	vi.clearAllMocks();
	findMany.mockResolvedValue([]);
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
			returnvalue: { delivery: "DELIVERED" },
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

	it("keeps old queue acknowledgements unconfirmed and omits events with no subscription", async () => {
		getCompleted.mockResolvedValue([
			{
				id: "legacy",
				data: { kind: "CHANNEL_STOPPED" },
				returnvalue: { acknowledged: true, queue: "notify" },
			},
			{
				id: "skipped",
				data: { kind: "CHANNEL_STOPPED" },
				returnvalue: { delivery: "NO_DESTINATION" },
			},
		]);
		const { completed } = await (await GET()).json();
		expect(completed).toMatchObject([{ id: "legacy", state: "UNCONFIRMED" }]);
	});
	it("keeps a prior delivery visible after a page with only unmatched subscriptions", async () => {
		getCompleted
			.mockResolvedValueOnce(
				Array.from({ length: 20 }, (_, i) => ({
					id: "skip" + i,
					returnvalue: { delivery: "NO_DESTINATION" },
				})),
			)
			.mockResolvedValueOnce([
				{
					id: "prior",
					returnvalue: { delivery: "DELIVERED" },
					data: { kind: "CHANNEL_STOPPED" },
				},
			]);
		expect((await (await GET()).json()).completed).toMatchObject([
			{ id: "prior", state: "DELIVERED" },
		]);
	});
	it("projects a historical diagnostic rather than returning its storage authorization", async () => {
		getFailed.mockResolvedValueOnce([
			{
				id: "j1",
				failedReason: "fetch https://storage.invalid/?auth=PRIVATE_FIXTURE",
			},
		]);
		const res = await GET();
		expect((await res.json()).failed[0].failedReason).toBe("[withheld]");
	});

	it("requests the newest 20 of each state", async () => {
		await GET();
		expect(getFailed).toHaveBeenCalledWith(0, 19);
		expect(getCompleted).toHaveBeenCalledWith(0, 19);
	});
});

it("merges retained STOP receipts and queue jobs by completion time, breaking ties by descending ID", async () => {
	const occurredAt = new Date("2026-11-25T00:00:00.000Z");
	const finished = (seconds: number) =>
		new Date(occurredAt.getTime() + seconds * 1000);
	const record = (id: string, seconds: number) => ({
		id,
		channelId: "channel",
		kind: "CHANNEL_STOPPED",
		occurredAt,
		finishedAt: finished(seconds),
		failureReason: null,
		failures: 2,
		leaseToken: "private",
		channelName: "unneeded",
	});
	findMany.mockImplementation(async (q) =>
		q.where.failureReason === null
			? [record("z", 40), record("a", 40)]
			: [
					{
						...record("f", 30),
						failures: 5,
						failureReason: "Webhook delivery failed (HTTP 500)",
					},
				],
	);
	getCompleted.mockResolvedValue(
		Array.from({ length: 20 }, (_, i) => ({
			id: "job-" + String(20 - i).padStart(2, "0"),
			finishedOn: finished(39 - i).getTime(),
			attemptsMade: 1,
			data: {
				kind: "JOB_FINISHED",
				occurredAt: finished(90 + i).toISOString(),
			},
		})),
	);
	getFailed.mockResolvedValue([
		{
			id: "last-failure",
			finishedOn: finished(31).getTime(),
			data: { kind: "JOB_ERROR" },
		},
	]);
	const { failed, completed } = await (await GET()).json();
	expect(completed).toHaveLength(20);
	expect(completed.map((item: { id: string }) => item.id)).toEqual([
		"live-stop-z",
		"live-stop-a",
		...Array.from(
			{ length: 18 },
			(_, i) => "job-" + String(20 - i).padStart(2, "0"),
		),
	]);
	expect(completed[0]).toEqual({
		id: "live-stop-z",
		state: "DELIVERED",
		kind: "CHANNEL_STOPPED",
		occurredAt: occurredAt.toISOString(),
		link: "/live/channel",
		attemptsMade: 3,
		failedReason: null,
	});
	expect(failed.map((item: { id: string }) => item.id)).toEqual([
		"last-failure",
		"live-stop-f",
	]);
	expect(failed[1]).toMatchObject({
		attemptsMade: 5,
		failedReason: "Webhook delivery failed (HTTP 500)",
	});
	for (const failureReason of [null, { not: null }])
		expect(findMany).toHaveBeenCalledWith({
			where: { finishedAt: { not: null }, skipped: false, failureReason },
			orderBy: [{ finishedAt: "desc" }, { id: "desc" }],
			take: 20,
			select: {
				id: true,
				channelId: true,
				kind: true,
				occurredAt: true,
				finishedAt: true,
				failures: true,
				failureReason: true,
			},
		});
});
