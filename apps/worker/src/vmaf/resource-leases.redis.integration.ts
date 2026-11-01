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

let directory: string | undefined, socket: string | undefined;
let server: ChildProcess | undefined,
	serverLog = "";
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
async function client() {
	const options = {
		lazyConnect: true,
		enableOfflineQueue: false,
		maxRetriesPerRequest: 1,
		retryStrategy: () => null,
	};
	const redis = serverUrl
		? new Redis(serverUrl, options)
		: new Redis({ ...options, path: socket });
	redis.on("error", () => {});
	await redis.connect();
	connections.push(redis);
	return redis;
}
async function serverTime() {
	const [seconds, microseconds] = await admin.time();
	return Number(seconds) * 1000 + Math.floor(Number(microseconds) / 1000);
}
async function cleanup() {
	for (const connection of connections) connection.disconnect();
	if (server && server.exitCode === null && server.signalCode === null) {
		server.kill("SIGTERM");
		await Promise.race([
			new Promise<void>((r) => server?.once("exit", () => r())),
			sleep(2000),
		]);
		if (server.exitCode === null && server.signalCode === null)
			server.kill("SIGKILL");
	}
	if (directory) await rm(directory, { recursive: true, force: true });
}
beforeAll(async () => {
	try {
		if (!serverUrl) {
			// A short private pathname also fits the macOS UNIX socket limit.
			directory = await mkdtemp("/tmp/bitovp-redis-");
			await chmod(directory, 0o700);
			socket = join(directory, "redis.sock");
			server = spawn(
				process.env.VMAF_RESOURCE_LEASE_TEST_REDIS_SERVER ?? "redis-server",
				[
					"--port",
					"0",
					"--unixsocket",
					socket,
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
			let failure: Error | undefined;
			server.on("error", (error) => {
				failure = error;
			});
			const log = (chunk: Buffer) => {
				serverLog = (serverLog + chunk.toString()).slice(-32000);
			};
			server.stdout?.on("data", log);
			server.stderr?.on("data", log);
			await until(async () => {
				if (failure) throw failure;
				if (server?.exitCode !== null)
					throw new Error(`Private Redis exited: ${serverLog}`);
				try {
					const c = await client();
					await c.ping();
					admin = c;
					return true;
				} catch {
					return false;
				}
			});
		} else admin = await client();
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
