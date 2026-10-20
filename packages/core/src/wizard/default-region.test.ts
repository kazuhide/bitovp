import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { encodingPlanSchema } from "../plan/schema";
import { buildPlan, DEFAULT_WIZARD_STATE } from "./build-plan";
import { planToWizardState } from "./plan-to-wizard";

describe("new VOD encoder region", () => {
	it("uses AUTO while retaining the STABLE encoder line", () => {
		expect(DEFAULT_WIZARD_STATE.cloudRegion).toBe("AUTO");
		expect(buildPlan(DEFAULT_WIZARD_STATE).bitmovin).toMatchObject({
			cloudRegion: "AUTO",
			encoderVersion: "STABLE",
		});
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
