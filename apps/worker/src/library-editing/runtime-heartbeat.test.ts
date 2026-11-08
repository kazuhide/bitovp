import { afterEach, describe, expect, it, vi } from "vitest";
import {
	startLocalSemanticHeartbeat,
	startLocalStoryFlowHeartbeat,
} from "./runtime-heartbeat";

const env = {
	BITOVP_LOCAL_SEMANTIC_ENABLED: "1",
	BITOVP_LOCAL_SEMANTIC_GATEWAY_URL: "https://fixture.invalid:11437",
	BITOVP_LOCAL_SEMANTIC_GATEWAY_TOKEN: "a".repeat(48),
	BITOVP_LOCAL_SEMANTIC_CA_FILE: "/run/ca.pem",
	BITOVP_LOCAL_SEMANTIC_PROFILE: "nvidia",
	BITOVP_LOCAL_SEMANTIC_CONFIG_ID: "11111111-1111-4111-8111-111111111111",
};
afterEach(() => vi.useRealTimers());
describe("worker initialization heartbeat", () => {
	it("bounds cleanup when Redis never settles and leaves expiry as recovery", async () => {
		vi.useFakeTimers();
		const publish = vi.fn(() => new Promise<unknown>(() => {}));
		const remove = vi.fn(() => new Promise<unknown>(() => {}));
		const heartbeat = await startLocalSemanticHeartbeat({
			env,
			initialized: true,
			publish,
			remove,
		});
		const stopped = heartbeat.stop();
		await vi.advanceTimersByTimeAsync(1_000);
		await expect(stopped).resolves.toBeUndefined();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(publish).toHaveBeenCalledTimes(1);
		expect(remove).toHaveBeenCalledTimes(1);
	});
	it("does not touch registry for disabled or malformed local settings", async () => {
		for (const value of [{}, { BITOVP_LOCAL_SEMANTIC_ENABLED: "1" }]) {
			const publish = vi.fn();
			const remove = vi.fn();
			const heartbeat = await startLocalSemanticHeartbeat({
				env: value,
				initialized: false,
				publish,
				remove,
			});
			await heartbeat.stop();
			expect(publish).not.toHaveBeenCalled();
			expect(remove).not.toHaveBeenCalled();
		}
	});
	it.each([
		true,
		false,
	])("reports initialization, renews and removes only its own instance (%s)", async (initialized) => {
		vi.useFakeTimers();
		const publish = vi.fn().mockResolvedValue(undefined);
		const remove = vi.fn().mockResolvedValue(undefined);
		const heartbeat = await startLocalSemanticHeartbeat({
			env,
			initialized,
			publish,
			remove,
		});
		expect(publish).toHaveBeenCalledTimes(1);
		const first = publish.mock.calls[0];
		expect(first?.[1]).toMatchObject({
			state: initialized ? "READY" : "INITIALIZATION_FAILED",
			profile: "nvidia",
		});
		expect(JSON.stringify(first)).not.toContain(
			env.BITOVP_LOCAL_SEMANTIC_GATEWAY_TOKEN,
		);
		await vi.advanceTimersByTimeAsync(15_000);
		expect(publish).toHaveBeenCalledTimes(2);
		await heartbeat.stop();
		expect(remove).toHaveBeenCalledExactlyOnceWith(
			first?.[0],
			first?.[1].instanceId,
		);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(publish).toHaveBeenCalledTimes(2);
	});
	it("bounds overlapping writes and keeps Redis failures local to diagnostics", async () => {
		vi.useFakeTimers();
		let resolve: (() => void) | undefined;
		const publish = vi.fn().mockImplementation(
			() =>
				new Promise<void>((done) => {
					resolve = done;
				}),
		);
		const remove = vi
			.fn()
			.mockRejectedValue(new Error("private redis connection"));
		const heartbeat = await startLocalSemanticHeartbeat({
			env,
			initialized: true,
			publish,
			remove,
		});
		await vi.advanceTimersByTimeAsync(60_000);
		expect(publish).toHaveBeenCalledTimes(1);
		resolve?.();
		await Promise.resolve();
		await expect(heartbeat.stop()).resolves.toBeUndefined();
	});
});

const instanceId = "22222222-2222-4222-8222-222222222222";
const capabilityHash = "b".repeat(64);
const flowEnv = { ...env, BITOVP_LOCAL_STORY_FLOW_ENABLED: "1" };

describe("FLOW heartbeat plumbing", () => {
	it("contains a synchronous Redis removal error during shutdown", async () => {
		const runtime = await startLocalStoryFlowHeartbeat({
			env: flowEnv,
			initialized: true,
			instanceId,
			capabilityHash,
			publish: vi.fn().mockResolvedValue(undefined),
			remove: vi.fn(() => {
				throw new Error("private-redis-sentinel");
			}),
		});
		await expect(runtime.stop()).resolves.toBeUndefined();
	});
	it("shares a caller-owned instance with legacy without changing legacy wire or keys", async () => {
		const legacyPublish = vi.fn().mockResolvedValue(undefined);
		const flowPublish = vi.fn().mockResolvedValue(undefined);
		const remove = vi.fn().mockResolvedValue(undefined);
		const legacy = await startLocalSemanticHeartbeat({
			env,
			initialized: true,
			instanceId,
			publish: legacyPublish,
			remove,
		});
		const flow = await startLocalStoryFlowHeartbeat({
			env: flowEnv,
			initialized: true,
			instanceId,
			capabilityHash,
			publish: flowPublish,
			remove,
		});
		const oldRow = legacyPublish.mock.calls[0]?.[1];
		const row = flowPublish.mock.calls[0]?.[1];
		expect(oldRow).toMatchObject({
			version: "local-semantic-worker-v1",
			instanceId,
		});
		expect(oldRow).not.toHaveProperty("capabilityHash");
		expect(legacyPublish.mock.calls[0]?.[0].times).toBe(
			`bitovp:local-semantic:workers:{${oldRow.connectionHash}}:times`,
		);
		expect(row).toEqual({
			...oldRow,
			version: "local-story-flow-worker-v1",
			capabilityHash,
			observedAt: row.observedAt,
		});
		expect(flowPublish.mock.calls[0]?.[0]).toEqual({
			times: `bitovp:local-story-flow:{${oldRow.connectionHash}}:${capabilityHash}:workers:times`,
			records: `bitovp:local-story-flow:{${oldRow.connectionHash}}:${capabilityHash}:workers:records`,
		});
		expect(flowPublish.mock.calls[0]?.[2]).toBe(45_000);
		expect(JSON.stringify(flowPublish.mock.calls)).not.toMatch(
			/fixture\.invalid|aaaa|\/run\/ca/,
		);
		await Promise.all([legacy.stop(), flow.stop()]);
		expect(remove.mock.calls.every((call) => call[1] === instanceId)).toBe(
			true,
		);
	});
	it.each([
		true,
		false,
	])("publishes only the actual initialized state (%s), renewing every 15 seconds", async (initialized) => {
		vi.useFakeTimers();
		const publish = vi.fn().mockResolvedValue(undefined);
		const remove = vi.fn().mockResolvedValue(undefined);
		const runtime = await startLocalStoryFlowHeartbeat({
			env: flowEnv,
			initialized,
			instanceId,
			capabilityHash,
			publish,
			remove,
		});
		expect(publish.mock.calls[0]?.[1].state).toBe(
			initialized ? "READY" : "INITIALIZATION_FAILED",
		);
		await vi.advanceTimersByTimeAsync(15_000);
		expect(publish).toHaveBeenCalledTimes(2);
		expect(publish.mock.calls[1]?.[1]).toMatchObject({
			instanceId,
			capabilityHash,
			observedAt: Date.now(),
		});
		await runtime.stop();
		await runtime.stop();
		expect(remove).toHaveBeenCalledExactlyOnceWith(
			publish.mock.calls[0]?.[0],
			instanceId,
		);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(publish).toHaveBeenCalledTimes(2);
	});
	it("does no I/O without the operator, configuration and caller-owned pin/ID", async () => {
		vi.useFakeTimers();
		for (const change of [
			{ env },
			{ env: { ...flowEnv, BITOVP_LOCAL_STORY_FLOW_ENABLED: "0" } },
			{ env: { ...flowEnv, BITOVP_LOCAL_STORY_FLOW_ENABLED: "true" } },
			{ env: { BITOVP_LOCAL_STORY_FLOW_ENABLED: "1" } },
			{ capabilityHash: "bad" },
			{ instanceId: "bad" },
			{ captionModelHash: "bad" },
		]) {
			const publish = vi.fn();
			const remove = vi.fn();
			const runtime = await startLocalStoryFlowHeartbeat({
				env: flowEnv,
				initialized: true,
				instanceId,
				capabilityHash,
				publish,
				remove,
				...change,
			});
			await vi.advanceTimersByTimeAsync(30_000);
			await runtime.stop();
			expect(publish).not.toHaveBeenCalled();
			expect(remove).not.toHaveBeenCalled();
		}
	});
	it("bounds stop to one second while ordered Redis commands finish later, removing only its own row", async () => {
		vi.useFakeTimers();
		const rows = new Map<string, string>([["foreign-instance", "foreign"]]);
		const commands: (() => void)[] = [];
		// These callbacks model enqueue-on-invocation on ONE Redis connection.
		// They do not model arbitrary asynchronous writers with independent ordering.
		const publish = vi.fn(
			(_keys, row) =>
				new Promise<void>((resolve) => {
					commands.push(() => {
						rows.set(row.instanceId, row.state);
						resolve();
					});
				}),
		);
		const remove = vi.fn(
			(_keys, id: string) =>
				new Promise<void>((resolve) => {
					commands.push(() => {
						rows.delete(id);
						resolve();
					});
				}),
		);
		const runtime = await startLocalStoryFlowHeartbeat({
			env: flowEnv,
			initialized: true,
			instanceId,
			capabilityHash,
			publish,
			remove,
		});
		await vi.advanceTimersByTimeAsync(30_000);
		expect(publish).toHaveBeenCalledTimes(1);
		const stopped = runtime.stop();
		await vi.advanceTimersByTimeAsync(1_000);
		await expect(stopped).resolves.toBeUndefined();
		expect(commands).toHaveLength(2);
		for (const command of commands) command();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(rows).toEqual(new Map([["foreign-instance", "foreign"]]));
		expect(remove).toHaveBeenCalledExactlyOnceWith(
			publish.mock.calls[0]?.[0],
			instanceId,
		);
		expect(publish).toHaveBeenCalledTimes(1);
	});
});

it("never enqueues a microtask-scheduled legacy renewal after stop removed its own row", async () => {
	vi.useFakeTimers();
	let present = false;
	const publish = vi.fn(async () => {
		present = true;
	});
	const remove = vi.fn(async () => {
		present = false;
	});
	const runtime = await startLocalSemanticHeartbeat({
		env,
		initialized: true,
		publish,
		remove,
	});
	await vi.advanceTimersByTimeAsync(0);
	vi.advanceTimersByTime(15_000);
	await runtime.stop();
	expect(publish).toHaveBeenCalledTimes(1);
	expect(present).toBe(false);
});
