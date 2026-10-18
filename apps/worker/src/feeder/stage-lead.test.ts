import { describe, expect, it } from "vitest";
import {
	estimateStageLeadMs,
	PAID_RUN_5,
	STAGE_LEAD_BANDWIDTH_BYTES_PER_SEC,
	STAGE_LEAD_BASE_MS,
	STAGE_LEAD_MAX_MS,
} from "./stage-lead";

describe("estimateStageLeadMs (row #240 — the pre-stage lead)", () => {
	it("is base + size / bandwidth for an ordinary source", () => {
		const size = 300_000_000;
		expect(estimateStageLeadMs(size)).toBe(
			STAGE_LEAD_BASE_MS +
				Math.ceil((size / STAGE_LEAD_BANDWIDTH_BYTES_PER_SEC) * 1000),
		);
	});

	it("covers the audit's paid run #5 with margin — the one real measurement", () => {
		const lead = estimateStageLeadMs(PAID_RUN_5.sourceBytes);
		// Not merely "more than measured": at least twice the CONNECTED time,
		// so a constant edit that eats the safety factor is visible here
		// before it is visible on air.
		expect(lead).toBeGreaterThanOrEqual(2 * PAID_RUN_5.firedToConnectedMs);
		expect(lead).toBeGreaterThan(PAID_RUN_5.firedToPushingMs);
		// The number itself, so a reader can check the arithmetic: 120 s +
		// 725 MB at 10 MB/s = 72.5 s → 192.5 s.
		expect(lead).toBe(192_500);
	});

	it("caps at ten minutes for a source larger than the cap can stage", () => {
		expect(estimateStageLeadMs(20_000_000_000)).toBe(STAGE_LEAD_MAX_MS);
		expect(STAGE_LEAD_MAX_MS).toBe(600_000);
	});

	it("falls back to the base alone when the size is unknown or unreadable", () => {
		expect(estimateStageLeadMs(null)).toBe(STAGE_LEAD_BASE_MS);
		expect(estimateStageLeadMs(undefined)).toBe(STAGE_LEAD_BASE_MS);
		expect(estimateStageLeadMs(Number.NaN)).toBe(STAGE_LEAD_BASE_MS);
		expect(estimateStageLeadMs(-1)).toBe(STAGE_LEAD_BASE_MS);
		expect(estimateStageLeadMs(0)).toBe(STAGE_LEAD_BASE_MS);
	});

	it("accepts the BigInt the session column carries", () => {
		expect(estimateStageLeadMs(BigInt(PAID_RUN_5.sourceBytes))).toBe(
			estimateStageLeadMs(PAID_RUN_5.sourceBytes),
		);
	});

	it("is monotone in size — a bigger source never gets a shorter lead", () => {
		let previous = estimateStageLeadMs(0);
		for (const size of [1, 1_000, 1e6, 1e8, 7.25e8, 3e9, 1e10, 1e12]) {
			const lead = estimateStageLeadMs(size);
			expect(lead).toBeGreaterThanOrEqual(previous);
			previous = lead;
		}
	});
});
