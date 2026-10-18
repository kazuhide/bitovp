import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * No source file may contain a raw NUL byte.
 *
 * A NUL makes a file BINARY to the whole toolchain: `grep` returns nothing and exits 1,
 * `file` reports `data`, `rg` says "binary file matches" instead of the line. So every
 * grep-based audit silently skips it — in a repo whose memory index carries "an
 * instrument must count the whole population", that is the population quietly shrinking.
 *
 * Found three times, each by a different route and each a `\x00` written raw as a join
 * separator: `verify/engine.ts` (I hit it live — two greps for functions that plainly
 * exist returned nothing), `verify/adapters.ts` (a reviewer found it, after engine.ts was
 * cleaned and its sibling was not), and `vmaf/processor.ts` — which nobody was looking
 * for and which this tree-wide scan turned up. That third one is the argument for the
 * test: two of them were found by whoever happened to trip over them.
 *
 * `\0` in the escape form is identical at runtime and visible to every tool.
 */

const REPO_ROOT = join(__dirname, "../../../..");
const SKIP = new Set([
	// Agent worktrees are copies of the tree at some past commit, not sources — the first
	// run of this test reported 7 hits, all of them one stale `vmaf/processor.ts` copied
	// seven times. Scanning them would make the test fail on history nobody can fix.
	".claude",
	"node_modules",
	".git",
	".next",
	".turbo",
	"dist",
	"coverage",
	"generated",
	"verify-runs",
]);
const EXTENSIONS = [
	".ts",
	".tsx",
	".js",
	".mjs",
	".json",
	".md",
	".yaml",
	".yml",
];

function walk(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		if (SKIP.has(entry)) {
			continue;
		}
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			walk(full, out);
		} else if (EXTENSIONS.some((e) => entry.endsWith(e))) {
			out.push(full);
		}
	}
	return out;
}

describe("source files are text, not data", () => {
	const files = walk(REPO_ROOT);

	it("scans a real population, so a broken walk cannot report clean", () => {
		expect(files.length).toBeGreaterThan(500);
	});

	it("contains no raw NUL byte anywhere", () => {
		const binary = files
			.filter((f) => readFileSync(f).includes(0))
			.map((f) => relative(REPO_ROOT, f));
		expect(
			binary,
			'write "\\0" instead of a raw NUL — a raw one makes the file invisible to grep',
		).toEqual([]);
	});
});
