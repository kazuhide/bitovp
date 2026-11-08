import { randomUUID } from "node:crypto";
import {
	LOCAL_SEMANTIC_HEARTBEAT_TTL_MS,
	LOCAL_STORY_FLOW_READINESS_POLICY,
	type LocalSemanticWorkerHeartbeat,
	type LocalStoryFlowWorkerHeartbeat,
	localSemanticConnectionHash,
	localSemanticWorkerHeartbeatSchema,
	localSemanticWorkerRegistryKeys,
	localStoryFlowOperatorGate,
	localStoryFlowWorkerHeartbeatSchema,
	localStoryFlowWorkerRegistryKeys,
	readLocalSemanticConfiguration,
} from "@bitovp/core";

/** Atomic per-instance renewal with bounded stale cleanup. Never replaces another worker's status. */
export const PUBLISH_LOCAL_SEMANTIC_HEARTBEAT = `
local old=redis.call('ZRANGEBYSCORE',KEYS[1],'-inf',ARGV[3]-ARGV[4],'LIMIT',0,100)
if #old>0 then redis.call('ZREM',KEYS[1],unpack(old)); redis.call('HDEL',KEYS[2],unpack(old)) end
redis.call('ZADD',KEYS[1],ARGV[3],ARGV[1])
redis.call('HSET',KEYS[2],ARGV[1],ARGV[2])
redis.call('PEXPIRE',KEYS[1],ARGV[4]*2)
redis.call('PEXPIRE',KEYS[2],ARGV[4]*2)
return 1`;
export const REMOVE_LOCAL_SEMANTIC_HEARTBEAT = `redis.call('ZREM',KEYS[1],ARGV[1]); return redis.call('HDEL',KEYS[2],ARGV[1])`;

type RegistryKeys = ReturnType<typeof localSemanticWorkerRegistryKeys>;
export async function startLocalSemanticHeartbeat(input: {
	env: Record<string, string | undefined>;
	initialized: boolean;
	captionModelHash?: string;
	instanceId?: string;
	publish(
		keys: RegistryKeys,
		row: LocalSemanticWorkerHeartbeat,
		ttlMs: number,
	): Promise<unknown>;
	remove(keys: RegistryKeys, instanceId: string): Promise<unknown>;
}) {
	let config: ReturnType<typeof readLocalSemanticConfiguration>;
	try {
		config = readLocalSemanticConfiguration(input.env);
	} catch {
		/* Fixed config diagnostic is served by web. */
	}
	if (!config) return { stop: async () => {} };
	const connectionHash = await localSemanticConnectionHash(
		config,
		input.captionModelHash,
	);
	const keys = localSemanticWorkerRegistryKeys(connectionHash);
	const instanceId =
		input.instanceId === undefined ? randomUUID() : input.instanceId;
	if (
		!localSemanticWorkerHeartbeatSchema.shape.instanceId.safeParse(instanceId)
			.success
	)
		return { stop: async () => {} };
	const profile = config.profile;
	return runHeartbeat({
		...input,
		keys,
		instanceId,
		makeRow: (): LocalSemanticWorkerHeartbeat => ({
			version: "local-semantic-worker-v1",
			connectionHash,
			instanceId,
			profile,
			state: input.initialized ? "READY" : "INITIALIZATION_FAILED",
			observedAt: Date.now(),
		}),
	});
}

/** Called only by a bootstrap owning the compiled capability and process ID; not wired by this slice. */
export async function startLocalStoryFlowHeartbeat(input: {
	env: Record<string, string | undefined>;
	initialized: boolean;
	instanceId: string;
	capabilityHash: string;
	captionModelHash?: string;
	publish(
		keys: RegistryKeys,
		row: LocalStoryFlowWorkerHeartbeat,
		ttlMs: number,
	): Promise<unknown>;
	remove(keys: RegistryKeys, instanceId: string): Promise<unknown>;
}) {
	if (
		localStoryFlowOperatorGate(input.env.BITOVP_LOCAL_STORY_FLOW_ENABLED) !==
		"ENABLED"
	)
		return { stop: async () => {} };
	try {
		const config = readLocalSemanticConfiguration(input.env);
		if (!config) return { stop: async () => {} };
		const connectionHash = await localSemanticConnectionHash(
			config,
			input.captionModelHash,
		);
		const keys = localStoryFlowWorkerRegistryKeys(
			connectionHash,
			input.capabilityHash,
		);
		const row = localStoryFlowWorkerHeartbeatSchema.parse({
			version: "local-story-flow-worker-v1",
			connectionHash,
			capabilityHash: input.capabilityHash,
			instanceId: input.instanceId,
			profile: config.profile,
			state: input.initialized ? "READY" : "INITIALIZATION_FAILED",
			observedAt: Date.now(),
		});
		return runHeartbeat({
			...input,
			keys,
			instanceId: row.instanceId,
			makeRow: () => ({ ...row, observedAt: Date.now() }),
		});
	} catch {
		return { stop: async () => {} };
	}
}

/** publish/remove must enqueue in invocation order on the SAME Redis connection. */
async function runHeartbeat<Row>(input: {
	keys: RegistryKeys;
	instanceId: string;
	makeRow(): Row;
	publish(keys: RegistryKeys, row: Row, ttlMs: number): Promise<unknown>;
	remove(keys: RegistryKeys, instanceId: string): Promise<unknown>;
}) {
	const { keys, instanceId } = input;
	let stopped = false;
	let pending: Promise<unknown> | undefined;
	const publish = () => {
		if (stopped || pending) return;
		const row = input.makeRow();
		pending = Promise.resolve()
			.then(() => {
				// A scheduled renewal is not yet an enqueued Redis command.
				if (!stopped)
					return input.publish(keys, row, LOCAL_SEMANTIC_HEARTBEAT_TTL_MS);
			})
			.catch(() => undefined)
			.finally(() => {
				pending = undefined;
			});
	};
	publish();
	// Let the first call be scheduled, without making startup depend on Redis availability.
	await Promise.resolve();
	const interval = setInterval(
		publish,
		LOCAL_STORY_FLOW_READINESS_POLICY.heartbeatRenewMs,
	);
	interval.unref();
	return {
		stop: async () => {
			if (stopped) return;
			stopped = true;
			clearInterval(interval);
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				// Same connection preserves command order: remove follows any pending renewal.
				await Promise.race([
					Promise.resolve()
						.then(() => input.remove(keys, instanceId))
						.catch(() => undefined),
					new Promise<void>((resolve) => {
						timer = setTimeout(resolve, 1_000);
						timer.unref();
					}),
				]);
			} finally {
				if (timer) clearTimeout(timer);
			}
		},
	};
}
