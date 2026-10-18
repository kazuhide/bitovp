import { describe, expect, it, vi } from "vitest";
import {
	enqueueFeederJob,
	FEEDER_CONCURRENCY,
	FEEDER_MAX_ACTIVE_SESSIONS,
	type FeederQueueLike,
	feederJobId,
	feederJobSchema,
	liveChannelJobSchema,
	liveEffectIntentSchema,
	liveResetTimeshiftParamsSchema,
	liveScte35ParamsSchema,
	orchestratorJobSchema,
	QUEUE_NAMES,
	vmafJobSchema,
} from "./queues";

describe("QUEUE_NAMES", () => {
	it("has unique queue names", () => {
		const names = Object.values(QUEUE_NAMES);
		expect(new Set(names).size).toBe(names.length);
	});
});

describe("job payload schemas", () => {
	const uuid = "3f1f0e8e-2c5b-4a4e-9a64-0f6f4d2c9b11";

	it("accepts valid orchestrator payloads", () => {
		expect(
			orchestratorJobSchema.parse({ encodingJobId: uuid }).encodingJobId,
		).toBe(uuid);
	});

	it("rejects non-uuid ids", () => {
		expect(() =>
			orchestratorJobSchema.parse({ encodingJobId: "42" }),
		).toThrow();
		expect(() => vmafJobSchema.parse({ vmafJobId: "42" })).toThrow();
	});

	it("constrains feeder actions (start|stop — restart is supervisor-internal)", () => {
		expect(
			feederJobSchema.parse({ feederSessionId: uuid, action: "start" }).action,
		).toBe("start");
		expect(
			feederJobSchema.parse({ feederSessionId: uuid, action: "stop" }).action,
		).toBe("stop");
		expect(() =>
			feederJobSchema.parse({ feederSessionId: uuid, action: "restart" }),
		).toThrow();
		expect(() =>
			feederJobSchema.parse({ feedId: uuid, action: "start" }),
		).toThrow();
	});

	it("defaults live channel jobs to the provision action", () => {
		const job = liveChannelJobSchema.parse({ liveChannelId: uuid });
		expect(job.action).toBe("provision");
	});

	it("constrains live channel actions", () => {
		expect(
			liveChannelJobSchema.parse({ liveChannelId: uuid, action: "scte35" })
				.action,
		).toBe("scte35");
		expect(() =>
			liveChannelJobSchema.parse({ liveChannelId: uuid, action: "explode" }),
		).toThrow();
	});

	it("requires the exact attempt, run, and encoding identity for live-to-VOD", () => {
		expect(() =>
			liveChannelJobSchema.parse({
				liveChannelId: uuid,
				action: "live-to-vod",
			}),
		).toThrow();
	});

	it("binds irreversible live effects to an exact run and encoding", () => {
		expect(
			liveEffectIntentSchema.parse({
				idempotencyKey: "schedule:s1:stop",
				liveChannelRunId: uuid,
				providerEncodingId: "encoding-1",
				admissionFenceVersion: 3,
				action: "STOP",
			}),
		).toMatchObject({
			liveChannelRunId: uuid,
			providerEncodingId: "encoding-1",
			admissionFenceVersion: 3,
			action: "STOP",
		});
		expect(() =>
			liveEffectIntentSchema.parse({
				idempotencyKey: "schedule:s1:stop",
				providerEncodingId: "encoding-1",
				action: "STOP",
			}),
		).toThrow();
	});

	it("accepts a live-to-VOD job only when its exact identity is carried", () => {
		const runId = "68c15e23-0a91-4ff3-a780-2210a602dbe5";
		const attemptId = "f8db1f73-a815-4ed3-bf01-dd49d61f7352";
		expect(
			liveChannelJobSchema.parse({
				liveChannelId: uuid,
				action: "live-to-vod",
				liveChannelRunId: runId,
				attemptId,
				encodingId: "encoding-42",
			}),
		).toMatchObject({
			liveChannelRunId: runId,
			attemptId,
			encodingId: "encoding-42",
		});
	});
	it("validates SCTE-35 params (cueDuration required and positive)", () => {
		expect(liveScte35ParamsSchema.parse({ cueDuration: 30 }).cueDuration).toBe(
			30,
		);
		expect(() => liveScte35ParamsSchema.parse({})).toThrow();
		expect(() => liveScte35ParamsSchema.parse({ cueDuration: -1 })).toThrow();
	});

	it("validates reset-timeshift params (all optional, manifestIds non-empty)", () => {
		expect(liveResetTimeshiftParamsSchema.parse({})).toEqual({});
		expect(
			liveResetTimeshiftParamsSchema.parse({
				residualPeriodInSeconds: 600,
				manifestIds: ["m1"],
			}).manifestIds,
		).toEqual(["m1"]);
		expect(() =>
			liveResetTimeshiftParamsSchema.parse({ manifestIds: [] }),
		).toThrow();
	});
});

describe("feeder enqueue helper", () => {
	const uuid = "3f1f0e8e-2c5b-4a4e-9a64-0f6f4d2c9b11";
	const startJob = { feederSessionId: uuid, action: "start" } as const;
	const stopJob = { feederSessionId: uuid, action: "stop" } as const;

	function makeQueue(existing?: {
		state: string;
		remove?: () => Promise<unknown>;
	}) {
		const remove = vi.fn(existing?.remove ?? (async () => {}));
		const add = vi.fn(async () => ({}));
		const getJob = vi.fn(async () =>
			existing ? { getState: async () => existing.state, remove } : undefined,
		);
		const queue: FeederQueueLike = { add, getJob };
		return { queue, add, getJob, remove };
	}

	it("keeps one stop slot below the worker concurrency", () => {
		expect(FEEDER_MAX_ACTIVE_SESSIONS).toBe(FEEDER_CONCURRENCY - 1);
		expect(FEEDER_MAX_ACTIVE_SESSIONS).toBeGreaterThan(0);
	});

	it("derives jobIds per the producer convention (start = row id, stop = <id>-stop)", () => {
		// A DASH. It was `-stop`, and BullMQ 5 rejects a custom id containing a colon —
		// `Custom Id cannot contain :` — so every feeder stop returned HTTP 500 and left an
		// ffmpeg process running. This assertion pinned the bug: the queue is mocked here, and
		// a mock accepts any id, so the id BullMQ refuses was the one the test required.
		// Found by the first real live channel.
		expect(feederJobId(startJob)).toBe(uuid);
		expect(feederJobId(stopJob)).toBe(`${uuid}-stop`);
		expect(feederJobId(stopJob)).not.toContain(":");
	});

	it("enqueues starts without probing for prior jobs", async () => {
		const q = makeQueue();
		await enqueueFeederJob(q.queue, startJob);
		expect(q.getJob).not.toHaveBeenCalled();
		expect(q.add).toHaveBeenCalledWith(
			"feeder",
			startJob,
			expect.objectContaining({ jobId: uuid }),
		);
	});

	it("removes a FAILED stop job parked under the dedup id before re-enqueueing", async () => {
		const q = makeQueue({ state: "failed" });
		await enqueueFeederJob(q.queue, stopJob);
		expect(q.getJob).toHaveBeenCalledWith(`${uuid}-stop`);
		expect(q.remove).toHaveBeenCalled();
		expect(q.add).toHaveBeenCalledWith(
			"feeder",
			stopJob,
			expect.objectContaining({ jobId: `${uuid}-stop` }),
		);
	});

	it("removes a COMPLETED stop job too — a terminal session can still own a pushing ffmpeg", async () => {
		// Audit 2026-08-29 CRITICAL-2: the old rule ("sessions are terminal
		// after one stop, so a completed id cannot bite") is false for a START
		// job that died outside the worker — that row is ERROR and still owns
		// its `-stream_loop -1` ffmpeg. The reclaim stop is a SECOND stop, and
		// BullMQ would have swallowed it under the parked completed id.
		const q = makeQueue({ state: "completed" });
		await enqueueFeederJob(q.queue, stopJob);
		expect(q.remove).toHaveBeenCalled();
		expect(q.add).toHaveBeenCalledWith(
			"feeder",
			stopJob,
			expect.objectContaining({ jobId: `${uuid}-stop` }),
		);
	});

	it("keeps idempotency for pending stop duplicates (no removal — the add dedupes)", async () => {
		const q = makeQueue({ state: "waiting" });
		await enqueueFeederJob(q.queue, stopJob);
		expect(q.remove).not.toHaveBeenCalled();
		expect(q.add).toHaveBeenCalled();
	});

	it("still adds when removing the failed job loses a race", async () => {
		const q = makeQueue({
			state: "failed",
			remove: async () => {
				throw new Error("job already removed");
			},
		});
		await enqueueFeederJob(q.queue, stopJob);
		expect(q.add).toHaveBeenCalled();
	});
});
