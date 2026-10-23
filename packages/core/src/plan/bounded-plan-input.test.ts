import { describe, expect, it } from "vitest";
import { encodingPlanSchema } from "./schema";

const languages =
	encodingPlanSchema.shape.aiSceneAnalysis.unwrap().shape.outputLanguageCodes;

describe("bounded plan input validation", () => {
	it("rejects too many scene-analysis languages before validating their elements", () => {
		const result = languages.safeParse(["", "", "", ""]);
		expect(result.success).toBe(false);
		if (result.success) throw new Error("Expected the size limit to reject.");
		expect(result.error.issues).toHaveLength(1);
		expect(result.error.issues[0]).toMatchObject({
			code: "too_big",
			path: [],
			maximum: 3,
			inclusive: true,
		});
	});

	it("accepts valid language codes within the size limit", () => {
		expect(languages.parse(["ja", "de", "fr"])).toEqual(["ja", "de", "fr"]);
	});

	it("still validates individual elements within the size limit", () => {
		const result = languages.safeParse(["ja", "", "fr"]);
		expect(result.success).toBe(false);
		if (result.success) throw new Error("Expected the invalid code to reject.");
		expect(result.error.issues).toContainEqual(
			expect.objectContaining({ code: "too_small", path: [1] }),
		);
	});
});
