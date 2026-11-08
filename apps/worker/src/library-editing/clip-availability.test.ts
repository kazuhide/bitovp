import { afterEach, describe, expect, it, vi } from "vitest";
import { createClipEditingRuntimeGate } from "./runtime-gate";

const config = {
	url: "https://fixture.invalid",
	token: "a".repeat(48),
	caFile: "/fixture/ca",
	profile: "nvidia" as const,
	configId: "11111111-1111-4111-8111-111111111111",
};
afterEach(() => vi.useRealTimers());
describe("worker claim admission", () => {
	it("does not renew the age of an already observed GPU success", async () => {
		let now = 100_000;
		const gate = createClipEditingRuntimeGate(config, undefined, {
			now: () => now,
			probe: vi.fn().mockResolvedValue({
				code: "READY",
				scope: "METADATA_ONLY",
				gpuObservedAt: now - 14_900,
			}),
		});
		expect(await gate.canClaim()).toBe(true);
		expect(gate.observation().checkedAt).toBe(85_100);
		now += 101;
		expect(gate.observation().code).toBe("UNAVAILABLE");
		expect(await gate.canClaim()).toBe(false);
		await gate.stop();
	});
	it("coalesces probes, accepts verified LAN GPU, and expires good evidence while its refresh is unavailable", async () => {
		let now = 100_000;
		const probe = vi.fn().mockResolvedValue({
			code: "READY",
			scope: "METADATA_ONLY",
			gpuObservedAt: now,
		});
		const gate = createClipEditingRuntimeGate(config, undefined, {
			probe,
			now: () => now,
		});
		expect(gate.observation().code).toBe("UNAVAILABLE");
		expect(await Promise.all([gate.canClaim(), gate.canClaim()])).toEqual([
			true,
			true,
		]);
		expect(probe).toHaveBeenCalledTimes(1);
		now += 16_000;
		probe.mockRejectedValueOnce(new Error("private host"));
		expect(gate.observation().code).toBe("UNAVAILABLE");
		expect(await gate.canClaim()).toBe(false);
		expect(gate.observation().code).toBe("UNAVAILABLE");
		await gate.stop();
	});
	it.each([
		"CONNECTION_FAILED",
		"AUTH_FAILED",
		"TLS_FAILED",
		"MODEL_MISMATCH",
		"GPU_UNVERIFIED",
		"GATEWAY_STOPPING",
	])("blocks claims for %s without exceptions escaping", async (code) => {
		const gate = createClipEditingRuntimeGate(config, undefined, {
			probe: vi.fn().mockResolvedValue({ code, scope: "METADATA_ONLY" }),
		});
		expect(await gate.canClaim()).toBe(false);
		await gate.stop();
	});
	it("bounds an unresponsive probe and keeps claim admission closed after stop", async () => {
		vi.useFakeTimers();
		const gate = createClipEditingRuntimeGate(config, undefined, {
			probe: () => new Promise(() => {}),
		});
		const pending = gate.canClaim();
		await vi.advanceTimersByTimeAsync(4_000);
		expect(await pending).toBe(false);
		await gate.stop();
		expect(await gate.canClaim()).toBe(false);
	});
});
