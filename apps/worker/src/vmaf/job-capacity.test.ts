import { DelayedError, type Job } from "bullmq";
import { expect, it, vi } from "vitest";
import { queueExcessVmafJobs } from "./job-capacity";

function barrier() {
	let release = () => {};
	const wait = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { wait, release };
}
function job(kind = "local") {
	return {
		data: { kind },
		token: "owned-delivery",
		moveToDelayed: vi.fn(async () => {}),
	} as unknown as Job;
}

it("queues excess parents before processing while cloud and cancellation still pass", async () => {
	const hold = barrier(),
		process = vi.fn(async (value: Job) => {
			if (value.data.kind !== "control") await hold.wait;
			return value.data.kind;
		});
	const run = queueExcessVmafJobs({
		localCapacity: () => 2,
		cloudCapacity: 1,
		classify: async (value) => value.data.kind,
		process,
		now: () => 100,
	});
	const a = run(job()),
		b = run(job());
	await vi.waitFor(() => expect(process).toHaveBeenCalledTimes(2));
	const extra = job();
	try {
		await expect(run(extra)).rejects.toBeInstanceOf(DelayedError);
		expect(extra.moveToDelayed).toHaveBeenCalledWith(1100, extra.token);
		const c = run(job("cloud"));
		await vi.waitFor(() => expect(process).toHaveBeenCalledTimes(3));
		await expect(run(job("control"))).resolves.toBe("control");
		hold.release();
		await Promise.all([a, b, c]);
		await expect(run(extra)).resolves.toBe("local");
	} finally {
		hold.release();
		await Promise.allSettled([a, b]);
	}
});
it("shrinks future admissions without cancelling existing parents and releases failed holders", async () => {
	const hold = barrier();
	let capacity = 2,
		calls = 0;
	const run = queueExcessVmafJobs({
		localCapacity: () => capacity,
		cloudCapacity: 1,
		classify: async () => "local",
		process: async () => {
			const call = ++calls;
			await hold.wait;
			if (call === 1) throw new Error("fixture failure");
			return call;
		},
	});
	const a = run(job()),
		b = run(job());
	await vi.waitFor(() => expect(calls).toBe(2));
	capacity = 1;
	try {
		await expect(run(job())).rejects.toBeInstanceOf(DelayedError);
	} finally {
		hold.release();
		await Promise.allSettled([a, b]);
	}
	await expect(run(job())).resolves.toBe(3);
});
it("does not process a job if delaying fails or classification rejects", async () => {
	const hold = barrier(),
		process = vi.fn(async () => hold.wait);
	const run = queueExcessVmafJobs({
		localCapacity: () => 1,
		cloudCapacity: 1,
		classify: async () => "local",
		process,
	});
	const active = run(job());
	await vi.waitFor(() => expect(process).toHaveBeenCalledTimes(1));
	const extra = job();
	vi.mocked(extra.moveToDelayed).mockRejectedValue(
		new Error("lost queue lock"),
	);
	try {
		await expect(run(extra)).rejects.toThrow("lost queue lock");
		expect(process).toHaveBeenCalledTimes(1);
	} finally {
		hold.release();
		await active;
	}
	const denied = queueExcessVmafJobs({
		localCapacity: () => 1,
		cloudCapacity: 1,
		classify: async () => {
			throw new Error("tenant denied");
		},
		process,
	});
	await expect(denied(job())).rejects.toThrow("tenant denied");
	expect(process).toHaveBeenCalledTimes(1);
});
