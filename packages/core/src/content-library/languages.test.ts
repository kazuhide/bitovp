import { describe, expect, it } from "vitest";
import { sceneAnalysisLocales } from "./languages";

describe("AI Scene Analysis output locales", () => {
	it.each([
		{ additional: undefined, expected: ["en"] },
		{ additional: [], expected: ["en"] },
		{ additional: ["ja"], expected: ["ja", "en"] },
		{ additional: ["en", "ja", "en"], expected: ["en", "ja"] },
		{ additional: ["en-US", "ja"], expected: ["en-US", "ja", "en"] },
	])("includes default English without replacing requested locales: $additional", ({
		additional,
		expected,
	}) => {
		expect(sceneAnalysisLocales(additional)).toEqual(expected);
	});
	it("keeps all three additional request slots and does not mutate the API language list", () => {
		const additional = Object.freeze(["ja", "de", "fr"]);
		expect(sceneAnalysisLocales(additional)).toEqual(["ja", "de", "fr", "en"]);
		expect(additional).toEqual(["ja", "de", "fr"]);
	});
});
