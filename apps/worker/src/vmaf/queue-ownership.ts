import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { AppPrismaClient } from "@bitovp/db";
import { DelayedError, type Job, type Worker } from "bullmq";
import { Redis } from "ioredis";
import type { ResourceLeaseRedis } from "./resource-leases";

type Role = "worker" | "dedicated";
const ROOT = "bitovp:vmaf-queue:{owner-v1}";
const PRIMARY_REFRESH_MS = 5_000;
const PRIMARY_WITNESS_MS = 15_000;
const PERSIST_TIMEOUT_MS = 2_000;
const RELEASE_RETRY_MS = 5_000;
const WORKER_CLOSE_MS = 7_000;

// Role records are not leases. A disconnected Worker can still have active
// FFmpeg or cloud work, so only a gracefully drained holder releases its token.
// The producer witness attests a matching control plane and may expire safely.
const OWNER_SCRIPT = `
local action, role, token, detail, witness_ms, database, qualified_server = unpack(ARGV)
local standard, dedicated, witness, retired = unpack(KEYS)
local holders = role == 'dedicated' and dedicated or standard
local function has_aof()
  return string.find(redis.call('INFO', 'persistence'), 'aof_enabled:1', 1, true)
end
if action == 'release' then
  local aof = has_aof()
  if role == 'dedicated' and not aof then error('VMAF_QUEUE_DURABLE_REDIS_REQUIRED') end
  -- A new write provides an AOF offset even if a previous HDEL reply was
  -- lost. The marker also rejects delayed startup requests for this token.
  redis.call('SET', retired, '1', 'PX', 60000)
  return redis.call('HDEL', holders, token) + (aof and 2 or 0)
end
if action == 'confirm_release' then
  return redis.call('EXISTS', retired) == 1 and redis.call('HEXISTS', holders, token) == 0 and 1 or 0
end
if action == 'abandon' then
  return redis.call('HDEL', holders, token)
end
if action == 'withdraw' then
  return redis.call('ZREM', witness, token)
end
if action == 'publish' or role == 'dedicated' then
  local server = redis.call('INFO', 'server')
  if role == 'dedicated' and string.match(server, 'run_id:([0-9a-f]+)') ~= qualified_server then
    error('VMAF_QUEUE_REDIS_SERVER_CHANGED')
  end
  local replication = redis.call('INFO', 'replication')
  if not string.find(server, 'redis_mode:standalone', 1, true)
      or not string.find(replication, 'role:master', 1, true)
      or string.match(replication, 'connected_slaves:(%d+)') ~= '0'
      or string.match(replication, 'master_replid2:([0-9a-f]+)') ~= string.rep('0', 40) then
    error('VMAF_QUEUE_STANDALONE_REDIS_REQUIRED')
  end
  local clock = redis.call('TIME')
  local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
  redis.call('ZREMRANGEBYSCORE', witness, '-inf', now)
  if action == 'publish' then
    redis.call('ZADD', witness, now + tonumber(witness_ms), token)
    redis.call('PEXPIRE', witness, witness_ms)
    return 1
  end
  if redis.call('ZCARD', witness) == 0 or redis.call('HLEN', standard) > 0 then
    return 0
  end
  if redis.call('HLEN', dedicated) > 0 then
    local owner = redis.call('HGET', dedicated, token)
    if not owner or cjson.decode(owner).database ~= database then return 0 end
  end
elseif redis.call('HLEN', dedicated) > 0 then
  return 0
end
if action == 'claim' then
  if redis.call('EXISTS', retired) == 1 then return 0 end
  local aof = has_aof()
  if role == 'dedicated' and (not aof or not string.find(redis.call('INFO', 'memory'), 'maxmemory_policy:noeviction', 1, true)) then
    error('VMAF_QUEUE_DURABLE_REDIS_REQUIRED')
  end
  redis.call('HSET', holders, token, detail)
  return aof and 2 or 1
end
if action == 'owns' then
  return redis.call('HEXISTS', holders, token)
end
error('Unknown VMAF queue ownership action')
`;

/** Keep registration commands bounded and avoid deferred writes while offline. */
export function createVmafOwnershipConnection(redisUrl: string) {
	const redis = new Redis(redisUrl, {
		lazyConnect: true,
		enableOfflineQueue: false,
		autoResendUnfulfilledCommands: false,
		connectTimeout: 3_000,
		commandTimeout: 3_000,
		maxRetriesPerRequest: 1,
	});
	redis.on("error", () => {});
	return redis;
}

/** Compare the PostgreSQL writer, database and schema used by each worker.
 * This read requires no application mutation or monitoring-role privileges. */
export async function readVmafQueueDatabase(
	prisma: Pick<AppPrismaClient, "$queryRaw">,
) {
	const rows = await prisma.$queryRaw<
		{
			name: string;
			oid: string;
			schema: string;
			schemaOid: string;
			epoch: string;
		}[]
	>`SELECT current_database() AS name, db.oid::text AS oid,
		  ns.nspname AS schema, ns.oid::text AS "schemaOid",
		EXTRACT(EPOCH FROM pg_postmaster_start_time())::text AS epoch
		FROM pg_catalog.pg_database db
		JOIN pg_catalog.pg_namespace ns ON ns.nspname = current_schema()
		WHERE db.datname = current_database() AND NOT pg_is_in_recovery()
		  AND current_setting('transaction_read_only') = 'off'
		  AND current_setting('default_transaction_read_only') = 'off'
		  AND EXISTS (
			SELECT 1 FROM pg_catalog.pg_class report
			WHERE report.relnamespace = ns.oid AND report.relname = 'VmafJob'
			  AND report.relkind IN ('r', 'p')
			  AND pg_catalog.has_table_privilege(report.oid, 'SELECT')
			  AND pg_catalog.has_table_privilege(report.oid, 'UPDATE')
		  )`;
	const database = rows[0];
	if (
		rows.length !== 1 ||
		!database?.name ||
		!database.schema ||
		!/^\d+$/.test(database.oid) ||
		!/^\d+$/.test(database.schemaOid) ||
		!/^\d+(\.\d+)?$/.test(database.epoch)
	)
		throw new Error("VMAF_QUEUE_DATABASE_IDENTITY_UNAVAILABLE");
	return createHash("sha256")
		.update(
			JSON.stringify([
				database.name,
				database.oid,
				database.schema,
				database.schemaOid,
				database.epoch,
			]),
		)
		.digest("hex");
}

type RegistryAction =
	| "claim"
	| "owns"
	| "release"
	| "confirm_release"
	| "abandon"
	| "publish"
	| "withdraw";

export function createVmafQueueRegistry(
	redis: ResourceLeaseRedis & Pick<Redis, "call" | "pipeline">,
) {
	const token = randomUUID();
	const detail = {
		host: hostname(),
		pid: process.pid,
		registeredAt: new Date().toISOString(),
	};
	async function qualifiedRedisServer() {
		// CONFIG GET is unavailable from Lua. Read policy and instance identity
		// in one pipeline, then make the ownership script verify that instance.
		const [server, config] =
			(await redis
				.pipeline()
				.info("server")
				.call("CONFIG", "GET", "appendfsync", "no-appendfsync-on-rewrite")
				.exec()) ?? [];
		const info: unknown = server?.[1];
		const settings: unknown = config?.[1];
		const id =
			typeof info === "string"
				? /^run_id:([a-f0-9]{40})\r?$/m.exec(info)?.[1]
				: undefined;
		const values = new Map<unknown, unknown>();
		if (Array.isArray(settings)) {
			for (let i = 0; i < settings.length; i += 2)
				values.set(settings[i], settings[i + 1]);
		}
		if (
			!id ||
			server?.[0] ||
			config?.[0] ||
			values.get("appendfsync") !== "always" ||
			values.get("no-appendfsync-on-rewrite") !== "no"
		)
			throw new Error("VMAF_QUEUE_SYNCHRONOUS_AOF_REQUIRED");
		return id;
	}
	async function run(action: RegistryAction, role: Role, database?: string) {
		if (
			(action === "publish" ||
				action === "withdraw" ||
				(role === "dedicated" && (action === "claim" || action === "owns"))) &&
			(!database || !/^[a-f0-9]{64}$/.test(database))
		)
			throw new Error("VMAF_QUEUE_DATABASE_IDENTITY_UNAVAILABLE");
		const qualifiedServer =
			role === "dedicated" && (action === "claim" || action === "owns")
				? await qualifiedRedisServer()
				: "-";
		const result = await redis.eval(
			OWNER_SCRIPT,
			4,
			`${ROOT}:standard`,
			`${ROOT}:dedicated`,
			`${ROOT}:primary:${database ?? "-"}`,
			`${ROOT}:retired:${token}`,
			action,
			role,
			token,
			JSON.stringify({ ...detail, database }),
			String(PRIMARY_WITNESS_MS),
			database ?? "-",
			qualifiedServer,
		);
		if (
			result !== 0 &&
			result !== 1 &&
			!(action === "claim" && result === 2) &&
			!(action === "release" && (result === 2 || result === 3))
		)
			throw new Error("VMAF_QUEUE_OWNERSHIP_RESPONSE_INVALID");
		return result;
	}
	async function persist(role: Role, errorCode: string) {
		let synced: unknown;
		try {
			synced = await redis.call("WAITAOF", 1, 0, PERSIST_TIMEOUT_MS);
		} catch (error) {
			// The existing standard role can operate with an older server or ACL.
			if (
				role === "worker" &&
				error instanceof Error &&
				/^(?:ERR unknown command 'WAITAOF'(?:,|$)|NOPERM(?: |$))/i.test(
					error.message,
				)
			)
				return;
			throw error;
		}
		if (!Array.isArray(synced) || synced[0] !== 1) throw new Error(errorCode);
	}
	async function claim(role: Role, database?: string) {
		const result = await run("claim", role, database);
		if (result !== 2) return result === 1;
		try {
			// Confirm the register write reached disk before any jobs can start.
			await persist(role, "VMAF_QUEUE_DURABLE_REGISTRATION_UNAVAILABLE");
			if ((await run("owns", role, database)) !== 1)
				throw new Error("VMAF_QUEUE_DURABLE_REGISTRATION_UNAVAILABLE");
			return true;
		} catch (error) {
			// This consumer has never taken a job. A failed cleanup leaves its
			// registration reserved for inspection instead of allowing takeover.
			await run("abandon", role).catch(() => {});
			throw error;
		}
	}
	return {
		claim,
		owns: async (role: Role, database?: string) =>
			(await run("owns", role, database)) === 1,
		async release(role: Role) {
			const result = await run("release", role);
			if (result >= 2) {
				await persist(role, "VMAF_QUEUE_DURABLE_RELEASE_UNAVAILABLE");
				// A new connection could acknowledge a different AOF offset. The
				// actual retirement marker must still be present after waiting.
				if ((await run("confirm_release", role)) !== 1)
					throw new Error("VMAF_QUEUE_DURABLE_RELEASE_UNAVAILABLE");
			}
			return result === 1 || result === 3;
		},
		publish: (database: string) => run("publish", "worker", database),
		withdraw: (database: string) => run("withdraw", "worker", database),
	};
}

/** Start ordinary QC independently of the other queues, and recover its
 * registration after a Redis restart before allowing more work. */
export function startStandardVmafConsumer(
	registry: Pick<
		ReturnType<typeof createVmafQueueRegistry>,
		"claim" | "owns" | "release"
	>,
	start: (owns: () => Promise<boolean>) => { close(): Promise<unknown> },
) {
	let stopping = false;
	let confirmed = false;
	let reservationMayExist = false;
	let reported = false;
	let claim: Promise<boolean> | undefined;
	let activation: Promise<void> | undefined;
	let worker: ReturnType<typeof start> | undefined;
	let closing: Promise<void> | undefined;

	function register() {
		if (stopping) return Promise.resolve(false);
		if (!claim) {
			// A reply can be lost after Redis records this request.
			reservationMayExist = true;
			claim = registry
				.claim("worker")
				.then((owned) => {
					confirmed = owned;
					reservationMayExist = owned;
					return owned;
				})
				.finally(() => {
					claim = undefined;
				});
		}
		return claim;
	}

	async function owns() {
		if (stopping) return false;
		if (confirmed && !(await registry.owns("worker"))) confirmed = false;
		if (!confirmed) await register();
		return !stopping && confirmed;
	}

	function report(message: string) {
		if (stopping || reported) return;
		reported = true;
		console.warn(
			`[worker:vmafRunner] ${message}; retrying standard QC startup`,
		);
	}

	function activate() {
		if (stopping || activation) return;
		activation = register()
			.then((owned) => {
				if (stopping) return;
				if (!owned) {
					report("dedicated QC owner is registered");
					return;
				}
				worker = start(owns);
				clearInterval(timer);
			})
			.catch(() => report("standard QC ownership unavailable"))
			.finally(() => {
				activation = undefined;
			});
	}

	const timer = setInterval(activate, PRIMARY_REFRESH_MS).unref();
	activate();
	function stop() {
		stopping = true;
		clearInterval(timer);
	}
	return {
		stop,
		close() {
			stop();
			closing ??= (async () => {
				await activation;
				await closeVmafQueueConsumer(
					async () => worker?.close(),
					async () => {
						await claim?.catch(() => {});
						if (reservationMayExist) await registry.release("worker");
					},
				);
			})();
			return closing;
		},
	};
}

export function createDedicatedVmafRegistration(
	registry: Pick<
		ReturnType<typeof createVmafQueueRegistry>,
		"claim" | "release"
	>,
	drain: () => Promise<unknown>,
) {
	const shutdown = new AbortController();
	let pending: Promise<boolean> | undefined;
	let reservationMayExist = false;
	let closing: Promise<void> | undefined;
	return {
		signal: shutdown.signal,
		async claim(database: string) {
			shutdown.signal.throwIfAborted();
			// The script can create the reservation without a reply reaching us.
			reservationMayExist = true;
			pending = registry.claim("dedicated", database);
			reservationMayExist = await pending;
			shutdown.signal.throwIfAborted();
			return reservationMayExist;
		},
		close() {
			shutdown.abort();
			closing ??= (async () => {
				await pending?.catch(() => {});
				await closeVmafQueueConsumer(drain, async () => {
					if (reservationMayExist) await registry.release("dedicated");
				});
			})();
			return closing;
		},
	};
}

/** One pulse at a time, and no write can follow a successful withdrawal. */
export function startSplitVmafPrimaryWitness(
	registry: Pick<
		ReturnType<typeof createVmafQueueRegistry>,
		"publish" | "withdraw"
	>,
	readDatabase: () => Promise<string>,
) {
	let stopped = false;
	let pending: Promise<void> | undefined;
	let announced: string | undefined;
	const publish = () => {
		if (stopped || pending) return;
		pending = (async () => {
			const database = await readDatabase();
			if (stopped) return;
			if (announced && database !== announced)
				await registry.withdraw(announced);
			announced = database;
			await registry.publish(database);
		})()
			.catch(() => {
				console.warn("[worker:vmafRunner] split primary witness unavailable");
			})
			.finally(() => {
				pending = undefined;
			});
	};
	const timer = setInterval(publish, PRIMARY_REFRESH_MS).unref();
	publish();
	return async () => {
		stopped = true;
		clearInterval(timer);
		await pending;
		if (announced) await registry.withdraw(announced);
	};
}

/** BullMQ has claimed the delivery. Defer it without entering tenant state
 * if the worker lost its registration or the topology cannot be verified. */
export function guardVmafQueueOwnership<T>(
	owns: () => Promise<boolean>,
	consume: (job: Job) => Promise<T>,
) {
	let stopping = false;
	const active = new Set<Promise<T>>();
	const handle = async (job: Job) => {
		const allowed = !stopping && (await owns().catch(() => false));
		if (!allowed || stopping) {
			await job.moveToDelayed(Date.now() + PRIMARY_REFRESH_MS, job.token);
			throw new DelayedError();
		}
		const pending = Promise.resolve().then(() => consume(job));
		active.add(pending);
		try {
			return await pending;
		} finally {
			active.delete(pending);
		}
	};
	return Object.assign(handle, {
		async drain() {
			stopping = true;
			await Promise.allSettled(active);
		},
	});
}

export async function waitForVmafBrokerClose(
	operation: Promise<unknown>,
	unconfirmed = "VMAF_QUEUE_BROKER_CLOSE_UNCONFIRMED",
) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			operation,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(
					() => reject(new Error(unconfirmed)),
					WORKER_CLOSE_MS,
				);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

/** A Redis reconnect can hang BullMQ's close. Quiesce and prove application
 * work has done draining before closing transport or retaining the token. */
export async function closeVmafBullWorker(
	worker: Pick<Worker, "pause" | "close">,
	drainHandlers: () => Promise<unknown>,
	{
		neverStarted = false,
		stopSweep,
	}: {
		neverStarted?: boolean;
		stopSweep?: () => Promise<unknown>;
	} = {},
) {
	// Bound broker bookkeeping and sweeps separately. Active scoring can
	// finish normally and must drain even if either of the other steps fails.
	const results = await Promise.allSettled([
		drainHandlers(),
		neverStarted ? undefined : waitForVmafBrokerClose(worker.pause(true)),
		stopSweep &&
			waitForVmafBrokerClose(stopSweep(), "VMAF_QUEUE_SWEEP_DRAIN_UNCONFIRMED"),
	]);
	const failure = results.find((result) => result.status === "rejected");
	if (failure) throw failure.reason;
	await waitForVmafBrokerClose(worker.close(neverStarted));
}

export async function closeVmafQueueConsumer(
	drain: () => Promise<unknown>,
	release: () => Promise<unknown>,
) {
	await drain();
	const deadline = performance.now() + RELEASE_RETRY_MS;
	for (;;) {
		try {
			await release();
			return;
		} catch (cause) {
			const remaining = deadline - performance.now();
			if (remaining <= 0)
				throw new Error("VMAF_QUEUE_OWNERSHIP_RELEASE_UNCONFIRMED", { cause });
			await new Promise<void>((resolve) =>
				setTimeout(resolve, Math.min(250, remaining)),
			);
		}
	}
}
