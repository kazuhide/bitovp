import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/* Every credential picker provides a creation path so operators can complete setup without leaving the task. */
const WEB_SRC = join(__dirname, "..");

/** Tracked, non-test `.tsx` — the population is the COMMIT, not a worktree. */
function sourceFiles(): string[] {
	return execFileSync("git", ["ls-files", "--", "apps/web/src"], {
		cwd: join(WEB_SRC, "../../.."),
		encoding: "utf8",
	})
		.trim()
		.split("\n")
		.filter((f) => f.endsWith(".tsx") && !f.includes(".test."));
}

/**
 * Files that list credentials but must NOT carry the link, each with the
 * reason. Empty today; kept so an exemption has to be argued in code review
 * rather than added by deleting an assertion.
 */
const EXEMPT = new Map<string, string>([]);

/** The marker that says "this renders a credential chooser". */
const PICKS_CREDENTIAL = /t\("[a-zA-Z]+\.selectCredential"\)/;

describe("every credential picker offers a way to create one (ledger #141)", () => {
	const files = sourceFiles().map((rel) => ({
		rel,
		text: readFileSync(join(WEB_SRC, "../../..", rel), "utf8"),
	}));

	const pickers = files.filter((f) => PICKS_CREDENTIAL.test(f.text));

	it("found the pickers at all, so this cannot pass over an empty set", () => {
		// Below this and the walk is broken, not the app clean.
		expect(pickers.length).toBeGreaterThanOrEqual(7);
	});

	it("has no stale exemptions", () => {
		// An exemption for a file that no longer picks credentials hides the
		// next file that does.
		const found = new Set(pickers.map((p) => p.rel));
		for (const rel of EXEMPT.keys()) {
			expect(
				found,
				`${rel} is exempt but no longer picks a credential`,
			).toContain(rel);
		}
	});

	it("every picker renders NewCredentialLink, or is exempt with a reason", () => {
		const missing = pickers
			.filter((p) => !EXEMPT.has(p.rel))
			.filter((p) => !p.text.includes("NewCredentialLink"))
			.map((p) => p.rel);
		expect(
			missing,
			"these make an operator pick a credential with no way to create one — " +
				"add <NewCredentialLink />, or add the file to EXEMPT with a reason",
		).toEqual([]);
	});
});
