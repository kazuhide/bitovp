import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { buildPlan } from "../wizard/build-plan";
import { tryImportPresetIntoWizard } from "../wizard/plan-to-wizard";
import { compilePlan } from "./compiler";
import { curlForStep } from "./curl-from-step";
import { encodingPlanSchema } from "./schema";
import { planToEncodingTemplateYaml } from "./template";
import { loadPlan } from "./test-support";

function withAdvisories(regulatoryAdvisories: unknown) {
	const plan = loadPlan("ai-scene-analysis-pertitle");
	return {
		...plan,
		aiSceneAnalysis: { ...plan.aiSceneAnalysis, regulatoryAdvisories },
	};
}

describe("AI regulatory advisories", () => {
	it("retains selected topics through form import, compilation, template and cURL", () => {
		const advisories = { topics: ["TOBACCO"] };
		const plan = encodingPlanSchema.parse(withAdvisories(advisories));
		const imported = tryImportPresetIntoWizard(plan);
		expect(imported.ok).toBe(true);
		if (!imported.ok) throw new Error("Advisory plan should import");
		expect(buildPlan(imported.state).aiSceneAnalysis).toEqual(
			plan.aiSceneAnalysis,
		);
		const start = compilePlan(plan).find((op) => op.kind === "START_ENCODING");
		if (!start) throw new Error("Missing start operation");
		expect(start.payload).toHaveProperty(
			"aiSceneAnalysis.features.regulatoryAdvisories",
			advisories,
		);
		expect(parse(planToEncodingTemplateYaml(plan))).toHaveProperty(
			"encodings.main.start.properties.aiSceneAnalysis.features.regulatoryAdvisories",
			advisories,
		);
		const curl = curlForStep({
			...start,
			status: "DONE",
			request: {
				...start.payload,
				refs: { encodingId: "enc", aiAssetDescriptionOutputId: "out" },
			},
		});
		if (!curl.ok) throw new Error("Missing start cURL");
		expect(curl.command).toContain('"regulatoryAdvisories"');
		expect(curl.command).toContain('"TOBACCO"');
	});

	it.each([
		{},
		{ topics: [] },
		{ topics: ["UNKNOWN"] },
		{ topics: ["TOBACCO", "TOBACCO"] },
		{ topics: "TOBACCO" },
	])("rejects invalid topic selection %j", (invalid) =>
		expect(encodingPlanSchema.safeParse(withAdvisories(invalid)).success).toBe(
			false,
		));

	it("requires the asset description when advisories are requested", () => {
		const plan = withAdvisories({ topics: ["TOBACCO"] });
		expect(
			encodingPlanSchema.safeParse({
				...plan,
				aiSceneAnalysis: { regulatoryAdvisories: { topics: ["TOBACCO"] } },
			}).success,
		).toBe(false);
	});

	it("keeps advisories absent from existing AI jobs", () => {
		const plan = loadPlan("ai-scene-analysis-pertitle");
		const start = compilePlan(plan).find((op) => op.kind === "START_ENCODING");
		expect(start?.payload).not.toHaveProperty(
			"aiSceneAnalysis.features.regulatoryAdvisories",
		);
	});
});
