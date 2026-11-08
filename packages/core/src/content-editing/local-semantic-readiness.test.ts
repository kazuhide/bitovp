import { describe, expect, it } from "vitest";
import {
	localSemanticConnectionHash,
	summarizeLocalSemanticWorkers,
} from "./local-semantic-readiness";

const config = {
	url: "https://fixture.invalid:11437/",
	token: "a".repeat(48),
	caFile: "/run/ca.pem",
	profile: "nvidia" as const,
	configId: "11111111-1111-4111-8111-111111111111",
};
const now = 100_000;
const record = (overrides = {}) => ({
	version: "local-semantic-worker-v1",
	connectionHash: "a".repeat(64),
	instanceId: "22222222-2222-4222-8222-222222222222",
	profile: "nvidia",
	state: "READY",
	observedAt: now,
	...overrides,
});

describe("local semantic readiness provenance", () => {
	it("binds workers to connection identity while allowing a different mounted CA path", async () => {
		const expected = await localSemanticConnectionHash(config);
		expect(expected).toMatch(/^[a-f0-9]{64}$/);
		expect(
			await localSemanticConnectionHash({
				...config,
				caFile: "/another/mount.pem",
			}),
		).toBe(expected);
		for (const change of [
			{ token: "b".repeat(48) },
			{ url: "https://other.invalid/" },
			{ profile: "amd" as const },
			{ configId: "33333333-3333-4333-8333-333333333333" },
		]) {
			expect(
				await localSemanticConnectionHash({ ...config, ...change }),
			).not.toBe(expected);
		}
		expect(await localSemanticConnectionHash(config, "a".repeat(64))).not.toBe(
			expected,
		);
		expect(await localSemanticConnectionHash(config, "a".repeat(64))).not.toBe(
			await localSemanticConnectionHash(config, "b".repeat(64)),
		);
		await expect(
			localSemanticConnectionHash(config, "bad identity"),
		).rejects.toThrow("LOCAL_SEMANTIC_CAPTION_IDENTITY_INVALID");
	});
	it("distinguishes no worker, failed initialization, ready and mixed workers", () => {
		expect(
			summarizeLocalSemanticWorkers([], "a".repeat(64), "nvidia", now).code,
		).toBe("MISSING");
		expect(
			summarizeLocalSemanticWorkers(
				[record({ state: "INITIALIZATION_FAILED" })],
				"a".repeat(64),
				"nvidia",
				now,
			).code,
		).toBe("INITIALIZATION_FAILED");
		expect(
			summarizeLocalSemanticWorkers([record()], "a".repeat(64), "nvidia", now),
		).toMatchObject({ code: "READY", readyCount: 1, failedCount: 0 });
		expect(
			summarizeLocalSemanticWorkers(
				[
					record(),
					record({
						instanceId: "44444444-4444-4444-8444-444444444444",
						state: "INITIALIZATION_FAILED",
					}),
				],
				"a".repeat(64),
				"nvidia",
				now,
			),
		).toMatchObject({ code: "MIXED", readyCount: 1, failedCount: 1 });
	});
	it("rejects stale, future, foreign, duplicated and untrusted fields", () => {
		const rows = [
			record({ observedAt: now - 45_001 }),
			record({ observedAt: now + 5_001 }),
			record({ connectionHash: "b".repeat(64) }),
			record({ profile: "amd" }),
			record({ privateToken: config.token }),
			null,
			{},
			record(),
			record(),
		];
		expect(
			summarizeLocalSemanticWorkers(rows, "a".repeat(64), "nvidia", now),
		).toMatchObject({ code: "READY", readyCount: 1, failedCount: 0 });
	});
});
