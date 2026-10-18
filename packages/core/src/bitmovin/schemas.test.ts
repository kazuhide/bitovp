import { describe, expect, it } from "vitest";
import {
	createBitmovinAccountSchema,
	updateBitmovinAccountSchema,
} from "./schemas";

describe("createBitmovinAccountSchema", () => {
	it("applies sane defaults", () => {
		const parsed = createBitmovinAccountSchema.parse({
			label: "main",
			apiKey: "key",
		});
		expect(parsed.defaults.encoderVersion).toBe("STABLE");
		expect(parsed.defaults.cloudRegion).toBe("AUTO");
		expect(parsed.defaults.fallbackRegions).toEqual([]);
		expect(parsed.tenantOrgId).toBeUndefined();
	});

	it("bounds scheduling priority to 0–100", () => {
		const make = (schedulingPriority: number) =>
			createBitmovinAccountSchema.safeParse({
				label: "x",
				apiKey: "k",
				defaults: { schedulingPriority },
			});
		expect(make(0).success).toBe(true);
		expect(make(100).success).toBe(true);
		expect(make(101).success).toBe(false);
		expect(make(-1).success).toBe(false);
	});

	it("requires label and apiKey", () => {
		expect(
			createBitmovinAccountSchema.safeParse({ label: "", apiKey: "" }).success,
		).toBe(false);
	});
});

describe("updateBitmovinAccountSchema", () => {
	it("accepts clearing tenantOrgId with null", () => {
		const parsed = updateBitmovinAccountSchema.parse({ tenantOrgId: null });
		expect(parsed.tenantOrgId).toBeNull();
	});

	it("rejects an empty apiKey rotation", () => {
		expect(updateBitmovinAccountSchema.safeParse({ apiKey: "" }).success).toBe(
			false,
		);
	});
});

describe("defaults round-trip keeps the rate card (review-84b I2)", () => {
	it("the rateCard key SURVIVES the strip-unknown parse — deleting its schema line fails here", async () => {
		// z.object strips unknown keys, and the settings save round-trips the
		// WHOLE defaults object — so the one line listing rateCard in
		// bitmovinAccountDefaultsSchema is load-bearing. The reviewer deleted
		// it and 4,262 tests stayed green; this is the missing pin.
		const { bitmovinAccountDefaultsSchema } = await import("./schemas");
		const parsed = bitmovinAccountDefaultsSchema.parse({
			encoderVersion: "STABLE",
			rateCard: {
				currency: "USD",
				liveRates: [{ maxHeight: 1080, perHour: 3 }],
			},
		});
		expect(parsed.rateCard).toBeDefined();
		expect(parsed.rateCard?.currency).toBe("USD");
	});
});
