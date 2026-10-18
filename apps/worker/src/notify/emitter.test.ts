import { describe, expect, it, vi } from "vitest";
import { createEventEmitter } from "./emitter";

/**
 * : the emitter's CONTRACT is best-effort — a notify outage or an
 * emit-site bug must never fail the job whose transition emitted. Both
 * directions pinned: a throwing queue resolves, and an invalid event is
 * dropped with a loud log instead of enqueued.
 */

const JOB = "00000000-0000-4000-8000-0000000000aa";

describe("createEventEmitter", () => {
	it("fills the envelope and enqueues a schema-valid event", async () => {
		const add = vi.fn().mockResolvedValue(undefined);
		const emit = createEventEmitter({
			queue: { add },
			publicBaseUrl: "https://ovp.example.com/",
			now: () => new Date("2026-08-12T00:00:00.000Z"),
		});
		await emit({
			kind: "JOB_FINISHED",
			jobId: JOB,
			name: "j",
			labels: [],
			path: `/vod/jobs/${JOB}`,
		});
		expect(add).toHaveBeenCalledTimes(1);
		const [, data, opts] = add.mock.calls[0] as [
			string,
			Record<string, unknown>,
			Record<string, unknown>,
		];
		// review-183 I6/MC1: C1 existed BECAUSE nothing could see the enqueue
		// options — BullMQ defaults attempts to 0, so without these the bus is
		// silently at-MOST-once and 's at-least-once sentence goes
		// false a second time, on the same sentence.
		expect(opts).toMatchObject({
			attempts: 5,
			backoff: { type: "exponential", delay: 1_000 },
		});
		expect(data.eventVersion).toBe(1);
		expect(data.occurredAt).toBe("2026-08-12T00:00:00.000Z");
		// Trailing slash on the base collapses — no double slash in the link.
		expect(data.link).toBe(`https://ovp.example.com/vod/jobs/${JOB}`);
		expect(data).not.toHaveProperty("path");
	});

	it("NEVER throws when the queue is down (the job survives)", async () => {
		const add = vi.fn().mockRejectedValue(new Error("redis down"));
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const emit = createEventEmitter({ queue: { add } });
		await expect(
			emit({
				kind: "JOB_CANCELED",
				jobId: JOB,
				name: "j",
				labels: [],
				path: "/vod/jobs/x",
			}),
		).resolves.toBeUndefined();
		expect(error).toHaveBeenCalled();
		error.mockRestore();
	});

	it("DROPS a schema-invalid event loudly instead of enqueueing it", async () => {
		const add = vi.fn().mockResolvedValue(undefined);
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const emit = createEventEmitter({ queue: { add } });
		await emit({
			kind: "JOB_ERROR",
			// Not a uuid — an emit-site bug must not reach the queue.
			jobId: "not-a-uuid",
			name: "j",
			labels: [],
			error: "boom",
			path: "/vod/jobs/x",
		});
		expect(add).not.toHaveBeenCalled();
		expect(error).toHaveBeenCalledWith(
			expect.stringContaining("DROPPED schema-invalid JOB_ERROR"),
			expect.any(String),
		);
		error.mockRestore();
	});
});
