import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(__dirname, "../../../..");

/**
 *  PR4 control 1 — the deletion surface stays CLOSED. The repo's
 * only destructive storage capability is `probeReaperForCredential`, and its
 * importer set is exactly: the worker probe runner (cleanup) and the
 * designation route (control 2's verify). A third importer is a design
 * conversation, not a convenience — this pin makes that conversation happen
 * in review instead of after an incident. Population = git ls-files (the
 * instrument's own B1 lesson: the working tree lies about what ships).
 */
describe("probe reaper importer set (control 1)", () => {
	it("exactly the two designed call sites import the deletion surface", () => {
		// review-pr34 m1: NO pathspec — a `-- apps` scope would bless an
		// importer added under packages/ or scripts/ (the repo's own
		// glob-pathspec lesson). The whole tree is the population; the
		// defining module and its barrel re-export are named exclusions, not
		// silent ones.
		const out = execFileSync(
			"git",
			["grep", "-l", "probeReaperForCredential"],
			{ cwd: REPO_ROOT, encoding: "utf8" },
		)
			.trim()
			.split("\n")
			.filter(
				(line) =>
					/\.(ts|tsx)$/.test(line) &&
					!line.includes(".test.") &&
					line !== "packages/storage/src/reaper.ts" &&
					line !== "packages/storage/src/index.ts",
			)
			.sort();
		expect(out).toEqual([
			"apps/web/src/app/api/settings/startup-probes/route.ts",
			"apps/worker/src/live/probe-runner.ts",
		]);
	});
});
