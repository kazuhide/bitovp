import { describe, expect, it } from "vitest";
import { buildPlan, DEFAULT_WIZARD_STATE } from "./build-plan";

describe("AISA filename default", () => {
	it.each([
		"",
		"   ",
		"analysis.json",
		"custom.json",
	])("builds a usable asset filename from %j", (filename) => {
		const plan = buildPlan({
			...DEFAULT_WIZARD_STATE,
			startOptions: { aiSceneAnalysis: { filename, path: "ai/" } },
		});
		expect(plan.aiSceneAnalysis?.assetDescription.filename).toBe(
			filename.trim() || "analysis.json",
		);
	});
});
