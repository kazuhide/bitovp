import { expect, it } from "vitest";
import { experimentMeasurementTimeoutMs } from "./runner-process";

it("reserves a full extra stage for managed two-pass runs and secondary scoring", () => {
	const encoder = "libx264" as const;
	expect(experimentMeasurementTimeoutMs({})).toBe(750_000);
	expect(
		experimentMeasurementTimeoutMs({ software: { encoder, options: {} } }),
	).toBe(750_000);
	expect(
		experimentMeasurementTimeoutMs({
			software: { encoder, options: { passes: "2" } },
		}),
	).toBe(1_050_000);
	expect(
		experimentMeasurementTimeoutMs({
			additionalScoringProfiles: ["bitovp-vmaf-cuda-1.0.16-3d0h"],
		}),
	).toBe(1_050_000);
});
