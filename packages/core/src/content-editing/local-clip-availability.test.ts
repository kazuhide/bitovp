import { describe, expect, it } from "vitest";
import { summarizeClipEditingAvailability } from "./local-semantic-readiness";

const now = 100_000;
const hash = "a".repeat(64);
const organizationId = "22222222-2222-4222-8222-222222222222";
const row = {
	version: "local-semantic-worker-v1",
	connectionHash: hash,
	instanceId: "11111111-1111-4111-8111-111111111111",
	profile: "nvidia",
	state: "READY",
	observedAt: now,
	clipAvailability: {
		version: "local-clip-availability-v2",
		checkedAt: now,
		code: "READY",
		authorizedOrganizationId: organizationId,
	},
};
const available = (rows: readonly unknown[], org = organizationId) =>
	summarizeClipEditingAvailability(rows, hash, "nvidia", now, org);

describe("clip availability uses fresh GPU checks bound to the authorized organization", () => {
	it("accepts a current healthy LAN worker without requiring GPU on Web", () => {
		expect(available([row])).toBe(true);
	});
	it("never lends the Gateway token's tenant admission to another tenant", () => {
		expect(available([row], "33333333-3333-4333-8333-333333333333")).toBe(
			false,
		);
		expect(available([row], "")).toBe(false);
	});
	it.each([
		{ ...row, clipAvailability: undefined },
		{
			...row,
			clipAvailability: {
				...row.clipAvailability,
				version: "local-clip-availability-v1",
			},
		},
		{
			...row,
			clipAvailability: {
				...row.clipAvailability,
				authorizedOrganizationId: undefined,
			},
		},
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
		expect(available([value])).toBe(false);
	});
	it("keeps an old unscoped READY heartbeat unavailable", () => {
		expect(
			available([
				{
					...row,
					clipAvailability: {
						version: "local-clip-availability-v1",
						checkedAt: now,
						code: "READY",
					},
				},
			]),
		).toBe(false);
	});
	it("rejects missing evidence and bounds the registry without treating unknown as ready", () => {
		expect(available([])).toBe(false);
		expect(available(Array(101).fill(row))).toBe(false);
	});
});
