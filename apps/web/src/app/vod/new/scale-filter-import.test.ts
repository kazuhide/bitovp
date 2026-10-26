import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSubmissionPlan, parseImportedPlan } from "./plan-import";

function rawPlan(parameters: Record<string, unknown>) {
	const plan = JSON.parse(
		readFileSync(
			join(
				__dirname,
				"../../../../../../packages/core/src/plan/__fixtures__/fixed-bitrate-hls-on-aws.plan.json",
			),
			"utf8",
		),
	);
	return {
		...plan,
		bitmovin: {
			...plan.bitmovin,
			accountId: "00000000-0000-4000-8000-00000000aaaa",
		},
		filters: [{ key: "scale", kind: "SCALE", ...parameters }],
	};
}

describe("Scale filter plan import", () => {
	it("preserves the imported Scale fields and explicit algorithm on submission", () => {
		const raw = rawPlan({
			width: 1280,
			scalingAlgorithm: "BICUBIC",
			sampleAspectRatioNumerator: 1,
			sampleAspectRatioDenominator: 1,
		});
		const result = parseImportedPlan(JSON.stringify(raw));
		if (!result.ok) throw new Error(result.errorKey);
		expect(result.imported.evaluation.ok).toBe(true);
		expect(buildSubmissionPlan(result.imported, "")).toEqual(raw);
	});
	it.each([
		{ scalingAlgorithm: "UNKNOWN" },
		{ sampleAspectRatioNumerator: 1 },
		{ sampleAspectRatioDenominator: 1 },
	])("blocks imported invalid Scale parameters %j", (parameters) => {
		const raw = rawPlan(parameters);
		const result = parseImportedPlan(JSON.stringify(raw));
		if (!result.ok) throw new Error(result.errorKey);
		expect(result.imported.evaluation.ok).toBe(false);
		expect(result.imported.raw.filters).toEqual(raw.filters);
	});
});
