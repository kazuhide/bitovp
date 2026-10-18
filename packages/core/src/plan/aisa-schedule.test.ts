import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { buildPlan } from "../wizard/build-plan";
import { tryImportPresetIntoWizard } from "../wizard/plan-to-wizard";
import { compilePlan } from "./compiler";
import { encodingPlanSchema } from "./schema";
import { planToEncodingTemplateYaml } from "./template";
import { loadPlan } from "./test-support";

const schedule = [
	{ position: 2280.5, maxDeviation: 0 },
	{ position: 0, maxDeviation: 1, duration: 0 },
	{ position: 42.25, maxDeviation: 0.5, duration: 3.25 },
];
function withPlacement(automaticAdPlacement: unknown) {
	const plan = loadPlan("ai-scene-analysis-pertitle");
	return {
		...plan,
		aiSceneAnalysis: { ...plan.aiSceneAnalysis, automaticAdPlacement },
	};
}

describe("AISA scheduled cue points", () => {
	it.each([
		false,
		true,
	])("preserves schedule and optional boundaries (%s) across wizard, compiler and template", (combined) => {
		const placement = {
			schedule,
			...(combined
				? { allSceneBoundaries: { isEnabled: false, insertCueTags: true } }
				: {}),
		};
		const plan = encodingPlanSchema.parse(withPlacement(placement));
		const imported = tryImportPresetIntoWizard(plan);
		expect(imported.ok).toBe(true);
		if (!imported.ok) throw new Error("schedule plan should import");
		expect(imported.state.startOptions?.aiSceneAnalysis?.schedule).toEqual(
			schedule,
		);
		const rebuilt = buildPlan(imported.state);
		expect(rebuilt.aiSceneAnalysis).toEqual(plan.aiSceneAnalysis);
		const start = compilePlan(plan).find((op) => op.kind === "START_ENCODING");
		expect(start?.payload).toHaveProperty(
			"aiSceneAnalysis.features.automaticAdPlacement",
			placement,
		);
		expect(parse(planToEncodingTemplateYaml(plan))).toHaveProperty(
			"encodings.main.start.properties.aiSceneAnalysis.features.automaticAdPlacement",
			placement,
		);
	});
	it.each(
		[
			[],
			[{}],
			[{ position: 0 }],
			[{ maxDeviation: 0 }],
			[{ position: -1, maxDeviation: 0 }],
			[{ position: 0, maxDeviation: -1 }],
			[{ position: 0, maxDeviation: 0, duration: -1 }],
			[{ position: Number.NaN, maxDeviation: 0 }],
			[{ position: 0, maxDeviation: Infinity }],
			[{ position: 0, maxDeviation: 0, duration: Infinity }],
			[{ position: "0", maxDeviation: 0 }],
		].map((invalid) => [invalid]),
	)("rejects invalid schedule %j", (invalid) => {
		expect(
			encodingPlanSchema.safeParse(withPlacement({ schedule: invalid }))
				.success,
		).toBe(false);
	});
	it("preserves the existing all-scene-boundaries configuration", () => {
		const plan = loadPlan("ai-scene-analysis-pertitle");
		const imported = tryImportPresetIntoWizard(plan);
		if (!imported.ok) throw new Error("legacy AISA plan should import");
		expect(buildPlan(imported.state).aiSceneAnalysis).toEqual(
			plan.aiSceneAnalysis,
		);
	});
});
