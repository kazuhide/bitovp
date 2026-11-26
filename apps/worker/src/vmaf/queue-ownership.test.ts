import { DelayedError, type Job } from "bullmq";
import { expect, it, vi } from "vitest";
import {
	closeVmafQueueConsumer,
	createVmafQueueRegistry,
	guardVmafQueueOwnership,
	readVmafQueueDatabase,
} from "./queue-ownership";

it("defers unowned queue jobs before entering the tenant handler", async () => {
	const own = vi.fn(async () => false);
	const consume = vi.fn(async () => "processed");
	const job = {
		token: "lock",
		moveToDelayed: vi.fn(async () => {}),
	} as unknown as Job;
	const run = guardVmafQueueOwnership(own, consume);
	await expect(run(job)).rejects.toBeInstanceOf(DelayedError);
	expect(job.moveToDelayed).toHaveBeenCalledWith(expect.any(Number), "lock");
	expect(consume).not.toHaveBeenCalled();
	own.mockResolvedValueOnce(true);
	await expect(run(job)).resolves.toBe("processed");
	own.mockRejectedValueOnce(new Error("coordinator disconnected"));
	await expect(run(job)).rejects.toBeInstanceOf(DelayedError);
	expect(consume).toHaveBeenCalledOnce();
});

it("retains registration until graceful drain and retains it after a failed close", async () => {
	let complete = () => {};
	const release = vi.fn(async () => {});
	const drain = new Promise<void>((resolve) => {
		complete = resolve;
	});
	const operation = closeVmafQueueConsumer(() => drain, release);
	expect(release).not.toHaveBeenCalled();
	complete();
	await operation;
	expect(release).toHaveBeenCalledOnce();
	await expect(
		closeVmafQueueConsumer(async () => {
			throw new Error("close failed");
		}, release),
	).rejects.toThrow("close failed");
	expect(release).toHaveBeenCalledOnce();
});

it("releases a reservation before any consumption if Redis has not persisted its registration", async () => {
	const redis = {
		eval: vi.fn().mockResolvedValueOnce(2).mockResolvedValueOnce(1),
		call: vi.fn().mockResolvedValue([0, 0]),
	};
	const ownership = createVmafQueueRegistry(redis);
	const database = "a".repeat(64);
	await expect(ownership.claim("dedicated", database)).rejects.toThrow(
		"VMAF_QUEUE_DURABLE_REGISTRATION_UNAVAILABLE",
	);
	expect(redis.call).toHaveBeenCalledWith("WAITAOF", 1, 0, 2_000);
	expect(redis.eval.mock.calls.map((call) => call[5])).toEqual([
		"claim",
		"release",
	]);
});

it("derives topology identity from the live writable database, including its restart epoch", async () => {
	const query = vi.fn(async () => [
		{ name: "bitovp", oid: "16392", epoch: "1795734000.001234" },
	]);
	const prisma = { $queryRaw: query } as never;
	const first = await readVmafQueueDatabase(prisma);
	expect(first).toMatch(/^[a-f0-9]{64}$/);
	query.mockResolvedValueOnce([
		{ name: "another", oid: "16393", epoch: "1795734000.001234" },
	]);
	expect(await readVmafQueueDatabase(prisma)).not.toBe(first);
	query.mockResolvedValueOnce([
		{ name: "bitovp", oid: "16392", epoch: "1795734111.001234" },
	]);
	expect(await readVmafQueueDatabase(prisma)).not.toBe(first);
	query.mockResolvedValueOnce([]);
	await expect(readVmafQueueDatabase(prisma)).rejects.toThrow(
		"VMAF_QUEUE_DATABASE_IDENTITY_UNAVAILABLE",
	);
});

it("keeps ordinary queue consumption available with AOF on pre-7.2 Redis", async () => {
	const redis = {
		eval: vi.fn().mockResolvedValueOnce(2).mockResolvedValueOnce(1),
		call: vi
			.fn()
			.mockRejectedValue(
				new Error(
					"ERR unknown command 'WAITAOF', with args beginning with: '1'",
				),
			),
	};
	await expect(createVmafQueueRegistry(redis).claim("worker")).resolves.toBe(
		true,
	);
	expect(redis.eval.mock.calls.map((call) => call[5])).toEqual([
		"claim",
		"owns",
	]);
});
