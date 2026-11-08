import { AsyncLocalStorage } from "node:async_hooks";
import { expect, it } from "vitest";
import { createEditingWorkQueue } from "./runtime-work-queue";

const gate = () => {
	let release: () => void = () => {};
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
};

it("serializes rendering and media generation across tenants without duplicate queued ticks", async () => {
	const queue = createEditingWorkQueue(),
		first = gate();
	const events: string[] = [];
	const render = queue.createCycle(async () => {
		events.push("render:start");
		await first.promise;
		events.push("render:end");
	});
	const asr = queue.createCycle(async () => {
		events.push("asr");
	});
	const one = render(),
		two = asr();
	expect(asr()).toBe(two);
	expect(render()).toBe(one);
	await Promise.resolve();
	expect(events).toEqual(["render:start"]);
	first.release();
	await Promise.all([one, two]);
	expect(events).toEqual(["render:start", "render:end", "asr"]);
});
it("does not poison the next tenant when a cycle fails", async () => {
	const queue = createEditingWorkQueue();
	const events: string[] = [];
	const failed = queue.createCycle(async () => {
		throw new Error("expected failure");
	});
	const next = queue.createCycle(async () => {
		events.push("next");
	});
	await expect(failed()).rejects.toThrow("expected failure");
	await next();
	expect(events).toEqual(["next"]);
});
it("skips queued cancellation but keeps the running slot until real cleanup settles", async () => {
	const queue = createEditingWorkQueue(),
		running = gate(),
		stop = new AbortController(),
		queuedStop = new AbortController();
	const events: string[] = [];
	const first = queue.createCycle(async () => {
		events.push("first");
		await running.promise;
	}, stop.signal);
	const canceled = queue.createCycle(async () => {
		events.push("canceled");
	}, queuedStop.signal);
	const last = queue.createCycle(async () => {
		events.push("last");
	});
	const a = first(),
		b = canceled(),
		c = last();
	await Promise.resolve();
	stop.abort();
	queuedStop.abort();
	await Promise.resolve();
	expect(events).toEqual(["first"]);
	running.release();
	await Promise.all([a, b, c]);
	expect(events).toEqual(["first", "last"]);
});
it("preserves the tenant context which enqueued each callback", async () => {
	const context = new AsyncLocalStorage<string>(),
		queue = createEditingWorkQueue(),
		block = gate();
	const tenants: Array<string | undefined> = [];
	const first = queue.createCycle(async () => {
		tenants.push(context.getStore());
		await block.promise;
	});
	const second = queue.createCycle(async () => {
		tenants.push(context.getStore());
	});
	const a = context.run("tenant-a", first),
		b = context.run("tenant-b", second);
	block.release();
	await Promise.all([a, b]);
	expect(tenants).toEqual(["tenant-a", "tenant-b"]);
});
