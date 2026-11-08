import {
	hashEditingEvidence,
	localSemanticConnectionHash,
	readLocalSemanticConfiguration,
} from "@bitovp/core";
import { readLocalCaptionTranslationSelection } from "@bitovp/core/local-caption-config";
import { beforeEach, describe, expect, it, vi } from "vitest";

const redis = vi.hoisted(() => ({
	connect: vi.fn(),
	zrangebyscore: vi.fn(),
	hmget: vi.fn(),
	disconnect: vi.fn(),
	on: vi.fn(),
}));
vi.mock("ioredis", () => ({
	Redis: class {
		connect = redis.connect;
		zrangebyscore = redis.zrangebyscore;
		hmget = redis.hmget;
		disconnect = redis.disconnect;
		on = redis.on;
	},
}));

import { isClipEditingAvailable } from "./library-editing-feature";

const env = {
	BITOVP_LOCAL_SEMANTIC_ENABLED: "1",
	BITOVP_LOCAL_SEMANTIC_GATEWAY_URL: "https://fixture.invalid:11437",
	BITOVP_LOCAL_SEMANTIC_GATEWAY_TOKEN: "a".repeat(48),
	BITOVP_LOCAL_SEMANTIC_CA_FILE: "/fixture/ca.pem",
	BITOVP_LOCAL_SEMANTIC_PROFILE: "nvidia",
	BITOVP_LOCAL_SEMANTIC_CONFIG_ID: "11111111-1111-4111-8111-111111111111",
};
beforeEach(() => {
	redis.connect.mockReset().mockResolvedValue(undefined);
	redis.zrangebyscore
		.mockReset()
		.mockResolvedValue(["11111111-1111-4111-8111-111111111111"]);
	redis.hmget.mockReset().mockResolvedValue([]);
	redis.disconnect.mockReset();
});
async function row() {
	const config = readLocalSemanticConfiguration(env);
	if (!config) throw new Error("Missing fixture configuration");
	return {
		version: "local-semantic-worker-v1",
		connectionHash: await localSemanticConnectionHash(
			config,
			hashEditingEvidence(
				readLocalCaptionTranslationSelection(config, env).identity,
			),
		),
		instanceId: "11111111-1111-4111-8111-111111111111",
		profile: "nvidia",
		state: "READY",
		observedAt: Date.now(),
		clipAvailability: {
			version: "local-clip-availability-v1",
			checkedAt: Date.now(),
			code: "READY",
		},
	};
}
describe("Web reads bounded worker evidence without probing a model", () => {
	it("accepts a healthy configured LAN GPU worker", async () => {
		redis.hmget.mockResolvedValue([JSON.stringify(await row())]);
		expect(await isClipEditingAvailable(env)).toBe(true);
		expect(redis.disconnect).toHaveBeenCalledOnce();
	});
	it("rejects stale or differently bound good receipts and missing GPU checks", async () => {
		const good = await row();
		for (const value of [
			{ ...good, clipAvailability: undefined },
			{ ...good, profile: "amd" },
			{ ...good, connectionHash: "b".repeat(64) },
			{
				...good,
				clipAvailability: {
					...good.clipAvailability,
					checkedAt: Date.now() - 16_000,
				},
			},
		]) {
			redis.hmget.mockResolvedValue([JSON.stringify(value)]);
			expect(await isClipEditingAvailable(env)).toBe(false);
		}
	});
	it("fails closed on malformed, too many, missing and unreachable registry results", async () => {
		redis.hmget.mockResolvedValue(["{invalid"]);
		expect(await isClipEditingAvailable(env)).toBe(false);
		redis.zrangebyscore.mockResolvedValue([]);
		expect(await isClipEditingAvailable(env)).toBe(false);
		redis.zrangebyscore.mockResolvedValue(Array(101).fill("fixture"));
		expect(await isClipEditingAvailable(env)).toBe(false);
		redis.connect.mockRejectedValue(new Error("private address"));
		expect(await isClipEditingAvailable(env)).toBe(false);
	});
});
