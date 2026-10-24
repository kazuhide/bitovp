import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	encodingPlanSchema,
	perTitleSchema,
	perTitleStreamSettingsSchema,
} from "./schema";

const codecConfigurations = [
	"h264Configuration",
	"h265Configuration",
	"h265V2Configuration",
	"vp9Configuration",
	"av1Configuration",
] as const;

describe("Per-Title API bitrate limits", () => {
	it.each(
		codecConfigurations,
	)("rejects a global minimum below 10 kbps for %s", (codec) => {
		const result = perTitleSchema.safeParse({
			[codec]: { minBitrate: 9999, maxBitrate: 10000 },
		});
		expect(result.success).toBe(false);
		if (result.success) throw new Error("Expected the global floor to reject");
		expect(result.error.issues).toContainEqual(
			expect.objectContaining({ path: [codec, "minBitrate"] }),
		);
	});
	it.each(
		codecConfigurations,
	)("rejects a global maximum below 10 kbps for %s", (codec) => {
		const result = perTitleSchema.safeParse({
			[codec]: { maxBitrate: 9999 },
		});
		expect(result.success).toBe(false);
		if (result.success) throw new Error("Expected the global floor to reject");
		expect(result.error.issues).toContainEqual(
			expect.objectContaining({ path: [codec, "maxBitrate"] }),
		);
	});
	it.each(
		codecConfigurations,
	)("accepts the floor, equal bounds, and omitted defaults for %s", (codec) => {
		for (const values of [
			{},
			{ minBitrate: 10000 },
			{ maxBitrate: 10000 },
			{ minBitrate: 10000, maxBitrate: 10000 },
			{ minBitrate: 100000, maxBitrate: 100000 },
		]) {
			expect(perTitleSchema.safeParse({ [codec]: values }).success).toBe(true);
		}
	});
	it("keeps per-stream bounds positive without imposing the global floor", () => {
		expect(
			perTitleStreamSettingsSchema.safeParse({
				minBitrate: 1,
				maxBitrate: 9999,
			}).success,
		).toBe(true);
		expect(
			perTitleStreamSettingsSchema.safeParse({ minBitrate: 0 }).success,
		).toBe(false);
	});
	it("rejects the same invalid range when embedded in an encoding plan", () => {
		const plan = JSON.parse(
			readFileSync(
				join(
					__dirname,
					"__fixtures__/fixed-bitrate-dash-hls-streamcondition-on-aws.plan.json",
				),
				"utf8",
			),
		);
		plan.perTitle = {
			h264Configuration: { minBitrate: 9999, maxBitrate: 10000 },
		};
		expect(encodingPlanSchema.safeParse(plan).success).toBe(false);
		plan.perTitle.h264Configuration.minBitrate = 10000;
		expect(encodingPlanSchema.safeParse(plan).success).toBe(true);
	});
});
