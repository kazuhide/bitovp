import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * No test may re-stub `ApiError` in a `vi.mock("@/lib/api")` factory.
 *
 * : 38 test files carried
 * `vi.mock("@/lib/api",  => ({ ApiError: class extends Error {} }))` — a
 * stub with no `status` and no `details`, which means those files could not
 * express a CLASSIFIED failure at all. That shipped one real defect: the
 * storage picker's 403 hint was wrong while its test stayed green, because
 * the test could not build the very error the code branches on (#144).
 *
 * The fix is the importOriginal spread —
 * `vi.mock("@/lib/api", async (orig) => ({ ...(await orig), apiFetch }))`
 * — which keeps the REAL ApiError (and every other export) and overrides only
 * the fetch. All 38 were migrated on 2026-08-21; this file is the reason the
 * count stays zero. Three of the 38 were written THIS WEEK by the same author
 * who closed the ledger row, which is what an unguarded convention does.
 *
 * The population floor exists because the offender check alone is satisfied
 * by a broken glob: if `testFiles` returned nothing, zero offenders would
 * be a vacuous green.
 */

const WEB_ROOT = resolve(__dirname, "../..");

function testFiles(): string[] {
	return execFileSync(
		"git",
		["ls-files", "--", "src/**/*.test.ts", "src/**/*.test.tsx"],
		{ cwd: WEB_ROOT, encoding: "utf8" },
	)
		.split("\n")
		.filter(Boolean);
}

describe("ApiError is never re-stubbed (ledger #146)", () => {
	it("finds the population it polices", () => {
		const files = testFiles();
		const mockingApi = files.filter((f) =>
			readFileSync(join(WEB_ROOT, f), "utf8").includes('vi.mock("@/lib/api"'),
		);
		expect(files.length).toBeGreaterThan(200);
		expect(
			mockingApi.length,
			"almost no test mocks @/lib/api any more? the glob or the marker broke",
		).toBeGreaterThan(30);
	});

	it("no vi.mock factory redefines ApiError", () => {
		const offenders = testFiles()
			/*
			 * Self-exclusion, same reasoning as ledger-references.test.ts: this
			 * file QUOTES the banned pattern in its docblock, and matched itself
			 * the moment `git add` put it in the tracked population — the run
			 * before staging was green only because an untracked file is outside
			 * `git ls-files`.
			 */
			.filter((f) => !f.endsWith("api-error-mocks.test.ts"))
			.filter((f) =>
				/\bApiError:\s*class\b/.test(readFileSync(join(WEB_ROOT, f), "utf8")),
			);
		expect(
			offenders,
			'a stubbed ApiError cannot carry {status, details}, so that file cannot express a classified failure — use vi.mock("@/lib/api", async (orig) => ({ ...(await orig()), apiFetch }))',
		).toEqual([]);
	});
});
