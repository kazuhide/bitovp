import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { AppPrismaClient } from "@bitovp/db";
import { DelayedError, type Job } from "bullmq";
import { Redis } from "ioredis";
import type { ResourceLeaseRedis } from "./resource-leases";

type Role = "worker" | "dedicated";
const ROOT = "bitovp:vmaf-queue:{owner-v1}";
const PRIMARY_REFRESH_MS = 5_000;
const PRIMARY_WITNESS_MS = 15_000;
const PERSIST_TIMEOUT_MS = 2_000;

// Role records are not leases. A disconnected Worker can still have active
// FFmpeg or cloud work, so only a gracefully drained holder releases its token.
// The producer witness attests a matching control plane and may expire safely.
const OWNER_SCRIPT = `
local action, role, token, detail, witness_ms, database = unpack(ARGV)
local standard, dedicated, witness = unpack(KEYS)
local holders = role == 'dedicated' and dedicated or standard
if action == 'release' then
  return redis.call('HDEL', holders, token)
end
if action == 'withdraw' then
  return redis.call('ZREM', witness, token)
end
if action == 'publish' or role == 'dedicated' then
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
  local aof = string.find(redis.call('INFO', 'persistence'), 'aof_enabled:1', 1, true)
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
		FROM pg_database db JOIN pg_namespace ns ON ns.nspname = current_schema()
		WHERE db.datname = current_database() AND NOT pg_is_in_recovery()`;
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

type RegistryAction = "claim" | "owns" | "release" | "publish" | "withdraw";

export function createVmafQueueRegistry(
	redis: ResourceLeaseRedis & Pick<Redis, "call">,
) {
	const token = randomUUID();
	const detail = {
		host: hostname(),
		pid: process.pid,
		registeredAt: new Date().toISOString(),
	};
	async function run(action: RegistryAction, role: Role, database?: string) {
		if (
			(action === "publish" ||
				action === "withdraw" ||
				(role === "dedicated" && action !== "release")) &&
			(!database || !/^[a-f0-9]{64}$/.test(database))
		)
			throw new Error("VMAF_QUEUE_DATABASE_IDENTITY_UNAVAILABLE");
		const result = await redis.eval(
			OWNER_SCRIPT,
			3,
			`${ROOT}:standard`,
			`${ROOT}:dedicated`,
			`${ROOT}:primary:${database ?? "-"}`,
			action,
			role,
			token,
			JSON.stringify({ ...detail, database }),
			String(PRIMARY_WITNESS_MS),
			database ?? "-",
		);
		if (result !== 0 && result !== 1 && !(action === "claim" && result === 2))
			throw new Error("VMAF_QUEUE_OWNERSHIP_RESPONSE_INVALID");
		return result;
	}
	async function claim(role: Role, database?: string) {
		const result = await run("claim", role, database);
		if (result !== 2) return result === 1;
		try {
			// Confirm the register write reached disk before any jobs can start.
			const synced = await redis.call("WAITAOF", 1, 0, PERSIST_TIMEOUT_MS);
			if (
				!Array.isArray(synced) ||
				synced[0] !== 1 ||
				(await run("owns", role, database)) !== 1
			)
				throw new Error("VMAF_QUEUE_DURABLE_REGISTRATION_UNAVAILABLE");
			return true;
		} catch (error) {
			// Redis versions without WAITAOF can still run the existing worker
			// role. Those servers cannot start a dedicated consumer.
			if (
				role === "worker" &&
				error instanceof Error &&
				/^ERR unknown command 'WAITAOF'(?:,|$)/i.test(error.message) &&
				(await run("owns", role, database).catch(() => 0)) === 1
			) {
				return true;
			}
			// This consumer has never taken a job. A failed cleanup leaves its
			// registration reserved for inspection instead of allowing takeover.
			await run("release", role).catch(() => {});
			throw error;
		}
	}
	return {
		claim,
		owns: async (role: Role, database?: string) =>
			(await run("owns", role, database)) === 1,
		release: async (role: Role) => (await run("release", role)) === 1,
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
	return async (job: Job) => {
		const allowed = await owns().catch(() => false);
		if (!allowed) {
			await job.moveToDelayed(Date.now() + PRIMARY_REFRESH_MS, job.token);
			throw new DelayedError();
		}
		return consume(job);
	};
}

export async function closeVmafQueueConsumer(
	drain: () => Promise<unknown>,
	release: () => Promise<unknown>,
) {
	await drain();
	await release();
}
