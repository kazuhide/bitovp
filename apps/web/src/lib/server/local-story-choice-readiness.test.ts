import {
	hashEditingEvidence,
	localSemanticConnectionHash,
	readLocalSemanticConfiguration,
} from "@bitovp/core";
import { readLocalCaptionTranslationSelection } from "@bitovp/core/local-caption-config";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { isLocalStoryChoiceReady } from "./local-story-choice-readiness";

const holder = vi.hoisted(() => ({
	construct: vi.fn(),
	redis: {
		on: vi.fn(),
		connect: vi.fn(),
		zcount: vi.fn(),
		eval: vi.fn(),
		get: vi.fn(),
		disconnect: vi.fn(),
	},
}));
vi.mock("ioredis", () => ({
	Redis: class {
		on = holder.redis.on;
		connect = holder.redis.connect;
		zcount = holder.redis.zcount;
		eval = holder.redis.eval;
		get = holder.redis.get;
		disconnect = holder.redis.disconnect;
		constructor() {
			holder.construct();
		}
	},
}));
vi.mock("@bitovp/core", async (importOriginal) => ({
	...(await importOriginal<typeof import("@bitovp/core")>()),
	loadEnv: () => ({ REDIS_URL: "redis://fixture.invalid" }),
}));
const env = {
	BITOVP_LOCAL_STORY_CHOICE_ENABLED: "1",
	BITOVP_LOCAL_SEMANTIC_ENABLED: "1",
	BITOVP_LOCAL_SEMANTIC_GATEWAY_URL: "https://fixture.invalid:11437",
	BITOVP_LOCAL_SEMANTIC_GATEWAY_TOKEN: "a".repeat(48),
	BITOVP_LOCAL_SEMANTIC_CA_FILE: "/run/private-ca.pem",
	BITOVP_LOCAL_SEMANTIC_PROFILE: "nvidia",
	BITOVP_LOCAL_SEMANTIC_CONFIG_ID: "11111111-1111-4111-8111-111111111111",
};
let response: Record<string, unknown>;
beforeEach(async () => {
	vi.clearAllMocks();
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-11-07T14:00:00Z"));
	const config = readLocalSemanticConfiguration(env);
	if (!config) throw new Error("Invalid fixture configuration");
	const connectionHash = await localSemanticConnectionHash(
		config,
		hashEditingEvidence(
			readLocalCaptionTranslationSelection(config, env).identity,
		),
	);
	holder.redis.connect.mockResolvedValue(undefined);
	holder.redis.zcount.mockResolvedValue(1);
	holder.redis.eval.mockImplementation(async (...args: unknown[]) => {
		const request = JSON.parse(String(args.at(-1)));
		response = {
			version: "local-story-choice-diagnostic-result-v1",
			requestId: request.requestId,
			connectionHash,
			profile: "nvidia",
			observedAt: Date.now(),
			diagnostic: { code: "READY", scope: "METADATA_ONLY" },
		};
		return JSON.stringify(request);
	});
	holder.redis.get.mockImplementation(async () => JSON.stringify(response));
});
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

it("requires the operator flag and complete local configuration without opening Redis", async () => {
	expect(await isLocalStoryChoiceReady({})).toBe(false);
	expect(
		await isLocalStoryChoiceReady({
			...env,
			BITOVP_LOCAL_STORY_CHOICE_ENABLED: undefined,
		}),
	).toBe(false);
	expect(holder.construct).not.toHaveBeenCalled();
});
it("accepts only a fresh Choice result and uses its dedicated metadata-only channel", async () => {
	expect(await isLocalStoryChoiceReady(env)).toBe(true);
	expect(holder.redis.eval.mock.calls[0]?.[2]).toContain(":choice-diagnostic:");
	expect(holder.redis.eval.mock.calls[0]?.[3]).toContain(":choice-diagnostic:");
	expect(holder.redis.get.mock.calls[0]?.[0]).toContain(":choice-diagnostic:");
	expect(holder.redis.disconnect).toHaveBeenCalledTimes(1);
});
it.each([
	"legacy",
	"connection",
	"request",
	"profile",
	"stale",
	"gateway",
])("rejects a %s result instead of upgrading old readiness", async (kind) => {
	holder.redis.get.mockImplementation(async () => {
		const changed = { ...response };
		if (kind === "legacy")
			changed.version = "local-semantic-diagnostic-result-v1";
		if (kind === "connection") changed.connectionHash = "f".repeat(64);
		if (kind === "request")
			changed.requestId = "33333333-3333-4333-8333-333333333333";
		if (kind === "profile") changed.profile = "amd";
		if (kind === "stale") changed.observedAt = Date.now() - 50_000;
		if (kind === "gateway")
			changed.diagnostic = {
				code: "COMPATIBILITY_MISMATCH",
				scope: "METADATA_ONLY",
			};
		return JSON.stringify(changed);
	});
	expect(await isLocalStoryChoiceReady(env)).toBe(false);
	expect(holder.redis.disconnect).toHaveBeenCalledTimes(1);
});
it("rejects an absent worker before requesting a diagnostic", async () => {
	holder.redis.zcount.mockResolvedValue(0);
	expect(await isLocalStoryChoiceReady(env)).toBe(false);
	expect(holder.redis.eval).not.toHaveBeenCalled();
});
it("fails closed and disconnects after a registry error", async () => {
	holder.redis.connect.mockRejectedValue(
		new Error("Synthetic registry failure"),
	);
	expect(await isLocalStoryChoiceReady(env)).toBe(false);
	expect(holder.redis.disconnect).toHaveBeenCalledTimes(1);
});
