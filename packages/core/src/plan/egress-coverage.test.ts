import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Rails 1 and 2 (https-only, no URL userinfo) are SCHEMA-level, so any future
 * vendor field gets them free by adopting `secretEgressUrlSchema`. Rail 3 (the
 * host allowlist) is not inherited: it needs a manual edit to two hand-written
 * enumerations, `secretEgressSites` in plan/validate.ts and live/validate.ts.
 *
 * That gap is exactly what C22 claims does not exist ("any future vendor
 * integration inherits the rail by using this schema" — two-thirds true), and
 * it is the axis that will actually move next: the next integration adds a
 * field, not a route. So couple them here — a field that adopts the schema
 * without being enumerated fails this test rather than shipping with the weakest
 * of the three rails silently missing.
 *
 * Review catch. Deliberately text-based: parsing zod at runtime to discover
 * which leaves use which schema would be a bigger machine than the thing it
 * guards, and the count is the property that matters.
 */
const SRC = join(import.meta.dirname, "..");

function read(relative: string): string {
	return readFileSync(join(SRC, relative), "utf8");
}

/** Field declarations like `serverUrl: secretEgressUrlSchema`. */
function schemaAdopters(source: string): string[] {
	return [...source.matchAll(/(\w+)\s*:\s*secretEgressUrlSchema\b/g)].map(
		(match) => match[1] as string,
	);
}

/** Leaf names from the enumerated `field: "a.b.leaf"` entries. */
function enumeratedLeaves(source: string): string[] {
	const fn = source.slice(source.indexOf("function secretEgressSites"));
	const body = fn.slice(0, fn.indexOf("\n}"));
	return [...body.matchAll(/field:\s*"([^"]+)"/g)].map(
		(match) => (match[1] as string).split(".").pop() as string,
	);
}

describe("every secret-egress field is enumerated for the host allowlist", () => {
	const cases = [
		{
			name: "VOD plan",
			schema: "plan/schema.ts",
			validator: "plan/validate.ts",
		},
		{
			name: "live channel",
			schema: "live/schema.ts",
			validator: "live/validate.ts",
		},
	];

	for (const { name, schema, validator } of cases) {
		it(`${name}: schema adopters === enumerated sites`, () => {
			const adopters = schemaAdopters(read(schema)).sort();
			const enumerated = enumeratedLeaves(read(validator)).sort();
			expect(
				enumerated,
				`${schema} declares [${adopters.join(", ")}] with secretEgressUrlSchema; ` +
					`${validator}'s secretEgressSites() enumerates [${enumerated.join(", ")}]. ` +
					"Add the missing field to secretEgressSites() — rails 1+2 come from the " +
					"schema, but rail 3 (the host allowlist) does not.",
			).toEqual(adopters);
		});
	}

	it("finds adopters at all (guards against a broken regex)", () => {
		// Without this, a regex that matches nothing makes both sides [] and the
		// suite passes vacuously.
		const total = cases.flatMap(({ schema }) => schemaAdopters(read(schema)));
		expect(total.length).toBeGreaterThanOrEqual(2);
		expect(total).toContain("serverUrl");
		expect(total).toContain("poisEndpoint");
	});

	/**
	 * Adopters whose rail-3 (host allowlist) enforcement lives OUTSIDE a plan
	 * validator — each entry names where the check actually runs, because
	 * "known" without a pointer is how an obligation goes stale ('s
	 * lesson). The NOTIFICATION_WEBHOOK secret URL is not a plan field: no
	 * plan validator ever sees it, and the allowlist is re-checked in the
	 * delivery worker before EVERY post (apps/worker/src/notify/processor.ts,
	 * REFUSED_HOST — pinned by its own tests; an EMPTY allowlist there
	 * warns-and-delivers, executor.ts's convention, NOT a block — the first
	 * version of this comment inverted that, review-183 I1).
	 */
	const WORKER_ENFORCED = new Set(["credentials/schemas.ts"]);

	it("no OTHER file adopts the schema unchecked", () => {
		// The `cases` list above is hand-written, so a THIRD schema file adopting
		// `secretEgressUrlSchema` — a new DRM or vendor domain — would be checked
		// by nothing, on the same "new field, not new route" axis this test exists
		// for (review catch).
		const known = new Set([
			...cases.map(({ schema }) => schema),
			...WORKER_ENFORCED,
		]);
		const adopters: string[] = [];
		const walk = (dir: string) => {
			for (const entry of readdirSync(join(SRC, dir), {
				withFileTypes: true,
			})) {
				const rel = `${dir}/${entry.name}`.replace(/^\.\//, "");
				if (entry.isDirectory()) {
					walk(rel);
					continue;
				}
				if (!/\.ts$/.test(entry.name) || /\.test\.ts$/.test(entry.name)) {
					continue;
				}
				// egress.ts declares the schema's consumers' rail; plan/schema.ts
				// declares the schema itself.
				if (rel.endsWith("plan/egress.ts")) {
					continue;
				}
				// The barrel re-export ( made the schema public API for
				// the notify worker's send-time re-parse). A barrel declares no
				// FIELD, so there is nothing to enumerate; adopting schemas that
				// IMPORT via the barrel still match below in their own files.
				if (rel === "index.ts") {
					continue;
				}
				/**
				 * CODE, not prose. The first version grepped the raw file, so a doc
				 * comment that merely *cited* `secretEgressUrlSchema` — as
				 * `credentials/public-base-urls.ts` now does, to explain why it
				 * refuses URL userinfo for the same reason — was reported as an
				 * unchecked adopter. Stripping comments first keeps the tripwire
				 * about adoption while letting the codebase cross-reference the rule
				 * it is following. Weakening it further (e.g. only matching imports)
				 * would let a re-export slip through, so comments are the only thing
				 * removed.
				 */
				const code = read(rel)
					.replace(/\/\*[\s\S]*?\*\//g, "")
					.replace(/\/\/[^\n]*/g, "");
				if (/\bsecretEgressUrlSchema\b/.test(code) && !known.has(rel)) {
					adopters.push(rel);
				}
			}
		};
		walk(".");
		expect(
			adopters,
			"these reference secretEgressUrlSchema but are not in this test's " +
				"`cases` list, so their fields get rails 1+2 and NOT the host " +
				"allowlist. Add the file pair here and enumerate the field in that " +
				"validator's secretEgressSites().",
		).toEqual([]);
	});

	it("finds the enumerations at all", () => {
		const total = cases.flatMap(({ validator }) =>
			enumeratedLeaves(read(validator)),
		);
		expect(total.length).toBeGreaterThanOrEqual(2);
	});
});
