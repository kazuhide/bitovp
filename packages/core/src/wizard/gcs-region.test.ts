import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { encodingPlanSchema } from "../plan/schema";
import { buildPlan } from "./build-plan";
import { planToWizardState } from "./plan-to-wizard";

describe("wizard GCS storage region", () => {
	it.each([
		"GCS",
		"GCS_SERVICE_ACCOUNT",
	] as const)("round-trips %s source, origin and mirror regions", (kind) => {
		const original = encodingPlanSchema.parse(
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
		const plan = encodingPlanSchema.parse({
			...original,
			inputs: original.inputs.map((input) => ({
				...input,
				kind,
				region: "ASIA_EAST_1",
			})),
			outputs: [
				{ ...original.outputs[0], kind, region: "EUROPE_WEST_1" },
				{
					...original.outputs[0],
					key: "mirror-1",
					kind,
					region: "US_CENTRAL_1",
				},
			],
			deliveryMirrors: [{ outputKey: "mirror-1" }],
		});
		const state = planToWizardState(plan);
		expect(state.inputFiles[0]).toHaveProperty("region", "ASIA_EAST_1");
		expect(state.output).toHaveProperty("region", "EUROPE_WEST_1");
		expect(state.additionalOutputs[0]).toHaveProperty("region", "US_CENTRAL_1");
		expect(encodingPlanSchema.parse(buildPlan(state))).toEqual(plan);
	});
});
