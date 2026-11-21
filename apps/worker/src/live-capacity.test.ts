import { liveChannelActionSchema } from "@bitovp/core";
import { DelayedError, type Job } from "bullmq";
import { describe, expect, it, vi } from "vitest";
import {
	liveChannelConcurrency,
	reserveLiveStopCapacity,
} from "./live-capacity";

const CHANNEL = "00000000-0000-4000-8000-000000000001";
const RUN = "00000000-0000-4000-8000-000000000002";
function barrier() {
	let release = () => {};
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}
function job(
	action = "provision",
	params?: unknown,
	org = "00000000-0000-4000-8000-000000000003",
) {
	return {
		id: `job-${action}`,
		name: "live-channel",
		token: "delivery-token",
		data: {
			organizationId: org,
			payload: {
				liveChannelId: CHANNEL,
				action,
				...(params === undefined ? {} : { params }),
			},
		},
		moveToDelayed: vi.fn(async () => {}),
	} as unknown as Job;
}

function heartbeatSweep(id: string) {
	return {
		id,
		name: "heartbeat-sweep",
		repeatJobKey: "live-heartbeat-sweep",
		data: { systemSweep: "heartbeat" },
		token: "sweep-token",
		moveToDelayed: vi.fn(async () => {}),
	} as unknown as Job;
}

describe("Live worker concurrency", () => {
	it.each([
		undefined,
		"",
		" ",
	])("uses eight action slots when unset or blank: %s", (value) => {
		expect(liveChannelConcurrency(value)).toBe(8);
	});
	it.each([
		"2",
		"8",
		" 12 ",
	])("respects an explicit action slot count: %s", (value) => {
		expect(liveChannelConcurrency(value)).toBe(Number(value));
	});
	it.each([
		"0",
		"1",
		"-1",
		"1.5",
		"NaN",
		"Infinity",
		"no",
		"9007199254740991",
		"9007199254740992",
	])("refuses a count that cannot reserve a stop slot: %s", (value) => {
		expect(() => liveChannelConcurrency(value)).toThrow(
			/LIVE_CHANNEL_CONCURRENCY/,
		);
	});
	it.each([
		0,
		1,
		2.5,
		Number.NaN,
	])("also validates direct wrapper configuration: %s", (value) => {
		expect(() => reserveLiveStopCapacity(value, async () => {})).toThrow(
			/LIVE_CHANNEL_CONCURRENCY/,
		);
	});
});

describe("Live reserved stop capacity", () => {
	it("defers the third normal job immediately across tenants while STOP and validated startup cancellation still run", async () => {
		const hold = barrier();
		const first = job(),
			second = job("live-to-vod");
		const seen: Job[] = [];
		const process = reserveLiveStopCapacity(3, async (current) => {
			seen.push(current);
			if (current === first || current === second) await hold.promise;
			return current.id;
		});
		const active = [process(first), process(second)];
		try {
			const excess = job(
				"restart",
				undefined,
				"00000000-0000-4000-8000-000000000004",
			);
			const before = Date.now();
			await expect(process(excess)).rejects.toBeInstanceOf(DelayedError);
			expect(excess.moveToDelayed).toHaveBeenCalledWith(
				expect.any(Number),
				excess.token,
			);
			expect(
				vi.mocked(excess.moveToDelayed).mock.calls[0]?.[0],
			).toBeGreaterThanOrEqual(before + 1000);
			expect(seen).not.toContain(excess);
			const stop = job("stop"),
				cancel = job("provision", { cancelRunId: RUN });
			await expect(process(stop)).resolves.toBe(stop.id);
			await expect(process(cancel)).resolves.toBe(cancel.id);
			expect(stop.moveToDelayed).not.toHaveBeenCalled();
			expect(cancel.moveToDelayed).not.toHaveBeenCalled();
		} finally {
			hold.release();
			await Promise.allSettled(active);
		}
	});

	it.each(
		liveChannelActionSchema.options.filter((action) => action !== "stop"),
	)("keeps %s inside the normal capacity limit", async (action) => {
		const hold = barrier(),
			first = job();
		const process = reserveLiveStopCapacity(2, async (current) => {
			if (current === first) await hold.promise;
		});
		const active = process(first);
		try {
			await expect(process(job(action))).rejects.toBeInstanceOf(DelayedError);
		} finally {
			hold.release();
			await active;
		}
	});

	it.each([
		undefined,
		{},
		{ cancelRunId: "invalid" },
		{ cancelRunId: null },
	])("does not treat unvalidated provision params as cancellation: %s", async (params) => {
		const hold = barrier(),
			first = job();
		const process = reserveLiveStopCapacity(2, async (current) => {
			if (current === first) await hold.promise;
		});
		const active = process(first);
		try {
			await expect(process(job("provision", params))).rejects.toBeInstanceOf(
				DelayedError,
			);
		} finally {
			hold.release();
			await active;
		}
	});

	it("runs a trusted system heartbeat sweep alongside saturated action slots", async () => {
		const hold = barrier();
		const normal = job();
		const stop = job("stop");
		const sweep = heartbeatSweep("sweep");
		const entered: Job[] = [];
		const process = reserveLiveStopCapacity(2, async (current) => {
			entered.push(current);
			await hold.promise;
			return current.id;
		});
		const active = [process(normal), process(sweep), process(stop)];
		try {
			expect(entered).toEqual([normal, sweep, stop]);
			await expect(process(job())).rejects.toBeInstanceOf(DelayedError);
			await expect(process(job("stop"))).rejects.toBeInstanceOf(DelayedError);
			await expect(process(sweep)).rejects.toBeInstanceOf(DelayedError);
			expect(entered).toHaveLength(3);
		} finally {
			hold.release();
			await Promise.allSettled(active);
		}
	});

	it("lets a later heartbeat sweep use spare normal capacity while keeping a stop slot", async () => {
		const slowSweep = heartbeatSweep("slow-sweep");
		const nextSweep = heartbeatSweep("next-sweep");
		const normal = job();
		const stop = job("stop");
		const slow = barrier();
		const hold = barrier();
		const entered: Job[] = [];
		const process = reserveLiveStopCapacity(3, async (current) => {
			entered.push(current);
			if (current === slowSweep) await slow.promise;
			if (current === nextSweep || current === normal || current === stop) {
				await hold.promise;
			}
			return current.id;
		});
		const first = process(slowSweep);
		const active = [first, process(normal), process(nextSweep)];
		try {
			expect(entered).toEqual([slowSweep, normal, nextSweep]);
			await expect(process(heartbeatSweep("overflow"))).rejects.toBeInstanceOf(
				DelayedError,
			);
			const restart = job("restart");
			await expect(process(restart)).rejects.toBeInstanceOf(DelayedError);
			active.push(process(stop));
			expect(entered).toEqual([slowSweep, normal, nextSweep, stop]);
			await expect(process(job("stop"))).rejects.toBeInstanceOf(DelayedError);

			slow.release();
			await expect(first).resolves.toBe(slowSweep.id);
			await expect(process(restart)).resolves.toBe(restart.id);
			expect(entered).toEqual([slowSweep, normal, nextSweep, stop, restart]);
		} finally {
			slow.release();
			hold.release();
			await Promise.allSettled(active);
		}
	});

	it("only reserves the heartbeat slot for the expected repeatable scheduler", async () => {
		const hold = barrier();
		const normal = job();
		const process = reserveLiveStopCapacity(2, async (current) => {
			if (current === normal) await hold.promise;
		});
		const active = process(normal);
		try {
			const untrusted = {
				...job(),
				name: "heartbeat-sweep",
				repeatJobKey: "different-scheduler",
				data: { systemSweep: "heartbeat" },
			} as Job;
			await expect(process(untrusted)).rejects.toBeInstanceOf(DelayedError);
		} finally {
			hold.release();
			await active;
		}
	});

	it("releases normal capacity on both completion and failure without changing the job", async () => {
		const failure = new Error("provider failed");
		const process = reserveLiveStopCapacity(2, async (current) => {
			if (current.id === "failed") throw failure;
			return current.data;
		});
		const failed = job();
		failed.id = "failed";
		await expect(process(failed)).rejects.toBe(failure);
		const next = job(),
			data = next.data;
		await expect(process(next)).resolves.toBe(data);
		await expect(process(next)).resolves.toBe(data);
		expect(next.moveToDelayed).not.toHaveBeenCalled();
		expect(next.data).toBe(data);
	});
});
