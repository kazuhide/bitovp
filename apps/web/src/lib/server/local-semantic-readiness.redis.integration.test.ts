import { randomUUID } from "node:crypto";
import {
	LOCAL_CLIP_AVAILABILITY_TTL_MS,
	type LocalSemanticConfiguration,
	type LocalSemanticWorkerHeartbeat,
	localSemanticConnectionHash,
	localSemanticWorkerRegistryKeys,
} from "@bitovp/core";
import { Redis } from "ioredis";
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { createClipEditingRuntimeGate } from "../../../../worker/src/library-editing/runtime-gate";
import {
	PUBLISH_LOCAL_SEMANTIC_HEARTBEAT,
	REMOVE_LOCAL_SEMANTIC_HEARTBEAT,
	startLocalSemanticHeartbeat,
} from "../../../../worker/src/library-editing/runtime-heartbeat";
import { readWorkerClipAvailability } from "./local-semantic-readiness";

const redisUrl = process.env.CLIP_AVAILABILITY_TEST_REDIS_URL;
const organizationId = "22222222-2222-4222-8222-222222222222";
const captionModelHash = "a".repeat(64);

// Registered by the required Redis runner. Ordinary source tests cannot claim
// that an unavailable Redis or physical GPU has been tested successfully.
describe.skipIf(!redisUrl)(
	"clip availability across worker and Web Redis boundaries",
	() => {
		let redis: Redis;
		const keys = new Set<string>();
		const stops: Array<() => Promise<void>> = [];
		beforeAll(async () => {
			if (redisUrl !== "redis://127.0.0.1:16382")
				throw new Error("Use the isolated clip-availability Redis server");
			redis = new Redis(redisUrl, { maxRetriesPerRequest: 0 });
			await redis.ping();
		});
		afterEach(async () => {
			await Promise.all(stops.splice(0).map((stop) => stop()));
			vi.unstubAllEnvs();
		});
		afterAll(async () => {
			try {
				if (keys.size) await redis.del(...keys);
			} finally {
				redis?.disconnect();
			}
		});

		async function fixture(profile: "nvidia" | "amd" = "nvidia") {
			vi.stubEnv("REDIS_URL", redisUrl);
			const config: LocalSemanticConfiguration & { captionModelHash: string } =
				{
					url: "https://fixture.invalid:11437",
					token: "synthetic-redis-fixture-".repeat(3),
					caFile: "/unused/fixture-ca.pem",
					profile,
					configId: randomUUID(),
					captionModelHash,
				};
			const hash = await localSemanticConnectionHash(config, captionModelHash);
			const registry = localSemanticWorkerRegistryKeys(hash);
			keys.add(registry.times);
			keys.add(registry.records);
			const row = (change: Partial<LocalSemanticWorkerHeartbeat> = {}) => ({
				version: "local-semantic-worker-v1" as const,
				connectionHash: hash,
				instanceId: randomUUID(),
				profile,
				state: "READY" as const,
				observedAt: Date.now(),
				clipAvailability: {
					version: "local-clip-availability-v2" as const,
					checkedAt: Date.now(),
					code: "READY" as const,
					authorizedOrganizationId: organizationId,
				},
				...change,
			});
			const publish = (value: LocalSemanticWorkerHeartbeat) =>
				redis.eval(
					PUBLISH_LOCAL_SEMANTIC_HEARTBEAT,
					2,
					registry.times,
					registry.records,
					value.instanceId,
					JSON.stringify(value),
					value.observedAt,
					45_000,
				);
			const read = () => readWorkerClipAvailability(config, organizationId);
			const start = async (
				gate: ReturnType<typeof createClipEditingRuntimeGate>,
			) => {
				const heartbeat = await startLocalSemanticHeartbeat({
					env: {
						BITOVP_LOCAL_SEMANTIC_ENABLED: "1",
						BITOVP_LOCAL_SEMANTIC_GATEWAY_URL: config.url,
						BITOVP_LOCAL_SEMANTIC_GATEWAY_TOKEN: config.token,
						BITOVP_LOCAL_SEMANTIC_CA_FILE: config.caFile,
						BITOVP_LOCAL_SEMANTIC_PROFILE: profile,
						BITOVP_LOCAL_SEMANTIC_CONFIG_ID: config.configId,
					},
					initialized: true,
					captionModelHash,
					clipAvailability: gate.observation,
					publish: (_keys, value) => publish(value),
					remove: (_keys, instanceId) =>
						redis.eval(
							REMOVE_LOCAL_SEMANTIC_HEARTBEAT,
							2,
							registry.times,
							registry.records,
							instanceId,
						),
				});
				stops.push(
					() => gate.stop(),
					() => heartbeat.stop(),
				);
				return heartbeat;
			};
			return { config, registry, row, publish, read, start };
		}

		it.each([
			"nvidia",
			"amd",
		] as const)("accepts current verified %s metadata through the real worker publisher and Web reader", async (profile) => {
			const f = await fixture(profile);
			const gate = createClipEditingRuntimeGate(f.config, undefined, {
				probe: async () => ({
					code: "READY",
					scope: "METADATA_ONLY",
					gpuObservedAt: Date.now(),
					authorizedOrganizationId: organizationId,
				}),
			});
			expect(await f.read()).toBe(false);
			expect(await gate.canClaim(organizationId)).toBe(true);
			await f.start(gate);
			await expect.poll(f.read, { timeout: 1_000 }).toBe(true);
			expect(
				await readWorkerClipAvailability(
					f.config,
					"33333333-3333-4333-8333-333333333333",
				),
			).toBe(false);
		});

		it("keeps initialized workers unavailable without a verified GPU or installed local model", async () => {
			for (const code of [
				"GPU_UNVERIFIED",
				"MODEL_NOT_INSTALLED",
				"RUNTIME_UNAVAILABLE",
			] as const) {
				const f = await fixture();
				const gate = createClipEditingRuntimeGate(f.config, undefined, {
					probe: async () => ({
						code,
						scope: "METADATA_ONLY",
						gpuObservedAt: undefined,
						authorizedOrganizationId: undefined,
					}),
				});
				expect(await gate.canClaim(organizationId)).toBe(false);
				await f.start(gate);
				await expect.poll(() => redis.hlen(f.registry.records)).toBe(1);
				expect(await f.read()).toBe(false);
			}
		});

		it("never lets a fresh heartbeat renew expired GPU evidence after process loss", async () => {
			const f = await fixture();
			const stale = f.row();
			stale.clipAvailability.checkedAt =
				Date.now() - LOCAL_CLIP_AVAILABILITY_TTL_MS - 1;
			await f.publish(stale);
			expect(await redis.hlen(f.registry.records)).toBe(1);
			expect(await f.read()).toBe(false);
		});

		it("rejects malformed, oversized and foreign-profile Redis records", async () => {
			const f = await fixture();
			const id = randomUUID();
			await redis.zadd(f.registry.times, Date.now(), id);
			for (const value of [
				"{invalid",
				"x".repeat(2_049),
				JSON.stringify(f.row({ profile: "amd" })),
			]) {
				await redis.hset(f.registry.records, id, value);
				expect(await f.read()).toBe(false);
			}
		});

		it("removes only the stopped instance and requires a restarted worker to establish its own evidence", async () => {
			const f = await fixture();
			const peer = f.row();
			await f.publish(peer);
			const unverified = createClipEditingRuntimeGate(f.config, undefined, {
				probe: async () => ({
					code: "GPU_UNVERIFIED",
					scope: "METADATA_ONLY",
					gpuObservedAt: undefined,
					authorizedOrganizationId: undefined,
				}),
			});
			const heartbeat = await f.start(unverified);
			await expect.poll(() => redis.hlen(f.registry.records)).toBe(2);
			await heartbeat.stop();
			expect(await redis.hkeys(f.registry.records)).toEqual([peer.instanceId]);
			expect(await f.read()).toBe(true);
			await redis.hdel(f.registry.records, peer.instanceId);
			await redis.zrem(f.registry.times, peer.instanceId);
			await f.start(unverified);
			await expect.poll(() => redis.hlen(f.registry.records)).toBe(1);
			expect(await f.read()).toBe(false);
		});

		it("withdraws previously available work after a model outage", async () => {
			const f = await fixture();
			let available = true;
			const gate = createClipEditingRuntimeGate(f.config, undefined, {
				probe: async () =>
					available
						? {
								code: "READY",
								scope: "METADATA_ONLY",
								gpuObservedAt: Date.now(),
								authorizedOrganizationId: organizationId,
							}
						: {
								code: "RUNTIME_UNAVAILABLE",
								scope: "METADATA_ONLY",
								gpuObservedAt: undefined,
								authorizedOrganizationId: undefined,
							},
			});
			expect(await gate.canClaim(organizationId)).toBe(true);
			gate.start();
			await f.start(gate);
			await expect.poll(f.read).toBe(true);
			available = false;
			await expect.poll(f.read, { timeout: 12_000, interval: 100 }).toBe(false);
			expect(await gate.canClaim(organizationId)).toBe(false);
		}, 15_000);

		it("fails closed when Redis cannot be reached instead of retaining a previous success", async () => {
			const f = await fixture();
			await f.publish(f.row());
			expect(await f.read()).toBe(true);
			vi.stubEnv("REDIS_URL", "redis://127.0.0.1:1");
			expect(await f.read()).toBe(false);
		});
	},
);
