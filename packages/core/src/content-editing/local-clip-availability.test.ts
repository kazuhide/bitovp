import { describe, expect, it } from "vitest";
import { summarizeClipEditingAvailability } from "./local-semantic-readiness";

const now = 100_000;
const hash = "a".repeat(64);
const row = {
	version: "local-semantic-worker-v1",
	connectionHash: hash,
	instanceId: "11111111-1111-4111-8111-111111111111",
	profile: "nvidia",
	state: "READY",
	observedAt: now,
	clipAvailability: {
		version: "local-clip-availability-v1",
		checkedAt: now,
		code: "READY",
	},
};

describe("clip availability uses fresh GPU checks from the configured worker", () => {
	it("accepts a current healthy LAN worker without requiring GPU on Web", () => {
		expect(summarizeClipEditingAvailability([row], hash, "nvidia", now)).toBe(
			true,
		);
	});
	it.each([
		{ ...row, clipAvailability: undefined },
		{
			...row,
			clipAvailability: { ...row.clipAvailability, code: "UNAVAILABLE" },
		},
		{
			...row,
			clipAvailability: { ...row.clipAvailability, checkedAt: now - 15_001 },
		},
		{
			...row,
			clipAvailability: { ...row.clipAvailability, checkedAt: now + 5_001 },
		},
		{ ...row, state: "INITIALIZATION_FAILED" },
		{ ...row, profile: "amd" },
		{ ...row, connectionHash: "b".repeat(64) },
		{ ...row, observedAt: now - 45_001 },
	])("rejects unavailable, old, unproven or differently bound evidence %#", (value) => {
		expect(summarizeClipEditingAvailability([value], hash, "nvidia", now)).toBe(
			false,
		);
	});
	it("rejects missing evidence and bounds the registry without treating unknown as ready", () => {
		expect(summarizeClipEditingAvailability([], hash, "nvidia", now)).toBe(
			false,
		);
		expect(
			summarizeClipEditingAvailability(
				Array(101).fill(row),
				hash,
				"nvidia",
				now,
			),
		).toBe(false);
	});
});
