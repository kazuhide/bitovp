import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

/** Exact common denominator for concurrency values from 1 through 32. */
export const VMAF_GPU_COMPUTE_CREDITS = 144403552893600;

export type VmafResourceVector = {
	cpuMilliCores: number;
	hostBytes: number;
	gpuBytes?: number;
	gpuComputeCredits?: number;
};
export type VmafResourceLeaseRequest = {
	hostKey: string;
	deviceKey?: string;
	capacity: VmafResourceVector;
	requested: VmafResourceVector;
};
export type VmafResourceHeadroom = { hostBytes: number; gpuBytes?: number };
export type VmafResourceLeaseContext = {
	signal: AbortSignal;
	assertOwned(): Promise<void>;
	/** Compare all retained reservations with one fresh sample, without renewing.
	 * External allocations after that sample remain outside this check. */
	fitsHeadroom(headroom: VmafResourceHeadroom): Promise<boolean>;
};
export type ResourceLeaseRedis = {
	eval(
		script: string,
		numberOfKeys: number,
		...args: string[]
	): Promise<unknown>;
};
export class VmafResourceLeaseError extends Error {
	constructor(
		readonly code: "UNAVAILABLE" | "LOST",
		options?: ErrorOptions,
	) {
		super(
			code === "LOST"
				? "Quality measurement lost its shared resource reservation."
				: "Quality measurement could not contact its shared resource coordinator.",
			options,
		);
		this.name = "VmafResourceLeaseError";
	}
}

// All keys have the same Redis Cluster hash tag. Original decimal strings
// retain integer precision; Lua/cjson number serialization is not used.
const resourceScript = `
local action, token = ARGV[1], ARGV[2]
local lease, margin = tonumber(ARGV[3]), tonumber(ARGV[4])
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local function decimal(value) return string.format('%.0f', value) end
local function reply(status, expiry) return {status, decimal(expiry), decimal(now)} end
local function split(value)
  local fields = {}
  for field in string.gmatch(value, '[^|]+') do fields[#fields+1] = field end
  if #fields ~= 12 then error('Malformed quality resource reservation') end
  return fields
end
local base = table.concat(ARGV, '|', 5, 14)
local function matches(value)
  return string.sub(value, 1, #base + 1) == base .. '|'
end
if action ~= 'headroom' then
  local expired = redis.call('ZRANGEBYSCORE', KEYS[4], '-inf', now)
  for _, id in ipairs(expired) do
    redis.call('HDEL', KEYS[3], id)
    redis.call('ZREM', KEYS[4], id)
  end
end
local function retain_active()
  local latest = redis.call('ZREVRANGE', KEYS[4], 0, 0, 'WITHSCORES')[2]
  if latest then
    local retention = tonumber(latest) - now + 60000
    redis.call('PEXPIRE', KEYS[3], retention)
    redis.call('PEXPIRE', KEYS[4], retention)
  end
end
local active = redis.call('HGET', KEYS[3], token)
if active and not matches(active) then error('Quality resource owner mismatch') end
if action == 'release' then
  redis.call('ZREM', KEYS[1], token)
  redis.call('HDEL', KEYS[2], token)
  if active then redis.call('HDEL', KEYS[3], token) end
  redis.call('ZREM', KEYS[4], token)
  return reply(active and 1 or 0, 0)
end
-- Inspect the server atomically with the grant. ACL denial is an error,
-- never permission to proceed without a shared coordinator.
local info = redis.call('INFO', 'server')
local run_id = string.match(info, 'run_id:([0-9a-f]+)')
local uptime = tonumber(string.match(info, 'uptime_in_seconds:(%d+)'))
if not run_id or #run_id ~= 40 or not uptime then
  error('Quality resource server identity unavailable')
end
-- Uptime has whole-second granularity; add one full second so rounding
-- cannot open the restart fence before the lease and drain window elapsed.
local ready = uptime > math.ceil((lease + margin) / 1000)
if active then
  local values = split(active)
  local until_at = tonumber(values[11])
  if until_at <= now or values[12] ~= run_id then return reply(0, until_at) end
  if action == 'headroom' then
    local host_used, gpu_used = 0, 0
    local entries = redis.call('HGETALL', KEYS[3])
    for i=1,#entries,2 do
      local retention = redis.call('ZSCORE', KEYS[4], entries[i])
      -- Read only: do not remove fully drained records or extend any TTL.
      -- A missing retention bound remains conservatively reserved.
      if entries[i] == token or not retention or tonumber(retention) > now then
        local other = split(entries[i+1])
        if other[1] == ARGV[5] then host_used = host_used + tonumber(other[8]) end
        if ARGV[6] ~= '-' and other[2] == ARGV[6] then
          gpu_used = gpu_used + tonumber(other[9])
        end
      end
    end
    local fits = host_used <= tonumber(ARGV[15]) and
      (ARGV[6] == '-' or (ARGV[16] ~= '-' and gpu_used <= tonumber(ARGV[16])))
    return reply(fits and 1 or 2, until_at)
  end
  if action ~= 'acquire' or ready then
    if action == 'renew' then
      until_at = now + lease
      redis.call('HSET', KEYS[3], token, base .. '|' .. decimal(until_at) .. '|' .. run_id)
      redis.call('ZADD', KEYS[4], until_at + margin, token)
      retain_active()
    end
    if action == 'acquire' then
      redis.call('ZREM', KEYS[1], token)
      redis.call('HDEL', KEYS[2], token)
    end
    return reply(1, until_at)
  end
end
if action ~= 'acquire' then return reply(0, 0) end

-- A host's FIFO does not hold up an unrelated host. Expired waiting owners
-- are removed before checking the head, including owners that crashed.
while true do
  local head = redis.call('ZRANGE', KEYS[1], 0, 0)[1]
  if not head then break end
  local expiry = redis.call('HGET', KEYS[2], head)
  if expiry and tonumber(expiry) > now then break end
  redis.call('ZREM', KEYS[1], head)
  redis.call('HDEL', KEYS[2], head)
end
if not redis.call('ZSCORE', KEYS[1], token) then
  local sequence = redis.call('INCR', KEYS[5])
  if sequence > 9007199254740991 then error('Quality resource queue sequence exhausted') end
  redis.call('ZADD', KEYS[1], sequence, token)
end
redis.call('HSET', KEYS[2], token, decimal(now + lease))
local latest_wait = now
for _, value in ipairs(redis.call('HVALS', KEYS[2])) do
  latest_wait = math.max(latest_wait, tonumber(value))
end
redis.call('PEXPIRE', KEYS[1], latest_wait - now + 60000)
redis.call('PEXPIRE', KEYS[2], latest_wait - now + 60000)
redis.call('PEXPIRE', KEYS[5], 86400000)
if not ready or redis.call('ZRANGE', KEYS[1], 0, 0)[1] ~= token then return reply(0, now + lease) end

local cap, need, used = {}, {}, {0,0,0,0}
for i=1,4 do cap[i] = tonumber(ARGV[6+i]); need[i] = tonumber(ARGV[10+i]) end
local entries = redis.call('HVALS', KEYS[3])
for _, entry in ipairs(entries) do
  local values = split(entry)
  if values[1] == ARGV[5] then
    for i=1,2 do
      cap[i] = math.min(cap[i], tonumber(values[2+i]))
      used[i] = used[i] + tonumber(values[6+i])
    end
  end
  if ARGV[6] ~= '-' and values[2] == ARGV[6] then
    for i=3,4 do
      cap[i] = math.min(cap[i], tonumber(values[2+i]))
      used[i] = used[i] + tonumber(values[6+i])
    end
  end
end
for i=1,4 do
  if need[i] > cap[i] - used[i] then return reply(0, now + lease) end
end
local until_at = now + lease
redis.call('HSET', KEYS[3], token, base .. '|' .. decimal(until_at) .. '|' .. run_id)
redis.call('ZADD', KEYS[4], until_at + margin, token)
redis.call('ZREM', KEYS[1], token)
redis.call('HDEL', KEYS[2], token)
retain_active()
return reply(1, until_at)
`;

function positiveInteger(value: number, label: string) {
	if (!Number.isSafeInteger(value) || value <= 0)
		throw new Error(`Invalid quality resource ${label}`);
	return value;
}
function reservation(request: VmafResourceLeaseRequest) {
	const key = /^[A-Za-z0-9_-]{1,128}$/;
	if (
		!key.test(request.hostKey) ||
		(request.deviceKey !== undefined &&
			(request.deviceKey === "-" || !key.test(request.deviceKey)))
	)
		throw new Error("Invalid quality resource identity");
	const values = (vector: VmafResourceVector) => [
		positiveInteger(vector.cpuMilliCores, "CPU"),
		positiveInteger(vector.hostBytes, "memory"),
		...(request.deviceKey !== undefined
			? [
					positiveInteger(vector.gpuBytes as number, "GPU memory"),
					positiveInteger(vector.gpuComputeCredits as number, "GPU compute"),
				]
			: [0, 0]),
	];
	if (
		request.deviceKey === undefined &&
		[request.capacity, request.requested].some(
			(v) => v.gpuBytes !== undefined || v.gpuComputeCredits !== undefined,
		)
	)
		throw new Error("GPU resources require a device identity");
	const capacity = values(request.capacity),
		requested = values(request.requested);
	if (requested.some((amount, index) => amount > (capacity[index] as number)))
		throw new Error("Quality resource reservation exceeds its capacity");
	return [
		request.hostKey,
		request.deviceKey ?? "-",
		...capacity.map(String),
		...requested.map(String),
	];
}
function headroomPayload(headroom?: VmafResourceHeadroom) {
	if (
		!headroom ||
		![headroom.hostBytes, headroom.gpuBytes ?? 0].every(
			(amount) => Number.isSafeInteger(amount) && amount >= 0,
		)
	)
		throw new Error("Invalid quality resource headroom");
	return [
		String(headroom.hostBytes),
		headroom.gpuBytes === undefined ? "-" : String(headroom.gpuBytes),
	];
}

function pause(milliseconds: number, signal: AbortSignal) {
	return new Promise<void>((resolve, reject) => {
		signal.throwIfAborted();
		const finish = () => {
			signal.removeEventListener("abort", abort);
			resolve();
		};
		const timer = setTimeout(finish, milliseconds);
		const abort = () => {
			clearTimeout(timer);
			reject(signal.reason);
		};
		signal.addEventListener("abort", abort, { once: true });
	});
}

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };
async function settle<T>(work: () => Promise<T>): Promise<Settled<T>> {
	try {
		return { ok: true, value: await work() };
	} catch (error) {
		return { ok: false, error };
	}
}

/** A shared lease is a reservation, not proof that an orphan child has exited.
 * The caller must supervise child shutdown and use assertOwned before publication. */
export function createVmafResourceLeases(options: {
	redis: ResourceLeaseRedis;
	namespace?: string;
	leaseMs?: number;
	renewMs?: number;
	drainMarginMs?: number;
	pollMs?: number;
	operationTimeoutMs?: number;
}) {
	const namespace = options.namespace ?? "bitovp:vmaf-resources:v1";
	if (!/^[A-Za-z0-9:_-]{1,100}$/.test(namespace))
		throw new Error("Invalid quality resource namespace");
	const leaseMs = positiveInteger(options.leaseMs ?? 30000, "lease interval");
	const renewMs = positiveInteger(
		options.renewMs ?? Math.min(5000, Math.floor(leaseMs / 3)),
		"renewal interval",
	);
	const drainMs = positiveInteger(
		options.drainMarginMs ?? 1000,
		"drain interval",
	);
	const pollMs = positiveInteger(options.pollMs ?? 100, "poll interval");
	const timeoutMs = positiveInteger(
		options.operationTimeoutMs ?? Math.min(5000, Math.floor(leaseMs / 4)),
		"operation interval",
	);
	if (
		leaseMs < 100 ||
		leaseMs > 3600000 ||
		drainMs > 3600000 ||
		renewMs + timeoutMs >= leaseMs ||
		pollMs + timeoutMs >= leaseMs
	)
		throw new Error("Invalid quality resource renewal window");
	const prefix = `${namespace}:{vmaf-resources}`;
	return {
		async run<T>(
			request: VmafResourceLeaseRequest,
			callerSignal: AbortSignal,
			work: (lease: VmafResourceLeaseContext) => Promise<T>,
		): Promise<T> {
			const payload = reservation(request);
			callerSignal.throwIfAborted();
			const token = randomUUID(),
				controller = new AbortController();
			const keys = [
				`${prefix}:host:${request.hostKey}:queue`,
				`${prefix}:host:${request.hostKey}:waiting`,
				`${prefix}:active`,
				`${prefix}:expiry`,
				`${prefix}:sequence`,
			];
			const abort = () => controller.abort(callerSignal.reason);
			callerSignal.addEventListener("abort", abort, { once: true });
			let lost: VmafResourceLeaseError | undefined,
				stopped = false;
			let timer: ReturnType<typeof setTimeout> | undefined;
			let renewing: Promise<void> = Promise.resolve();
			const lose = (error: VmafResourceLeaseError) => {
				lost ??= error;
				if (!controller.signal.aborted) controller.abort(lost);
			};
			const operation = async (
				action: "acquire" | "check" | "renew" | "release" | "headroom",
				headroom?: VmafResourceHeadroom,
			) => {
				let deadline: ReturnType<typeof setTimeout> | undefined;
				const started = performance.now();
				try {
					const reply = await Promise.race([
						options.redis.eval(
							resourceScript,
							keys.length,
							...keys,
							action,
							token,
							String(leaseMs),
							String(drainMs),
							...payload,
							...(action === "headroom" ? headroomPayload(headroom) : []),
						),
						new Promise<never>((_, reject) => {
							deadline = setTimeout(
								() => reject(new VmafResourceLeaseError("UNAVAILABLE")),
								timeoutMs,
							);
						}),
					]);
					if (
						!Array.isArray(reply) ||
						reply.length !== 3 ||
						![0, 1, 2].includes(reply[0]) ||
						(reply[0] === 2 && action !== "headroom") ||
						!reply
							.slice(1)
							.every(
								(value) => typeof value === "string" && /^\d+$/.test(value),
							)
					)
						throw new Error("Invalid shared resource response");
					const until = Number(reply[1]),
						now = Number(reply[2]);
					if (![until, now].every(Number.isSafeInteger))
						throw new Error("Invalid lease time");
					if (
						reply[0] !== 0 &&
						action !== "release" &&
						performance.now() - started >= until - now
					)
						throw new VmafResourceLeaseError("LOST");
					return reply[0] as 0 | 1 | 2;
				} catch (error) {
					throw error instanceof VmafResourceLeaseError
						? error
						: new VmafResourceLeaseError("UNAVAILABLE", { cause: error });
				} finally {
					if (deadline) clearTimeout(deadline);
				}
			};
			const renew = () => {
				if (stopped || lost) return;
				timer = setTimeout(() => {
					renewing = operation("renew")
						.then((owned) => {
							if (!owned) lose(new VmafResourceLeaseError("LOST"));
						})
						.catch((error: VmafResourceLeaseError) => lose(error))
						.finally(renew);
				}, renewMs);
			};
			const authority = async (
				action: "check" | "headroom",
				headroom?: VmafResourceHeadroom,
			) => {
				if (lost) throw lost;
				controller.signal.throwIfAborted();
				let status: 0 | 1 | 2;
				try {
					status = await operation(action, headroom);
					if (status === 0) throw new VmafResourceLeaseError("LOST");
				} catch (error) {
					lose(error as VmafResourceLeaseError);
					throw error;
				}
				if (lost) throw lost;
				controller.signal.throwIfAborted();
				return status === 1;
			};
			const assertOwned = async () => {
				await authority("check");
			};
			const fitsHeadroom = (headroom: VmafResourceHeadroom) =>
				authority("headroom", headroom);
			const outcome = await settle(async () => {
				for (;;) {
					controller.signal.throwIfAborted();
					if (await operation("acquire")) break;
					await pause(pollMs, controller.signal);
				}
				controller.signal.throwIfAborted();
				renew();
				const result = await work({
					signal: controller.signal,
					assertOwned,
					fitsHeadroom,
				});
				await assertOwned();
				return result;
			});
			// Capture the outcome before cleanup so a failed callback cannot skip
			// release, and a delayed abort cannot release a still-running child.
			stopped = true;
			if (timer) clearTimeout(timer);
			const cleanup = await settle(async () => {
				try {
					await renewing;
				} finally {
					callerSignal.removeEventListener("abort", abort);
					await operation("release");
				}
			});
			if (!cleanup.ok)
				throw new VmafResourceLeaseError("UNAVAILABLE", {
					cause: outcome.ok
						? cleanup.error
						: new AggregateError(
								[outcome.error, cleanup.error],
								"Work and reservation release failed",
							),
				});
			if (!outcome.ok) throw outcome.error;
			return outcome.value;
		},
	};
}
