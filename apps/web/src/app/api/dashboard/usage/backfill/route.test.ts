import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evaluateRole } from "@/lib/auth/roles";

const {
	findUnique,
	findMarker,
	queryRaw,
	getJob,
	add,
	transaction,
	findCursors,
} = vi.hoisted(() => ({
	findUnique: vi.fn(),
	findMarker: vi.fn(),
	queryRaw: vi.fn(),
	getJob: vi.fn(),
	add: vi.fn(),
	transaction: vi.fn(),
	findCursors: vi.fn(),
}));
vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({
		prisma: {
			bitmovinAccount: { findUnique },
			appSetting: { findUnique: findMarker },
			$transaction: transaction,
		},
	}),
}));
vi.mock("@/lib/server/queue", () => ({
	getUsageStatisticsQueue: () => ({ getJob, add }),
}));

import { GET, POST } from "./route";

const accountId = "11111111-1111-4111-8111-111111111111";
const generation = "22222222-2222-4222-8222-222222222222";
const body = { accountId, from: "2024-01-01", to: "2024-01-26" };
const request = (data: unknown = body) =>
	new Request("http://test/api/dashboard/usage/backfill", {
		method: "POST",
		body: JSON.stringify(data),
		headers: { "content-type": "application/json" },
	});
const job = (state: string) => ({
	data: body,
	progress: 0,
	getState: vi.fn().mockResolvedValue(state),
	remove: vi.fn(),
});
beforeEach(() => {
	vi.clearAllMocks();
	findUnique.mockResolvedValue({ id: accountId });
	findMarker.mockResolvedValue({ value: generation });
	queryRaw.mockResolvedValue([{ id: accountId }]);
	transaction.mockImplementation((fn) =>
		fn({
			$queryRaw: queryRaw,
			appSetting: { findUnique: findMarker, upsert: vi.fn() },
			usageSweepCursor: { findMany: findCursors },
		}),
	);
	getJob.mockResolvedValue(undefined);
	add.mockImplementation(async (_name, data) => ({ ...job("waiting"), data }));
	findCursors.mockResolvedValue([]);
});

describe("statistics backfill route", () => {
	it("enqueues account-specific old dates and retains status with bounded retries", async () => {
		const response = await POST(request());
		expect(response.status).toBe(202);
		expect(await response.json()).toMatchObject({
			job: { ...body, status: "queued", totalChunks: 4 },
		});
		expect(add).toHaveBeenCalledWith(
			"backfill",
			expect.objectContaining(body),
			expect.objectContaining({
				jobId: expect.stringMatching(
					new RegExp(`^usage-${accountId}-[0-9a-f-]{36}$`),
				),
				attempts: 3,
				removeOnComplete: { age: 604_800, count: 1000 },
				removeOnFail: { age: 604_800, count: 1000 },
			}),
		);
		expect(queryRaw).toHaveBeenCalled();
		const payload = add.mock.calls[0]?.[1];
		expect(add.mock.calls[0]?.[2].jobId).toBe(
			`usage-${accountId}-${payload.generation}`,
		);
	});
	it("returns the existing active request even if another date range was requested", async () => {
		const active = job("active");
		getJob.mockResolvedValue(active);
		const response = await POST(request({ ...body, from: "2023-01-01" }));
		expect(await response.json()).toMatchObject({
			job: { ...body, status: "running" },
		});
		expect(add).not.toHaveBeenCalled();
		expect(active.remove).not.toHaveBeenCalled();
	});
	it.each([
		"completed",
		"failed",
	])("replaces a %s import under the account lock", async (state) => {
		const terminal = job(state);
		getJob.mockResolvedValue(terminal);
		expect((await POST(request())).status).toBe(202);
		expect(terminal.remove).not.toHaveBeenCalled();
		expect(add).toHaveBeenCalledOnce();
		expect(add.mock.calls[0]?.[2].jobId).not.toBe(
			`usage-${accountId}-${generation}`,
		);
	});
	it("ignores orphan Redis jobs after SQL rollback and accepts a fresh owned generation", async () => {
		let marker: { value: string } | null = null;
		const redis = new Map<string, ReturnType<typeof job>>();
		findMarker.mockImplementation(async () => marker);
		getJob.mockImplementation(async (id: string) => redis.get(id));
		add.mockImplementation(async (_name, data, options) => {
			const queued = { ...job("waiting"), data };
			redis.set(options.jobId, queued);
			return queued;
		});
		let rollBack = true;
		transaction.mockImplementation(async (fn) => {
			const before = marker;
			const result = await fn({
				$queryRaw: queryRaw,
				appSetting: {
					findUnique: findMarker,
					upsert: async ({ update }: { update: { value: string } }) => {
						marker = update;
					},
				},
			});
			if (rollBack) {
				marker = before;
				rollBack = false;
				throw new Error("commit failed");
			}
			return result;
		});
		expect((await POST(request())).status).toBe(500);
		expect(redis.size).toBe(1);
		expect(marker).toBeNull();
		expect((await POST(request())).status).toBe(202);
		expect(redis.size).toBe(2);
		const accepted = add.mock.calls[1]?.[1];
		expect(marker).toEqual({ value: accepted.generation });
		await GET(
			new Request(
				`http://test/api/dashboard/usage/backfill?accountId=${accountId}`,
			),
		);
		expect(getJob).toHaveBeenLastCalledWith(
			`usage-${accountId}-${accepted.generation}`,
		);
	});
	it("does not expose canceled generation status after reset removes its marker", async () => {
		findMarker.mockResolvedValue(null);
		getJob.mockResolvedValue(job("active"));
		const response = await GET(
			new Request(
				`http://test/api/dashboard/usage/backfill?accountId=${accountId}`,
			),
		);
		expect(await response.json()).toEqual({ job: null });
		expect(getJob).not.toHaveBeenCalled();
	});
	it("rejects missing accounts without enqueuing", async () => {
		queryRaw.mockResolvedValue([]);
		expect((await POST(request())).status).toBe(404);
		expect(add).not.toHaveBeenCalled();
	});
	it("rejects invalid payloads before queue or database work", async () => {
		expect((await POST(request({ ...body, to: "9999-01-01" }))).status).toBe(
			400,
		);
		expect(transaction).not.toHaveBeenCalled();
	});
	it("returns a safe failure status and does not expose provider error text", async () => {
		getJob.mockResolvedValue({
			...job("failed"),
			failedReason: "apiKey=do-not-expose",
			progress: {
				completedChunks: 1,
				totalChunks: 4,
				rowsUpserted: 25,
				through: { VOD: "2024-01-25" },
			},
		});
		const response = await GET(
			new Request(
				`http://test/api/dashboard/usage/backfill?accountId=${accountId}`,
			),
		);
		const result = await response.json();
		expect(result.job).toMatchObject({
			status: "failed",
			completedChunks: 1,
			rowsUpserted: 25,
		});
		expect(JSON.stringify(result)).not.toContain("do-not-expose");
	});
	it("allows viewer status reads but requires operator for imports", () => {
		expect(
			evaluateRole("VIEWER", "/api/dashboard/usage/backfill", "GET").allowed,
		).toBe(true);
		expect(
			evaluateRole("VIEWER", "/api/dashboard/usage/backfill", "POST").allowed,
		).toBe(false);
		expect(
			evaluateRole("OPERATOR", "/api/dashboard/usage/backfill", "POST").allowed,
		).toBe(true);
	});
});

describe("automatic statistics refresh", () => {
	const now = new Date("2026-10-16T12:00:00Z");
	const automatic = { accountId, mode: "automatic" };
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(now);
	});
	afterEach(() => vi.useRealTimers());
	it("derives a full stale gap from the oldest kind cursor and marks its queue payload", async () => {
		findCursors.mockResolvedValue([
			{
				kind: "VOD",
				sweptThrough: new Date("2026-10-15"),
				sweptAt: new Date("2026-10-15"),
			},
			{
				kind: "LIVE",
				sweptThrough: new Date("2025-01-01"),
				sweptAt: new Date("2025-01-01"),
			},
		]);
		const response = await POST(request(automatic));
		expect(response.status).toBe(202);
		expect(findCursors).toHaveBeenCalledWith({
			where: { bitmovinAccountId: accountId },
			select: { kind: true, sweptThrough: true, sweptAt: true },
		});
		expect(add.mock.calls[0]?.[1]).toMatchObject({
			accountId,
			from: "2024-12-29",
			to: "2026-10-16",
			automatic: true,
		});
		expect(await response.json()).toMatchObject({
			job: { automatic: true, from: "2024-12-29" },
		});
	});
	it("uses the initial 90-day window for missing kinds and clamps the earliest supported day", async () => {
		await POST(request(automatic));
		expect(add.mock.calls[0]?.[1]).toMatchObject({
			from: "2026-07-19",
			to: "2026-10-16",
		});
		findCursors.mockResolvedValue([
			{
				kind: "VOD",
				sweptThrough: new Date("2013-01-01"),
				sweptAt: new Date(0),
			},
		]);
		await POST(request(automatic));
		expect(add.mock.calls[1]?.[1]).toMatchObject({ from: "2013-01-01" });
	});
	it("no-ops only when both kinds cover today and are fresh for 15 minutes", async () => {
		findCursors.mockResolvedValue(
			["VOD", "LIVE"].map((kind) => ({
				kind,
				sweptThrough: new Date("2026-10-16"),
				sweptAt: new Date(now.getTime() - 14 * 60_000),
			})),
		);
		const response = await POST(request(automatic));
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ job: null });
		expect(add).not.toHaveBeenCalled();
		findCursors.mockResolvedValue([
			{ kind: "VOD", sweptThrough: new Date("2026-10-16"), sweptAt: now },
		]);
		expect((await POST(request(automatic))).status).toBe(202);
	});
	it("joins an owned manual job before checking freshness", async () => {
		getJob.mockResolvedValue(job("active"));
		const response = await POST(request(automatic));
		expect(response.status).toBe(202);
		expect(await response.json()).toMatchObject({
			job: { ...body, status: "running" },
		});
		expect(findCursors).not.toHaveBeenCalled();
		expect(add).not.toHaveBeenCalled();
	});
	it("applies a five-minute cooldown only to a failed automatic generation", async () => {
		getJob.mockResolvedValue({
			...job("failed"),
			data: { ...body, automatic: true },
			failedReason: "apiKey=do-not-expose",
			finishedOn: now.getTime() - 4 * 60_000,
		});
		const response = await POST(request(automatic));
		expect(response.status).toBe(202);
		const result = await response.json();
		expect(result).toMatchObject({
			job: {
				automatic: true,
				status: "failed",
				error: "Statistics import failed; retry the request.",
			},
		});
		expect(JSON.stringify(result)).not.toContain("do-not-expose");
		expect(add).not.toHaveBeenCalled();
		expect((await POST(request())).status).toBe(202);
		expect(add).toHaveBeenCalledOnce();
	});
	it("retries automatic failures after cooldown and does not throttle failed manual history", async () => {
		for (const previous of [
			{
				...job("failed"),
				data: { ...body, automatic: true },
				finishedOn: now.getTime() - 5 * 60_000,
			},
			{ ...job("failed"), finishedOn: now.getTime() },
		]) {
			getJob.mockResolvedValue(previous);
			expect((await POST(request(automatic))).status).toBe(202);
		}
		expect(add).toHaveBeenCalledTimes(2);
	});
	it("returns the automatic status flag on later GETs", async () => {
		getJob.mockResolvedValue({
			...job("completed"),
			data: { ...body, automatic: true },
		});
		const response = await GET(
			new Request(
				`http://test/api/dashboard/usage/backfill?accountId=${accountId}`,
			),
		);
		expect(await response.json()).toMatchObject({
			job: { automatic: true, status: "completed" },
		});
	});
});

it("uses the failed automatic job's known start timestamp if BullMQ finish metadata is unavailable", async () => {
	const now = Date.now();
	getJob.mockResolvedValue({
		...job("failed"),
		data: { ...body, automatic: true },
		timestamp: now,
	});
	const response = await POST(request({ accountId, mode: "automatic" }));
	expect(response.status).toBe(202);
	expect(await response.json()).toMatchObject({
		job: { automatic: true, status: "failed" },
	});
	expect(add).not.toHaveBeenCalled();
});
