import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO = join(__dirname, "../../../..");
const REGISTER = "docs/BITMOVIN-API-COVERAGE.md";

function maxConstraint(): number {
	const text = readFileSync(join(REPO, REGISTER), "utf8");
	const ids = [...text.matchAll(/^\| C(\d+) \|/gm)].map((m) => Number(m[1]));

	expect(ids.length).toBeGreaterThan(20);
	return Math.max(...ids);
}

const SUBSET_PHRASES = new Map<string, string>([
	[
		"C1–C11",
		"the cross-field validator codes specifically — validate.ts and the presets route both mean this subset, not the whole register",
	],
]);

type Hit = { file: string; line: number; phrase: string; text: string };

function rangeHits(): Hit[] {
	const files = execFileSync("git", ["ls-files"], {
		cwd: REPO,
		encoding: "utf8",
	})
		.trim()
		.split("\n")
		.filter((f) => /\.(ts|tsx|md)$/.test(f))
		.filter((f) => !f.endsWith("constraint-range.test.ts"));
	const hits: Hit[] = [];
	for (const file of files) {
		readFileSync(join(REPO, file), "utf8")
			.split("\n")
			.forEach((text, i) => {
				for (const m of text.matchAll(/C1[–-]C(\d+)/g)) {
					hits.push({
						file,
						line: i + 1,
						phrase: m[0] ?? "",
						text: text.trim(),
					});
				}
			});
	}
	return hits;
}

function isSubset(hit: Hit): boolean {
	for (const phrase of SUBSET_PHRASES.keys()) {
		if (hit.text.includes(phrase)) return true;
	}
	return false;
}

describe("the constraint range matches the technical limits", () => {
	const max = maxConstraint();
	const hits = rangeHits();

	it("keeps the constraint register contiguous and compact", () => {
		const source = readFileSync(join(REPO, REGISTER), "utf8");
		const rows = [...source.matchAll(/^\| C(\d+) \|.*$/gm)];
		const ids = rows.map((match) => Number(match[1])).sort((a, b) => a - b);

		expect(ids).toEqual(Array.from({ length: max }, (_, index) => index + 1));
		expect(Buffer.byteLength(source, "utf8")).toBeLessThanOrEqual(20_000);
		for (const row of rows) {
			expect(
				(row[0] ?? "").length,
				`constraint C${row[1]} became a history journal; keep the rule current and move investigation history to Git`,
			).toBeLessThanOrEqual(600);
		}
	});

	it("found range phrases at all, so this cannot pass over an empty set", () => {
		expect(hits.length).toBeGreaterThan(0);
	});

	it("every full-span claim matches the register's max", () => {
		const stale = hits
			.filter((h) => !isSubset(h))

			.filter((h) => h.phrase.replace("-", "–") !== `C1–C${max}`)
			.map(
				(h) => `${h.file}:${h.line} says ${h.phrase}, register is at C${max}`,
			);
		expect(
			stale,
			`update these to C1–C${max}, or add the phrase to SUBSET_PHRASES with a reason`,
		).toEqual([]);
	});

	it("has no stale subset exemptions", () => {
		for (const [phrase] of SUBSET_PHRASES) {
			expect(
				hits.some((h) => h.text.includes(phrase)),
				`no line contains "${phrase}" any more — drop the exemption`,
			).toBe(true);
		}
	});
});
