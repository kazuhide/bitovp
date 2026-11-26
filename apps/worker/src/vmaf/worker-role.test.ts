import { QUEUE_NAMES } from "@bitovp/core";
import { expect, it, vi } from "vitest";
import {
	dedicatedVmafOwner,
	primaryWorkerQueues,
	startDedicatedVmafConsumer,
} from "./worker-role";

const keys = Object.keys(QUEUE_NAMES) as (keyof typeof QUEUE_NAMES)[];

it("keeps all primary queues by default and moves only vmafRunner to the dedicated owner", () => {
	expect(primaryWorkerQueues(keys, "worker")).toEqual(keys);
	expect(primaryWorkerQueues(keys, "dedicated")).toEqual(
		keys.filter((key) => key !== "vmafRunner"),
	);
	expect(dedicatedVmafOwner("dedicated")).toBe("vmafRunner");
	expect(() => dedicatedVmafOwner("worker")).toThrow("VMAF_QUEUE_OWNER");
});

function consumerFixture() {
	const events: string[] = [];
	const stop = vi.fn(async () => {
		events.push("close");
	});
	return {
		events,
		ready: vi.fn(async () => {
			events.push("ready");
			return { name: "this-worker", database: 0 };
		}),
		listWorkers: vi.fn(
			async (): Promise<{ rawname?: string; db?: string }[]> => [
				{ rawname: "this-worker", db: "0" },
			],
		),
		ownsQueue: vi.fn(async () => true),
		run: vi.fn(async () => {
			events.push("run");
		}),
		close: stop,
	};
}

it("registers the dedicated consumer only after its queue has no other consumer", async () => {
	const worker = consumerFixture();
	await expect(startDedicatedVmafConsumer(worker)).resolves.toBeUndefined();
	expect(worker.events).toEqual(["ready", "run"]);
	expect(worker.listWorkers).toHaveBeenCalledOnce();
});

it("rechecks the role and topology at the handoff to BullMQ", async () => {
	const worker = consumerFixture();
	worker.ownsQueue.mockResolvedValueOnce(false);
	await expect(startDedicatedVmafConsumer(worker)).rejects.toThrow(
		"VMAF_QUEUE_OWNERSHIP_UNAVAILABLE",
	);
	expect(worker.events).toEqual(["ready", "close"]);
	expect(worker.run).not.toHaveBeenCalled();
});

it("closes after a stop during readiness without ever running the worker", async () => {
	const worker = consumerFixture();
	const stop = new AbortController();
	worker.ready.mockImplementationOnce(async () => {
		stop.abort();
		return { name: "this-worker", database: 0 };
	});
	await expect(
		startDedicatedVmafConsumer(worker, stop.signal),
	).rejects.toMatchObject({
		name: "AbortError",
	});
	expect(worker.close).toHaveBeenCalledOnce();
	expect(worker.listWorkers).not.toHaveBeenCalled();
	expect(worker.run).not.toHaveBeenCalled();
});

it.each([
	{ workers: [{ rawname: "other-worker", db: "0" }] },
	{
		workers: [
			{ rawname: "this-worker", db: "0" },
			{ rawname: "other-worker", db: "0" },
		],
	},
	{ workers: [{}] },
])("closes without running if connected ownership is indeterminate or shared", async ({
	workers,
}) => {
	const worker = consumerFixture();
	worker.listWorkers.mockResolvedValueOnce(workers);
	await expect(startDedicatedVmafConsumer(worker)).rejects.toThrow(
		"VMAF_QUEUE_HAS_ANOTHER_CONSUMER",
	);
	expect(worker.events).toEqual(["ready", "close"]);
	expect(worker.run).not.toHaveBeenCalled();
});

it("permits an unrelated consumer in another Redis database", async () => {
	const worker = consumerFixture();
	worker.listWorkers.mockResolvedValueOnce([
		{ rawname: "this-worker", db: "0" },
		{ rawname: "other-worker", db: "1" },
	]);
	await expect(startDedicatedVmafConsumer(worker)).resolves.toBeUndefined();
	expect(worker.events).toEqual(["ready", "run"]);
});
