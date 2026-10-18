import { describe, expect, it } from "vitest";
import { parseImportedLivePlan } from "./live-plan-import";

/**
 * `parseImportedLivePlan` had no tests at all, so when its failure branches moved
 * from English prose to message keys — because a module helper has no translator —
 * only the VOD twin's change was asserted. These mirror `plan-import.test.ts`.
 *
 * Both branches are reachable by pasting into the live wizard's import box: the first
 * with malformed JSON, the second with a JSON array.
 */
describe("parseImportedLivePlan", () => {
	it("returns a key plus the parser's own detail for malformed JSON", () => {
		const result = parseImportedLivePlan("{ not json");
		expect(result.ok).toBe(false);
		if (result.ok) {
			return;
		}
		expect(result.errorKey).toBe("wizardX.importNotValidJson");
		// The detail is the JS parser's message — untranslated on purpose, and
		// spliced into the localized frame at the render site.
		expect(result.errorDetail).toBeTruthy();
	});

	it("rejects a non-object with a key and no detail", () => {
		const result = parseImportedLivePlan("[1, 2, 3]");
		expect(result.ok).toBe(false);
		if (result.ok) {
			return;
		}
		expect(result.errorKey).toBe("wizardX.importLiveMustBeObject");
		// `undefined`, not `null` — the render site distinguishes them, because
		// `translate` throws on an unfilled `{detail}`.
		expect(result.errorDetail).toBeUndefined();
	});

	it("accepts a valid-shaped object and reports its schema issues instead", () => {
		// `ok: true` with a failing evaluation is the "imported but incomplete" path,
		// not an import error — the wizard shows the plan and the schema complaint.
		const result = parseImportedLivePlan('{ "planVersion": 1 }');
		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		expect(result.imported.evaluation.ok).toBe(false);
	});
});
