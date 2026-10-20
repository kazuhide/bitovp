import { compilePlan, encodingPlanSchema } from "@bitovp/core";
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

it("keeps three requested translations in the plan and START payload without adding default English", () => {
	const plan = buildPlan({
		...DEFAULT_WIZARD_STATE,
		name: "Additional analysis languages",
		inputFiles: [
			{
				key: "main",
				inputKey: "main",
				kind: "S3",
				credentialId: "00000000-0000-4000-8000-000000000001",
				bucket: "input-bucket",
				path: "clip.mp4",
			},
		],
		output: {
			...DEFAULT_WIZARD_STATE.output,
			credentialId: "00000000-0000-4000-8000-000000000002",
			bucket: "output-bucket",
		},
		startOptions: {
			aiSceneAnalysis: {
				filename: "analysis.json",
				path: "ai/",
				outputLanguageCodes: ["ja", "de", "fr"],
			},
		},
	});
	expect(plan.aiSceneAnalysis?.outputLanguageCodes).toEqual(["ja", "de", "fr"]);
	expect(
		compilePlan(encodingPlanSchema.parse(plan)).find(
			(operation) => operation.kind === "START_ENCODING",
		)?.payload,
	).toMatchObject({
		aiSceneAnalysis: {
			features: {
				outputLanguageCodes: { outputLanguageCodes: ["ja", "de", "fr"] },
			},
		},
	});
});
