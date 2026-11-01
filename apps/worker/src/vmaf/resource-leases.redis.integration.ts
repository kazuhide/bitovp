import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { Redis } from "ioredis";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
	createVmafResourceLeases,
	type ResourceLeaseRedis,
	VMAF_GPU_COMPUTE_CREDITS,
	type VmafResourceLeaseRequest,
} from "./resource-leases";

let socket: string | undefined;
let ownedServer: Awaited<ReturnType<typeof privateRedis>> | undefined;
let admin: Redis;
const connections: Redis[] = [];
const serverUrl = process.env.VMAF_RESOURCE_LEASE_TEST_REDIS_URL;
if (serverUrl !== undefined && serverUrl !== "redis://127.0.0.1:16381")
	throw new Error("Only the dedicated local Redis test service is permitted");
const sleep = (milliseconds: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
const deferred = () => {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
};
async function until(check: () => Promise<boolean> | boolean, timeout = 5000) {
	const started = performance.now();
	while (!(await check())) {
		if (performance.now() - started > timeout)
			throw new Error("Redis test condition timed out");
		await sleep(10);
	}
}
const redisOptions = {
	lazyConnect: true,
	enableOfflineQueue: false,
	maxRetriesPerRequest: 1,
	retryStrategy: () => null,
};
async function connectRedis(target: string | { path: string }) {
	const redis =
		typeof target === "string"
			? new Redis(target, redisOptions)
			: new Redis({ ...redisOptions, ...target });
	redis.on("error", () => {});
	try {
		await redis.connect();
		connections.push(redis);
		return redis;
	} catch (error) {
		redis.disconnect();
		throw error;
	}
}
async function client() {
	return connectRedis(serverUrl ?? { path: socket as string });
}
async function serverTime() {
	const [seconds, microseconds] = await admin.time();
	return Number(seconds) * 1000 + Math.floor(Number(microseconds) / 1000);
}
function serverIdentity(info: string) {
	const runId = info.match(/(?:^|\r?\n)run_id:([a-f0-9]{40})(?:\r?\n|$)/)?.[1];
	const uptime = Number(
		info.match(/(?:^|\r?\n)uptime_in_seconds:(\d+)(?:\r?\n|$)/)?.[1],
	);
	if (!runId || !Number.isSafeInteger(uptime))
		throw new Error("Private Redis did not report its server identity");
	return { runId, uptime };
}
async function warm(redis: Redis, seconds: number) {
	await until(
		async () => serverIdentity(await redis.info("server")).uptime >= seconds,
	);
}
async function privateRedis() {
	// A short private pathname also fits the macOS UNIX socket limit.
	const directory = await mkdtemp("/tmp/bitovp-redis-");
	await chmod(directory, 0o700);
	const path = join(directory, "redis.sock");
	let child: ChildProcess | undefined;
	async function stop() {
		if (!child || child.exitCode !== null || child.signalCode !== null) return;
		const stopped = new Promise<void>((resolve) =>
			child?.once("exit", () => resolve()),
		);
		child.kill("SIGTERM");
		await Promise.race([stopped, sleep(2000)]);
		if (child.exitCode === null && child.signalCode === null) {
			child.kill("SIGKILL");
			await stopped;
		}
	}
	return {
		path,
		async start() {
			child = spawn(
				process.env.VMAF_RESOURCE_LEASE_TEST_REDIS_SERVER ?? "redis-server",
				[
					"--port",
					"0",
					"--unixsocket",
					path,
					"--unixsocketperm",
					"700",
					"--save",
					"",
					"--appendonly",
					"no",
					"--maxmemory",
					"32mb",
					"--maxmemory-policy",
					"noeviction",
					"--dir",
					directory,
					"--loglevel",
					"warning",
				],
				{ stdio: ["ignore", "pipe", "pipe"] },
			);
			let failure: Error | undefined,
				log = "";
			child.on("error", (error) => {
				failure = error;
			});
			const record = (chunk: Buffer) => {
				log = (log + chunk.toString()).slice(-32000);
			};
			child.stdout?.on("data", record);
			child.stderr?.on("data", record);
			let ready: Redis | undefined;
			await until(async () => {
				if (failure) throw failure;
				if (child?.exitCode !== null)
					throw new Error(`Private Redis exited: ${log}`);
				try {
					ready = await connectRedis({ path });
					await ready.ping();
					return true;
				} catch {
					return false;
				}
			});
			return ready as Redis;
		},
		stop,
		async cleanup() {
			await stop();
			await rm(directory, { recursive: true, force: true });
		},
	};
}
async function cleanup() {
	for (const connection of connections) connection.disconnect();
	await ownedServer?.cleanup();
}
beforeAll(async () => {
	try {
		if (serverUrl) admin = await client();
		else {
			ownedServer = await privateRedis();
			socket = ownedServer.path;
			admin = await ownedServer.start();
		}
		// Include one whole second for the server uptime counter granularity.
		await warm(admin, 3);
	} catch (error) {
		await cleanup();
		throw error;
	}
});
afterAll(cleanup);

const baseRequest = (): VmafResourceLeaseRequest => ({
	hostKey: "host-a",
	deviceKey: "gpu-a",
	capacity: {
		cpuMilliCores: 8000,
		hostBytes: 8192,
		gpuBytes: 8192,
		gpuComputeCredits: VMAF_GPU_COMPUTE_CREDITS,
	},
	requested: {
		cpuMilliCores: 1000,
		hostBytes: 1024,
		gpuBytes: 1024,
		gpuComputeCredits: VMAF_GPU_COMPUTE_CREDITS / 2,
	},
});
async function managers(
	patch: Partial<Parameters<typeof createVmafResourceLeases>[0]> = {},
) {
	const namespace = `vmaf-lease-test-${randomUUID()}`;
	const a = await client(),
		b = await client();
	const make = (redis: ResourceLeaseRedis) =>
		createVmafResourceLeases({
			redis,
			namespace,
			leaseMs: 1500,
			renewMs: 100,
			drainMarginMs: 250,
			pollMs: 10,
			operationTimeoutMs: 250,
			...patch,
		});
	const prefix = `${namespace}:{vmaf-resources}`;
	return {
		a: make(a),
		b: make(b),
		redisA: a,
		redisB: b,
		make,
		active: `${prefix}:active`,
		expiry: `${prefix}:expiry`,
		waiting: `${prefix}:host:host-a:waiting`,
		queue: `${prefix}:host:host-a:queue`,
	};
}

it("two independent clients run eight units through one two-comparison GPU pool", async () => {
	const m = await managers();
	let active = 0,
		maximum = 0;
	const completed = await Promise.all(
		Array.from({ length: 8 }, (_, index) =>
			(index % 2 ? m.a : m.b).run(
				baseRequest(),
				new AbortController().signal,
				async ({ assertOwned }) => {
					active++;
					maximum = Math.max(maximum, active);
					try {
						await sleep(25);
						await assertOwned();
						return index;
					} finally {
						active--;
					}
				},
			),
		),
	);
	expect(maximum).toBe(2);
	expect(new Set(completed).size).toBe(8);
	expect(await admin.hlen(m.active)).toBe(0);
});

it.each([
	"cpuMilliCores",
	"hostBytes",
	"gpuBytes",
	"gpuComputeCredits",
] as const)("enforces %s independently from the other resource dimensions", async (dimension) => {
	const m = await managers();
	const request = baseRequest();
	request.requested.gpuComputeCredits = VMAF_GPU_COMPUTE_CREDITS / 8;
	request.capacity[dimension] = (request.requested[dimension] as number) * 2;
	let active = 0,
		maximum = 0;
	await Promise.all(
		Array.from({ length: 6 }, (_, index) =>
			(index % 2 ? m.a : m.b).run(
				request,
				new AbortController().signal,
				async () => {
					active++;
					maximum = Math.max(maximum, active);
					try {
						await sleep(20);
					} finally {
						active--;
					}
				},
			),
		),
	);
	expect(maximum).toBe(2);
});

it("accounts for a shared physical GPU across different host identities without blocking another GPU", async () => {
	const m = await managers(),
		first = deferred(),
		hold = deferred(),
		other = deferred();
	const request = baseRequest();
	request.requested.gpuComputeCredits = VMAF_GPU_COMPUTE_CREDITS;
	const one = m.a.run(request, new AbortController().signal, async () => {
		first.resolve();
		await hold.promise;
	});
	await first.promise;
	let sharedStarted = false;
	const two = m.b.run(
		{ ...request, hostKey: "host-b" },
		new AbortController().signal,
		async () => {
			sharedStarted = true;
		},
	);
	try {
		await m.b.run(
			{ ...request, hostKey: "host-c", deviceKey: "gpu-c" },
			new AbortController().signal,
			async () => other.resolve(),
		);
		await other.promise;
		expect(sharedStarted).toBe(false);
	} finally {
		hold.resolve();
		await one;
		await two;
	}
	expect(sharedStarted).toBe(true);
});

it("does not block an unrelated host behind another host's FIFO", async () => {
	const m = await managers(),
		started = deferred(),
		hold = deferred();
	const request = baseRequest();
	request.requested.cpuMilliCores = 8000;
	const first = m.a.run(request, new AbortController().signal, async () => {
		started.resolve();
		await hold.promise;
	});
	await started.promise;
	const second = m.a.run(request, new AbortController().signal, async () => 2);
	await until(async () => (await admin.hlen(m.waiting)) === 1);
	try {
		const foreign = await m.b.run(
			{
				hostKey: "host-b",
				capacity: { cpuMilliCores: 8000, hostBytes: 8192 },
				requested: { cpuMilliCores: 1000, hostBytes: 1024 },
			},
			new AbortController().signal,
			async () => 3,
		);
		expect(foreign).toBe(3);
	} finally {
		hold.resolve();
		await first;
		await second;
	}
});

it("never starts a cancelled queued unit and advances the host FIFO", async () => {
	const m = await managers(),
		started = deferred(),
		hold = deferred();
	const request = baseRequest();
	request.requested.gpuComputeCredits = VMAF_GPU_COMPUTE_CREDITS;
	const first = m.a.run(request, new AbortController().signal, async () => {
		started.resolve();
		await hold.promise;
	});
	await started.promise;
	const cancel = new AbortController();
	let cancelledStarted = false;
	const cancelled = m.b.run(request, cancel.signal, async () => {
		cancelledStarted = true;
	});
	const rejected = expect(cancelled).rejects.toThrow("cancelled");
	await until(async () => (await admin.hlen(m.waiting)) === 1);
	const after = m.a.run(request, new AbortController().signal, async () => 42);
	await until(async () => (await admin.hlen(m.waiting)) === 2);
	cancel.abort(new Error("cancelled"));
	await rejected;
	hold.resolve();
	await first;
	expect(await after).toBe(42);
	expect(cancelledStarted).toBe(false);
});

it("keeps a large host FIFO head ahead of a smaller reservation that could fit", async () => {
	const m = await managers(),
		started = deferred(),
		hold = deferred(),
		headStarted = deferred(),
		headHold = deferred();
	const holder = m.a.run(
		baseRequest(),
		new AbortController().signal,
		async () => {
			started.resolve();
			await hold.promise;
		},
	);
	await started.promise;
	const headRequest = baseRequest();
	headRequest.requested.gpuComputeCredits = VMAF_GPU_COMPUTE_CREDITS;
	const head = m.b.run(headRequest, new AbortController().signal, async () => {
		headStarted.resolve();
		await headHold.promise;
	});
	await until(async () => (await admin.hlen(m.waiting)) === 1);
	let behindStarted = false;
	const behind = m.a.run(
		baseRequest(),
		new AbortController().signal,
		async () => {
			behindStarted = true;
		},
	);
	try {
		await until(
			async () => behindStarted || (await admin.hlen(m.waiting)) === 2,
		);
		await sleep(30);
		expect(behindStarted).toBe(false);
		hold.resolve();
		await holder;
		await headStarted.promise;
		expect(behindStarted).toBe(false);
	} finally {
		hold.resolve();
		headHold.resolve();
		await holder;
		await head;
		await behind;
	}
});

it("does not run work after an acquire reply times out even if Redis granted it", async () => {
	const m = await managers({
		leaseMs: 500,
		renewMs: 100,
		operationTimeoutMs: 30,
	});
	let started = false;
	const slow = m.make({
		eval: async (script, count, ...args) => {
			const reply = await m.redisA.eval(script, count, ...args);
			if (args[count] === "acquire") await sleep(100);
			return reply;
		},
	});
	await expect(
		slow.run(baseRequest(), new AbortController().signal, async () => {
			started = true;
		}),
	).rejects.toMatchObject({ code: "UNAVAILABLE" });
	await sleep(120);
	expect(started).toBe(false);
	expect(await admin.hlen(m.active)).toBe(0);
});

it("releases failed work once and ignores replayed or foreign release tokens", async () => {
	const m = await managers();
	let releaseArgs: [string, number, ...string[]] | undefined;
	const instrumented = m.make({
		eval: async (script, count, ...args) => {
			if (args[count] === "release" && !releaseArgs)
				releaseArgs = [script, count, ...args];
			return m.redisA.eval(script, count, ...args);
		},
	});
	await expect(
		instrumented.run(baseRequest(), new AbortController().signal, async () => {
			throw new Error("work failed");
		}),
	).rejects.toThrow("work failed");
	const started = deferred(),
		hold = deferred();
	const next = m.b.run(
		baseRequest(),
		new AbortController().signal,
		async () => {
			started.resolve();
			await hold.promise;
		},
	);
	await started.promise;
	try {
		expect(releaseArgs).toBeDefined();
		const args = releaseArgs as [string, number, ...string[]];
		expect(((await m.redisA.eval(...args)) as unknown[])[0]).toBe(0);
		const foreign = [...args] as [string, number, ...string[]];
		foreign[2 + args[1] + 1] = randomUUID();
		expect(((await m.redisA.eval(...foreign)) as unknown[])[0]).toBe(0);
		expect(await admin.hlen(m.active)).toBe(1);
	} finally {
		hold.resolve();
		await next;
	}
});

it("keeps renewal and reservations until cancelled work has actually settled", async () => {
	const m = await managers({
		leaseMs: 300,
		renewMs: 50,
		operationTimeoutMs: 100,
		drainMarginMs: 100,
	});
	const started = deferred(),
		hold = deferred(),
		request = baseRequest();
	request.requested.gpuComputeCredits = VMAF_GPU_COMPUTE_CREDITS;
	const cancel = new AbortController();
	let signal: AbortSignal | undefined;
	const first = m.a.run(request, cancel.signal, async (lease) => {
		signal = lease.signal;
		started.resolve();
		await hold.promise;
	});
	const rejected = expect(first).rejects.toThrow("cancelled");
	await started.promise;
	let secondStarted = false;
	const second = m.b.run(request, new AbortController().signal, async () => {
		secondStarted = true;
	});
	try {
		cancel.abort(new Error("cancelled"));
		expect(signal?.aborted).toBe(true);
		await sleep(750);
		expect(secondStarted).toBe(false);
		expect(await admin.hlen(m.active)).toBe(1);
	} finally {
		hold.resolve();
		await rejected;
		await second;
	}
});

it("aborts on uncertain renewal and does not release before the work settles", async () => {
	const m = await managers();
	const entered = deferred(),
		aborted = deferred(),
		hold = deferred();
	const request = baseRequest();
	request.requested.gpuComputeCredits = VMAF_GPU_COMPUTE_CREDITS;
	const failing = m.make({
		eval: async (script, count, ...args) => {
			if (args[count] === "renew")
				throw new Error("Synthetic unavailable Redis reply");
			return m.redisA.eval(script, count, ...args);
		},
	});
	const first = failing.run(
		request,
		new AbortController().signal,
		async ({ signal, assertOwned }) => {
			signal.addEventListener("abort", () => aborted.resolve(), { once: true });
			entered.resolve();
			await aborted.promise;
			await expect(assertOwned()).rejects.toMatchObject({
				code: "UNAVAILABLE",
			});
			await hold.promise;
		},
	);
	const rejected = expect(first).rejects.toMatchObject({ code: "UNAVAILABLE" });
	await entered.promise;
	let nextStarted = false;
	const next = m.b.run(request, new AbortController().signal, async () => {
		nextStarted = true;
	});
	try {
		await aborted.promise;
		await sleep(30);
		expect(nextStarted).toBe(false);
		expect(await admin.hlen(m.active)).toBe(1);
	} finally {
		hold.resolve();
		await rejected;
		await next;
	}
});

it("checks authority before publishing and refuses an externally lost reservation", async () => {
	const m = await managers();
	let published = false;
	await expect(
		m.a.run(
			baseRequest(),
			new AbortController().signal,
			async ({ assertOwned }) => {
				const tokens = await admin.hkeys(m.active);
				expect(tokens).toHaveLength(1);
				await admin.hdel(m.active, tokens[0] as string);
				await assertOwned();
				published = true;
			},
		),
	).rejects.toMatchObject({ code: "LOST" });
	expect(published).toBe(false);
	expect(await admin.zcard(m.expiry)).toBe(0);
});

it("refreshes retention keys while a valid holder keeps renewing", async () => {
	const m = await managers(),
		entered = deferred(),
		hold = deferred();
	const current = m.a.run(
		baseRequest(),
		new AbortController().signal,
		async () => {
			entered.resolve();
			await hold.promise;
		},
	);
	await entered.promise;
	try {
		await admin.pexpire(m.active, 1000);
		await admin.pexpire(m.expiry, 1000);
		await until(async () => (await admin.pttl(m.active)) > 60000);
		expect(await admin.hlen(m.active)).toBe(1);
	} finally {
		hold.resolve();
		await current;
	}
});

it("preserves exact large integer credits for a three-comparison pool", async () => {
	const m = await managers(),
		request = baseRequest();
	request.requested.gpuComputeCredits = VMAF_GPU_COMPUTE_CREDITS / 3;
	let active = 0,
		maximum = 0;
	const hold = deferred(),
		three = deferred();
	const work = Array.from({ length: 4 }, (_, index) =>
		(index % 2 ? m.a : m.b).run(
			request,
			new AbortController().signal,
			async () => {
				active++;
				maximum = Math.max(maximum, active);
				if (active === 3) three.resolve();
				try {
					await hold.promise;
				} finally {
					active--;
				}
			},
		),
	);
	try {
		await three.promise;
		const rows = await admin.hvals(m.active);
		expect(rows).toHaveLength(3);
		for (const row of rows) {
			expect(row.split("|")[5]).toBe(String(VMAF_GPU_COMPUTE_CREDITS));
			expect(row.split("|")[9]).toBe("48134517631200");
		}
	} finally {
		hold.resolve();
		await Promise.all(work);
	}
	expect(maximum).toBe(3);
});

async function crashOwner(
	mode: "active" | "queued",
	namespace: string,
	request: VmafResourceLeaseRequest,
) {
	const module = fileURLToPath(
		new URL("./resource-leases.ts", import.meta.url),
	);
	const code =
		`import { Redis } from 'ioredis';\nimport {createVmafResourceLeases} from ${JSON.stringify(module)};\n` +
		`const c=new Redis(${JSON.stringify(serverUrl ?? { path: socket })},{maxRetriesPerRequest:1});\n` +
		`await c.ping();process.stdout.write('READY\\n');\n` +
		`await createVmafResourceLeases({redis:c,namespace:${JSON.stringify(namespace)},leaseMs:400,renewMs:50,pollMs:10,operationTimeoutMs:100,drainMarginMs:500})` +
		`.run(${JSON.stringify(request)},new AbortController().signal,async()=>{process.stdout.write('HELD\\n');await new Promise(()=>{})});`;
	const child = spawn(
		process.execPath,
		["--import", "tsx", "--input-type=module", "-e", code],
		{ stdio: ["ignore", "pipe", "pipe"] },
	);
	let stdout = "",
		stderr = "";
	child.stdout?.on("data", (chunk) => {
		stdout += chunk.toString();
	});
	child.stderr?.on("data", (chunk) => {
		stderr += chunk.toString();
	});
	try {
		await until(() => {
			if (child.exitCode !== null || child.signalCode !== null)
				throw new Error(`Lease fixture exited: ${stderr}`);
			return stdout.includes(mode === "active" ? "HELD\n" : "READY\n");
		});
		return child;
	} catch (error) {
		child.kill("SIGKILL");
		throw error;
	}
}
async function killOwner(child: ChildProcess) {
	const stopped = new Promise<void>((resolve) =>
		child.once("exit", () => resolve()),
	);
	child.kill("SIGKILL");
	await stopped;
}

it("recovers a genuinely crashed owner only after its lease plus drain margin", async () => {
	const m = await managers(),
		request = baseRequest();
	request.requested.gpuComputeCredits = VMAF_GPU_COMPUTE_CREDITS;
	const namespace = m.active.split(":{vmaf-resources}")[0] as string;
	const child = await crashOwner("active", namespace, request);
	const rows = await admin.zrange(m.expiry, 0, 0, "WITHSCORES");
	expect(rows).toHaveLength(2);
	const retainedUntil = Number(rows[1]);
	await killOwner(child);
	await m.b.run(request, new AbortController().signal, async () => {
		expect(await serverTime()).toBeGreaterThanOrEqual(retainedUntil);
	});
	expect(await admin.hlen(m.active)).toBe(0);
});

it("cleans up a genuinely crashed waiting owner and lets the next live ticket run", async () => {
	const m = await managers(),
		request = baseRequest();
	request.requested.gpuComputeCredits = VMAF_GPU_COMPUTE_CREDITS;
	const namespace = m.active.split(":{vmaf-resources}")[0] as string;
	const entered = deferred(),
		hold = deferred();
	const holder = m.a.run(request, new AbortController().signal, async () => {
		entered.resolve();
		await hold.promise;
	});
	await entered.promise;
	let child: ChildProcess | undefined;
	try {
		child = await crashOwner("queued", namespace, request);
		await until(async () => (await admin.hlen(m.waiting)) === 1);
		const values = await admin.hvals(m.waiting);
		const expires = Number(values[0]);
		await killOwner(child);
		child = undefined;
		const next = m.b.run(request, new AbortController().signal, async () => {
			expect(await serverTime()).toBeGreaterThanOrEqual(expires);
		});
		hold.resolve();
		await holder;
		await next;
		expect(await admin.hlen(m.waiting)).toBe(0);
	} finally {
		hold.resolve();
		await holder;
		if (child) await killOwner(child);
	}
});

it("allows INFO server inside the atomic Redis script", async () => {
	const info = await admin.eval("return redis.call('INFO', 'server')", 0);
	expect(serverIdentity(String(info)).uptime).toBeGreaterThanOrEqual(3);
});

it("retains a cold-start ticket until the full startup drain fence has elapsed", async () => {
	const owned = await privateRedis();
	let redis: Redis | undefined;
	const cancel = new AbortController();
	let completion: Promise<unknown> | undefined;
	try {
		redis = await owned.start();
		const namespace = `vmaf-lease-test-${randomUUID()}`;
		const waiting = `${namespace}:{vmaf-resources}:host:host-a:waiting`;
		let startedAt: number | undefined;
		completion = createVmafResourceLeases({
			redis,
			namespace,
			leaseMs: 700,
			renewMs: 100,
			drainMarginMs: 100,
			pollMs: 10,
			operationTimeoutMs: 100,
		}).run(baseRequest(), cancel.signal, async () => {
			startedAt = serverIdentity(await (redis as Redis).info("server")).uptime;
		});
		// Attach rejection handling before the cleanup cancellation can occur.
		completion.catch(() => {});
		await until(
			async () =>
				startedAt !== undefined || (await (redis as Redis).hlen(waiting)) === 1,
		);
		expect(startedAt).toBeUndefined();
		const tickets = await redis.hkeys(waiting);
		expect(tickets).toHaveLength(1);
		await sleep(50);
		expect(startedAt).toBeUndefined();
		expect(await redis.hkeys(waiting)).toEqual(tickets);
		await completion;
		expect(startedAt).toBeGreaterThanOrEqual(2);
	} finally {
		cancel.abort(new Error("Private Redis test cleanup"));
		await completion?.catch(() => {});
		redis?.disconnect();
		await owned.cleanup();
	}
});

it("fences an actual Redis restart and refuses an RDB-restored owner from the previous server", async () => {
	const owned = await privateRedis(),
		resume = deferred();
	let redis: Redis | undefined, previous: Promise<unknown> | undefined;
	let next: Promise<unknown> | undefined;
	const cancel = new AbortController();
	try {
		redis = await owned.start();
		await warm(redis, 3);
		const before = serverIdentity(await redis.info("server"));
		const namespace = `vmaf-lease-test-${randomUUID()}`;
		const prefix = `${namespace}:{vmaf-resources}`;
		const entered = deferred();
		let check: [string, number, ...string[]] | undefined;
		let published = false;
		const broker = createVmafResourceLeases({
			redis: {
				eval: async (script, count, ...args) => {
					if (args[count] === "check") check = [script, count, ...args];
					return (redis as Redis).eval(script, count, ...args);
				},
			},
			namespace,
			leaseMs: 1500,
			renewMs: 800,
			drainMarginMs: 100,
			pollMs: 10,
			operationTimeoutMs: 100,
		});
		previous = broker.run(
			baseRequest(),
			new AbortController().signal,
			async ({ assertOwned }) => {
				await assertOwned();
				entered.resolve();
				await resume.promise;
				await assertOwned();
				published = true;
			},
		);
		const outcome = previous.then(
			() => null,
			(error: unknown) => error,
		);
		await entered.promise;
		expect(await redis.hlen(`${prefix}:active`)).toBe(1);
		await redis.save();
		await owned.stop();
		redis.disconnect();
		redis = await owned.start();
		const after = serverIdentity(await redis.info("server"));
		expect(after.runId).not.toBe(before.runId);
		expect(await redis.hlen(`${prefix}:active`)).toBe(1);
		// Exercise the same atomic check against restored data and the new server,
		// rather than merely observing an old disconnected client's error.
		expect(check).toBeDefined();
		const reply = await redis.eval(...(check as [string, number, ...string[]]));
		expect((reply as unknown[])[0]).toBe(0);
		resume.resolve();
		expect(await outcome).toMatchObject({ code: "LOST" });
		expect(published).toBe(false);
		let startedAt: number | undefined;
		next = broker.run(baseRequest(), cancel.signal, async () => {
			startedAt = serverIdentity(await (redis as Redis).info("server")).uptime;
		});
		next.catch(() => {});
		const waiting = `${prefix}:host:host-a:waiting`;
		await until(
			async () =>
				startedAt !== undefined || (await (redis as Redis).hlen(waiting)) === 1,
		);
		expect(startedAt).toBeUndefined();
		expect(await redis.hlen(waiting)).toBe(1);
		await next;
		expect(startedAt).toBeGreaterThanOrEqual(3);
	} finally {
		resume.resolve();
		cancel.abort(new Error("Private Redis test cleanup"));
		await previous?.catch(() => {});
		await next?.catch(() => {});
		redis?.disconnect();
		await owned.cleanup();
	}
});

it("fails closed when the Redis user cannot inspect server identity", async () => {
	const user = `vmaf-test-${randomUUID()}`,
		password = randomUUID();
	let restricted: Redis | undefined;
	try {
		await admin.acl(
			"SETUSER",
			user,
			"on",
			`>${password}`,
			"~*",
			"+@all",
			"-info",
		);
		restricted = serverUrl
			? new Redis(serverUrl, { ...redisOptions, username: user, password })
			: new Redis({ ...redisOptions, path: socket, username: user, password });
		restricted.on("error", () => {});
		await restricted.connect();
		const namespace = `vmaf-lease-test-${randomUUID()}`;
		let started = false;
		await expect(
			createVmafResourceLeases({ redis: restricted, namespace }).run(
				baseRequest(),
				new AbortController().signal,
				async () => {
					started = true;
				},
			),
		).rejects.toMatchObject({ code: "UNAVAILABLE" });
		expect(started).toBe(false);
		expect(await admin.hlen(`${namespace}:{vmaf-resources}:active`)).toBe(0);
	} finally {
		restricted?.disconnect();
		await admin.acl("DELUSER", user);
	}
});

it("checks combined unmaterialized RAM across two owned reservations without losing ownership on pressure", async () => {
	const m = await managers(),
		entered = deferred(),
		hold = deferred(),
		request = baseRequest();
	await m.a.run(request, new AbortController().signal, async (first) => {
		const second = m.b.run(
			request,
			new AbortController().signal,
			async (other) => {
				entered.resolve();
				await hold.promise;
				expect(
					await other.fitsHeadroom({ hostBytes: 2048, gpuBytes: 2048 }),
				).toBe(true);
			},
		);
		try {
			await entered.promise;
			expect(
				await first.fitsHeadroom({ hostBytes: 1024, gpuBytes: 1024 }),
			).toBe(false);
			expect(
				await first.fitsHeadroom({ hostBytes: 2048, gpuBytes: 1024 }),
			).toBe(false);
			expect(
				await first.fitsHeadroom({ hostBytes: 1024, gpuBytes: 2048 }),
			).toBe(false);
			expect(
				await first.fitsHeadroom({ hostBytes: 2048, gpuBytes: 2048 }),
			).toBe(true);
			expect(await first.fitsHeadroom({ hostBytes: 0, gpuBytes: 2048 })).toBe(
				false,
			);
			expect(await first.fitsHeadroom({ hostBytes: 2048, gpuBytes: 0 })).toBe(
				false,
			);
			expect(await first.fitsHeadroom({ hostBytes: 2048 })).toBe(false);
			expect(first.signal.aborted).toBe(false);
			await first.assertOwned();
		} finally {
			hold.resolve();
			await second;
		}
	});
});

it("keeps host headroom separate while accounting for one physical GPU across host identities", async () => {
	const m = await managers(),
		entered = deferred(),
		otherEntered = deferred(),
		hold = deferred(),
		request = baseRequest();
	await m.a.run(request, new AbortController().signal, async (first) => {
		const shared = m.b.run(
			{ ...request, hostKey: "host-b" },
			new AbortController().signal,
			async () => {
				entered.resolve();
				await hold.promise;
			},
		);
		const foreign = m.b.run(
			{
				...request,
				hostKey: "host-c",
				deviceKey: "gpu-c",
				requested: { ...request.requested, hostBytes: 8192, gpuBytes: 8192 },
			},
			new AbortController().signal,
			async () => {
				otherEntered.resolve();
				await hold.promise;
			},
		);
		try {
			await Promise.all([entered.promise, otherEntered.promise]);
			expect(
				await first.fitsHeadroom({ hostBytes: 1024, gpuBytes: 2048 }),
			).toBe(true);
			expect(
				await first.fitsHeadroom({ hostBytes: 1024, gpuBytes: 1024 }),
			).toBe(false);
			expect(
				await first.fitsHeadroom({ hostBytes: 1023, gpuBytes: 2048 }),
			).toBe(false);
		} finally {
			hold.resolve();
			await Promise.all([shared, foreign]);
		}
	});
});

it("treats CPU headroom independently of an optional GPU field", async () => {
	const m = await managers();
	await m.a.run(
		{
			hostKey: "host-a",
			capacity: { cpuMilliCores: 2000, hostBytes: 2048 },
			requested: { cpuMilliCores: 1000, hostBytes: 1024 },
		},
		new AbortController().signal,
		async (lease) => {
			expect(await lease.fitsHeadroom({ hostBytes: 1024 })).toBe(true);
			expect(await lease.fitsHeadroom({ hostBytes: 1024, gpuBytes: 0 })).toBe(
				true,
			);
			expect(await lease.fitsHeadroom({ hostBytes: 0 })).toBe(false);
			await lease.assertOwned();
		},
	);
});

it("makes headroom checks read-only, keeps their expiry, and excludes fully drained records", async () => {
	const m = await managers({ renewMs: 800, operationTimeoutMs: 100 });
	await m.a.run(baseRequest(), new AbortController().signal, async (lease) => {
		const token = (await admin.hkeys(m.active))[0] as string;
		const row = await admin.hget(m.active, token);
		expect(row).not.toBeNull();
		const expiry = await admin.zscore(m.expiry, token),
			expired = randomUUID();
		const fields = (row as string).split("|");
		fields[10] = String((await serverTime()) - 10000);
		await admin.hset(m.active, expired, fields.join("|"));
		await admin.zadd(m.expiry, (await serverTime()) - 1, expired);
		const ttl = await admin.pttl(m.active);
		expect(await lease.fitsHeadroom({ hostBytes: 1024, gpuBytes: 1024 })).toBe(
			true,
		);
		expect(await admin.hlen(m.active)).toBe(2);
		expect(await admin.hget(m.active, token)).toBe(row);
		expect(await admin.zscore(m.expiry, token)).toBe(expiry);
		expect(await admin.zscore(m.expiry, expired)).not.toBeNull();
		expect(await admin.pttl(m.active)).toBeLessThanOrEqual(ttl);
	});
});

it.each([
	"removed",
	"expired",
	"server-instance",
] as const)("throws LOST rather than returning headroom pressure when its reservation is %s", async (failure) => {
	const m = await managers();
	await expect(
		m.a.run(baseRequest(), new AbortController().signal, async (lease) => {
			const token = (await admin.hkeys(m.active))[0] as string;
			if (failure === "removed") await admin.hdel(m.active, token);
			else {
				const row = await admin.hget(m.active, token);
				const fields = (row as string).split("|");
				if (failure === "expired")
					fields[10] = String((await serverTime()) - 1);
				else fields[11] = "0".repeat(40);
				await admin.hset(m.active, token, fields.join("|"));
			}
			await expect(
				lease.fitsHeadroom({ hostBytes: 8192, gpuBytes: 8192 }),
			).rejects.toMatchObject({ code: "LOST" });
			expect(lease.signal.aborted).toBe(true);
		}),
	).rejects.toMatchObject({ code: "LOST" });
});
