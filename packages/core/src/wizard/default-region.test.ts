import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { encodingPlanSchema } from "../plan/schema";
import { buildPlan, DEFAULT_WIZARD_STATE } from "./build-plan";
import { planToWizardState } from "./plan-to-wizard";

describe("new VOD encoder region", () => {
	it("uses AUTO and pins new VOD forms to Encoder 2.291.0", () => {
		expect(DEFAULT_WIZARD_STATE.cloudRegion).toBe("AUTO");
		expect(buildPlan(DEFAULT_WIZARD_STATE).bitmovin).toMatchObject({
			cloudRegion: "AUTO",
			encoderVersion: "2.291.0",
		});
	});

	it.each([
		"STABLE",
		"BETA",
		"2.287.0",
		"2.291.0",
		"custom-version",
	])("keeps the imported encoder %s", (encoderVersion) => {
		const plan = buildPlan(DEFAULT_WIZARD_STATE);
		plan.bitmovin = { ...plan.bitmovin, encoderVersion };
		expect(planToWizardState(plan).encoderVersion).toBe(encoderVersion);
	});

	it("keeps STABLE for old imported plans that omitted the encoder version", () => {
		const plan = buildPlan(DEFAULT_WIZARD_STATE);
		plan.bitmovin = { cloudRegion: "AUTO" };
		expect(
			encodingPlanSchema.shape.bitmovin.parse(plan.bitmovin).encoderVersion,
		).toBe("STABLE");
		expect(planToWizardState(plan).encoderVersion).toBe("STABLE");
	});

	it("preserves an explicit region when a plan is copied through the wizard", () => {
		const plan = encodingPlanSchema.parse(
			JSON.parse(
				readFileSync(
					new URL(
						"../plan/__fixtures__/fixed-bitrate-hls-on-aws.plan.json",
						import.meta.url,
					),
					"utf8",
				),
			),
		);
		expect(plan.bitmovin.cloudRegion).toBe("AWS_AP_NORTHEAST_1");
		const copied = planToWizardState(plan);
		expect(copied.cloudRegion).toBe("AWS_AP_NORTHEAST_1");
		expect(encodingPlanSchema.parse(buildPlan(copied))).toEqual(plan);
	});
});
