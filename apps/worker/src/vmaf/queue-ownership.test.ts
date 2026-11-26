import { DelayedError, type Job } from "bullmq";
import { afterEach, expect, it, vi } from "vitest";
import {
	closeVmafBullWorker,
	closeVmafQueueConsumer,
	createDedicatedVmafRegistration,
	createVmafQueueRegistry,
	guardVmafQueueOwnership,
	readVmafQueueDatabase,
	startStandardVmafConsumer,
} from "./queue-ownership";

afterEach(() => vi.useRealTimers());

function standardConsumerFixture() {
	const registry = {
		claim: vi.fn(async (_role: string) => true),
		owns: vi.fn(async (_role: string) => true),
		release: vi.fn(async (_role: string) => true),
	};
	const drain = vi.fn(async () => {});
	const start = vi.fn((_owns: () => Promise<boolean>) => ({ close: drain }));
	return { registry, drain, start };
}

it("starts standard QC once Redis accepts a late registration", async () => {
	vi.useFakeTimers();
	const { registry, start, drain } = standardConsumerFixture();
	registry.claim.mockRejectedValueOnce(new Error("Redis unavailable"));
	const consumer = startStandardVmafConsumer(registry, start);
	await vi.advanceTimersByTimeAsync(0);
	expect(start).not.toHaveBeenCalled();
	await vi.advanceTimersByTimeAsync(5_000);
	expect(registry.claim).toHaveBeenCalledTimes(2);
	expect(start).toHaveBeenCalledOnce();
	await vi.advanceTimersByTimeAsync(5_000);
	expect(registry.claim).toHaveBeenCalledTimes(2);
	await consumer.close();
	expect(drain).toHaveBeenCalledOnce();
	expect(registry.release).toHaveBeenCalledExactlyOnceWith("worker");
});

it("never starts standard QC against a registered dedicated owner", async () => {
	vi.useFakeTimers();
	const { registry, start } = standardConsumerFixture();
	registry.claim.mockResolvedValue(false);
	const consumer = startStandardVmafConsumer(registry, start);
	await vi.advanceTimersByTimeAsync(10_000);
	expect(start).not.toHaveBeenCalled();
	await consumer.close();
	const checks = registry.claim.mock.calls.length;
	await vi.advanceTimersByTimeAsync(5_000);
	expect(registry.claim).toHaveBeenCalledTimes(checks);
	expect(registry.release).not.toHaveBeenCalled();
});

it("waits for a pending registration on shutdown and never starts a worker afterward", async () => {
	const { registry, start } = standardConsumerFixture();
	let finish = (_owned: boolean) => {};
	registry.claim.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				finish = resolve;
			}),
	);
	const consumer = startStandardVmafConsumer(registry, start);
	const closing = consumer.close();
	await Promise.resolve();
	expect(registry.release).not.toHaveBeenCalled();
	finish(true);
	await closing;
	expect(start).not.toHaveBeenCalled();
	expect(registry.release).toHaveBeenCalledExactlyOnceWith("worker");
	expect(consumer.close()).toBe(closing);
});

it("reacquires a lost token only with a confirmed claim and honors a dedicated conflict", async () => {
	vi.useFakeTimers();
	const { registry, start } = standardConsumerFixture();
	const consumer = startStandardVmafConsumer(registry, start);
	await vi.advanceTimersByTimeAsync(0);
	const [owns] = start.mock.calls[0] ?? [];
	if (!owns) throw new Error("Standard worker did not start");
	registry.owns.mockResolvedValue(false);
	registry.claim.mockResolvedValueOnce(false);
	await expect(owns()).resolves.toBe(false);

	let finish = (_owned: boolean) => {};
	registry.claim.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				finish = resolve;
			}),
	);
	const first = owns();
	const second = owns();
	await vi.advanceTimersByTimeAsync(0);
	expect(registry.claim).toHaveBeenCalledTimes(3);
	finish(true);
	await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
	await consumer.close();
});

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

it("drains active handlers before closing Redis and retains ownership if broker close hangs", async () => {
	vi.useFakeTimers();
	let finish = () => {};
	const work = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const consume = vi.fn(async () => work);
	const handle = guardVmafQueueOwnership(async () => true, consume);
	const job = {
		token: "lock",
		moveToDelayed: vi.fn(async () => {}),
	} as unknown as Job;
	const worker = {
		pause: vi.fn(async () => {}),
		close: vi.fn(() => new Promise<void>(() => {})),
	};
	const active = handle(job);
	await vi.advanceTimersByTimeAsync(0);
	const release = vi.fn(async () => {});
	const closing = closeVmafQueueConsumer(
		() => closeVmafBullWorker(worker, handle.drain),
		release,
	);
	const notice = expect(closing).rejects.toThrow(
		"VMAF_QUEUE_BROKER_CLOSE_UNCONFIRMED",
	);
	await expect(handle(job)).rejects.toBeInstanceOf(DelayedError);
	await vi.advanceTimersByTimeAsync(7_000);
	expect(consume).toHaveBeenCalledOnce();
	expect(worker.pause).toHaveBeenCalledExactlyOnceWith(true);
	expect(worker.close).not.toHaveBeenCalled();
	finish();
	await active;
	await vi.advanceTimersByTimeAsync(7_000);
	await notice;
	expect(release).not.toHaveBeenCalled();
});

it("stops startup and releases a possibly written dedicated claim even when its reply was lost", async () => {
	let loseReply = (_error: Error) => {};
	const registry = {
		claim: vi.fn(
			() =>
				new Promise<boolean>((_resolve, reject) => {
					loseReply = reject;
				}),
		),
		release: vi.fn(async () => true),
	};
	const drain = vi.fn(async () => {});
	const registration = createDedicatedVmafRegistration(registry, drain);
	const claim = expect(registration.claim("b".repeat(64))).rejects.toThrow(
		"reply lost",
	);
	const closing = registration.close();
	expect(registration.signal.aborted).toBe(true);
	expect(registry.release).not.toHaveBeenCalled();
	loseReply(new Error("reply lost"));
	await claim;
	await closing;
	expect(drain).toHaveBeenCalledOnce();
	expect(registry.release).toHaveBeenCalledExactlyOnceWith("dedicated");
	expect(registration.close()).toBe(closing);
});

it("retries the exact release during Redis reconnect after the handler drains", async () => {
	vi.useFakeTimers();
	const release = vi
		.fn(async () => {})
		.mockRejectedValueOnce(new Error("Redis reconnecting"));
	const closing = closeVmafQueueConsumer(async () => {}, release);
	const receipt = expect(closing).resolves.toBeUndefined();
	await vi.advanceTimersByTimeAsync(5_000);
	await receipt;
	expect(release).toHaveBeenCalledTimes(2);
});

it("confirms a dedicated removal reached AOF even when retry finds no registered key", async () => {
	const redis = {
		eval: vi.fn().mockResolvedValueOnce(2).mockResolvedValueOnce(1),
		call: vi.fn().mockResolvedValue([1, 0]),
	};
	await expect(
		createVmafQueueRegistry(redis).release("dedicated"),
	).resolves.toBe(false);
	expect(redis.call).toHaveBeenCalledExactlyOnceWith("WAITAOF", 1, 0, 2_000);
});

it("refuses a release receipt if reconnect loses the retirement marker", async () => {
	const redis = {
		eval: vi.fn().mockResolvedValueOnce(3).mockResolvedValueOnce(0),
		call: vi.fn().mockResolvedValue([1, 0]),
	};
	await expect(
		createVmafQueueRegistry(redis).release("dedicated"),
	).rejects.toThrow("VMAF_QUEUE_DURABLE_RELEASE_UNAVAILABLE");
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
	expect(redis.eval.mock.calls.map((call) => call[6])).toEqual([
		"claim",
		"abandon",
	]);
});

it("binds topology to the live writable database, its schema and its restart epoch", async () => {
	const sample = {
		name: "bitovp",
		oid: "16392",
		schema: "public",
		schemaOid: "2200",
		epoch: "1795734000.001234",
	};
	const query = vi.fn(async () => [sample]);
	const prisma = { $queryRaw: query } as never;
	const first = await readVmafQueueDatabase(prisma);
	expect(first).toMatch(/^[a-f0-9]{64}$/);
	for (const variant of [
		{ name: "another", oid: "16393" },
		{ epoch: "1795734111.001234" },
		{ schema: "qc_archive", schemaOid: "16394" },
		{ schemaOid: "16395" },
	]) {
		query.mockResolvedValueOnce([{ ...sample, ...variant }]);
		expect(await readVmafQueueDatabase(prisma)).not.toBe(first);
	}
	for (const invalid of [[], [{ ...sample, schemaOid: "" }]]) {
		query.mockResolvedValueOnce(invalid);
		await expect(readVmafQueueDatabase(prisma)).rejects.toThrow(
			"VMAF_QUEUE_DATABASE_IDENTITY_UNAVAILABLE",
		);
	}
});

it.each([
	"ERR unknown command 'WAITAOF', with args beginning with: '1'",
	"NOPERM User default has no permissions to run the 'waitaof' command",
])("keeps ordinary queue consumption available when the persistence command is unavailable (%s)", async (message) => {
	const redis = {
		eval: vi.fn().mockResolvedValueOnce(2).mockResolvedValueOnce(1),
		call: vi.fn().mockRejectedValue(new Error(message)),
	};
	await expect(createVmafQueueRegistry(redis).claim("worker")).resolves.toBe(
		true,
	);
	expect(redis.eval.mock.calls.map((call) => call[6])).toEqual([
		"claim",
		"owns",
	]);
});
