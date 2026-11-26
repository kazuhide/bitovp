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

	it("keeps a stored occurrence time when a failure notification is delayed", async () => {
		const add = vi.fn(
			async (
				_name: string,
				_data: unknown,
				_opts?: Record<string, unknown>,
			) => {},
		);
		const emit = createEventEmitter({
			queue: { add },
			now: () => new Date("2026-08-15T00:00:00Z"),
		});
		const at = new Date("2026-08-12T00:00:00Z");
		await emit(
			{
				kind: "CHANNEL_ERROR",
				liveChannelId: JOB,
				name: "test",
				error: "lost stop response",
				path: `/live/${JOB}`,
			},
			at,
		);
		expect(add.mock.calls[0]?.[1]).toMatchObject({
			occurredAt: at.toISOString(),
		});
		expect(add.mock.calls[0]?.[2]).not.toHaveProperty("jobId");
	});

	it("uses the same tenant-scoped queue key for repeat schedule firing receipts", async () => {
		const add = vi.fn().mockResolvedValue(undefined);
		const tenantOne = "00000000-0000-4000-8000-000000000001";
		const tenantTwo = "00000000-0000-4000-8000-000000000002";
		const event = {
			kind: "SCHEDULE_FIRED" as const,
			scheduleId: JOB,
			liveChannelId: JOB,
			path: `/live/${JOB}`,
		};
		const emitFirst = createEventEmitter({
			queue: { add },
			organizationId: tenantOne,
		});
		await emitFirst(event);
		await emitFirst(event);
		await createEventEmitter({
			queue: { add },
			organizationId: tenantTwo,
		})(event);
		expect(add.mock.calls.map(([, , options]) => options.jobId)).toEqual([
			`schedule-fired-${tenantOne}-${JOB}`,
			`schedule-fired-${tenantOne}-${JOB}`,
			`schedule-fired-${tenantTwo}-${JOB}`,
		]);
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
