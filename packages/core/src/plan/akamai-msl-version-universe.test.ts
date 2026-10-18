import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	AKAMAI_MSL_VERSION_BEHAVIOR,
	AKAMAI_MSL_VERSIONS,
} from "./akamai-msl-constraint";
import { akamaiMslVersionSchema } from "./schema";

/**
 * ONE MSL version universe —  (M7), re-homed 2026-08-27.
 *
 * WHY THIS FILE EXISTS AT ALL. This invariant used to live as the fifth `it`
 * inside `apps/web/src/__tests__/msl5-gate-wiring.test.ts`, which the
 * experimental-gate retirement deleted whole. Four of that file's five arms
 * were about the gate and died with it correctly. The fifth was not about the
 * gate — it pinned M7, the finding that the version enum and the behavior
 * Record had drifted into two hand-maintained lists, with the anchor watching
 * one while the schema decided reality with the other. Deleting a file is a
 * claim about every test in it, and I made that claim without reading the
 * fifth one. Review caught it, and it would have detonated in the very next
 * PR: PR 1 widens this enum, and this is the guard that says widening it in
 * one place widens it in both.
 *
 * WHY IT IS NOT THE SAME TEST. The original was a from-disk text pin —
 * `expect(schemaSource).toContain("z.enum(AKAMAI_MSL_VERSIONS)")`. That
 * matches the literal an author happens to write, so it passes over any
 * spelling it did not anticipate and fails over a harmless reformat. The
 * property it was reaching for is behavioural: **the set of versions the zod
 * schema accepts, and the set of versions the behavior Record answers for, are
 * both exactly `AKAMAI_MSL_VERSIONS`.** zod exposes `.options` and the Record
 * exposes its keys, so both can be asserted by set equality against the const
 * rather than by grepping for the line that ought to produce them.
 *
 * The concrete mutation this kills, which SURVIVED the tree after the deletion
 * (measured): inline `z.enum(["MSL4", "MSL5"])` at the schema while leaving
 * `AKAMAI_MSL_VERSIONS = ["MSL4"]`. That is the exact footgun the adoption
 * design warns about by name, it compiles, and every one of 2,677 core tests
 * passed with it in place.
 */
describe("the MSL version universe is one list, and both consumers derive from it", () => {
	/** Set equality, order-insensitive — the const's order is not the contract. */
	const sorted = (xs: readonly string[]) => [...xs].sort();

	it("the zod enum accepts exactly the const's members — no more, no fewer", () => {
		// `.options` is what the schema will actually accept at runtime, so an
		// inlined literal diverging from the const is caught here rather than
		// by matching the source line that was supposed to produce it.
		expect(sorted(akamaiMslVersionSchema.options)).toEqual(
			sorted(AKAMAI_MSL_VERSIONS),
		);
	});

	it("every const member really parses, and a non-member really does not", () => {
		// The `.options` check above compares two lists; this one exercises the
		// schema, so a future schema that carries the right options but refuses
		// them (a `.refine`, a superRefine, a brand) cannot pass on shape alone.
		for (const version of AKAMAI_MSL_VERSIONS) {
			expect(akamaiMslVersionSchema.parse(version)).toBe(version);
		}
		// Deliberately a value no MSL version will ever be, rather than "MSL5":
		// naming the next real member would make this arm start FAILING on the
		// PR that legitimately adds it, which trains the next author to weaken
		// the guard instead of reading it.
		expect(() => akamaiMslVersionSchema.parse("MSL_NOT_A_VERSION")).toThrow();
	});

	it("the behavior Record answers for exactly the const's members", () => {
		// The `satisfies Record<AkamaiMslVersion, …>` in the constraint module
		// makes a MISSING key a tsc error. It cannot make an EXTRA key one —
		// a Record may be widened by an object literal carrying more than the
		// key type demands only in some positions, and more to the point, tsc
		// says nothing at all to a reader running the test suite. This closes
		// the direction the type cannot and states the same fact at runtime.
		expect(sorted(Object.keys(AKAMAI_MSL_VERSION_BEHAVIOR))).toEqual(
			sorted(AKAMAI_MSL_VERSIONS),
		);
	});

	/**
	 * The anchor's VALUES, not just its keys — closing what review measured as
	 * unpinned (M-B): flipping MSL4's entry to `"REQUIRED"` left tsc at 0 and
	 * 2,677 tests green, because nothing outside the defining file reads this
	 * Record yet. Until PR 1 wires the rails to it, the keys are pinned by the
	 * type and the values are prose with syntax.
	 *
	 * `"FORBIDDEN"` is not a preference. `AkamaiMslOutput.publishingAuthentication`
	 * in `@bitmovin/api-sdk@1.278.0` documents itself as *"MSL5 only… Sending
	 * this field with `mslVersion: MSL4` is rejected"* — so the MSL4 value is a
	 * vendor fact, and a plausible-looking `"OPTIONAL"` or `"REQUIRED"` here
	 * would send the executor to build a request the API answers with a 400.
	 */
	it("MSL4 FORBIDS publishing auth — the SDK says sending it is rejected, not ignored", () => {
		expect(AKAMAI_MSL_VERSION_BEHAVIOR.MSL4.publishingAuth).toBe("FORBIDDEN");
	});

	/**
	 * EVERY PROPERTY IS READ BY SOMETHING, OR SAYS WHY NOT — review, and it is
	 * the shape this file exists to fight, recurring one level down.
	 *
	 * The anchor forces the CLASSIFICATION to exist: widen the enum and tsc
	 * demands somebody state whether MSL5's auth is forbidden, optional or
	 * required. Nothing forces a RAIL TO READ IT. A rail that lands writing
	 * `if (mslVersion === "MSL5")` instead of consulting the Record leaves every
	 * test green — the key-set arms above pin the enum↔const↔Record universes
	 * and MSL4's value, and none of them notices a restatement. Ask it the other
	 * way, which is the question that keeps catching things here: *if I revert a
	 * rail's call site to a restatement, what goes red?*
	 *
	 * This file has the receipts twice already. `forbiddenManifests` was
	 * "declared 3× and read 0× for one commit"; `AKAMAI_MSL_VERSION_BEHAVIOR`
	 * itself "had ZERO consumers outside its defining file". Both were caught
	 * late. So the debt is now enumerated FROM the Record rather than tracked in
	 * prose: a new property with no consumer and no registration is red on the
	 * commit that adds it, not on the commit that discovers it.
	 *
	 * PENDING is a licence with an owner, not a permanent exemption. It must
	 * name the PR that consumes the property, and the arm below fails if a
	 * registered property turns out to HAVE a consumer — a stale licence is the
	 * same class as a stale exemption, and it reads as debt that is still open
	 * when it is not.
	 */
	const CONSUMER_PENDING: Record<string, string> = {
		// `publishingAuth` WAS registered here, for rail 3b. The licence
		// expired on its own terms: 3b landed, the guard's direction 2 fired —
		// "registered as PENDING but something now reads it" — and the
		// registration came out. That is the whole point of making a licence
		// bidirectional, and it happened in a real workflow rather than in a
		// mutation. Its derivation is now pinned by an arm in
		// `msl-version-rails.test.ts`, as the failure message asked.
		// Rail 4 now reads minEncoderVersion in msl-encoder-version.ts.
	};

	/**
	 * THE POPULATION IS DERIVED, and the first cut named a path instead —
	 * review, and it is the same class as the finding this guard implements.
	 *
	 * v1 read ONE hard-coded file: `akamai-msl-constraint.ts`, which is the
	 * file the barrel export exists to let consumers LEAVE. `index.ts` says so
	 * in as many words: the export is there because "a rail landing in `apps/`
	 * would have been physically unable to import it, so it would have restated
	 * it instead." And rail 3b — the one property `publishingAuth`'s licence is
	 * held open for — needs `credentialHasPublishingAuth` plumbed from
	 * `apps/web/src/lib/server/plan-validation.ts`. So the one rail this
	 * registry exists to track was the one most likely to land outside the
	 * population that tracks it.
	 *
	 * WORSE, IT FAILED SILENT IN THE DANGEROUS DIRECTION. Rail 3b landing in
	 * `apps/` and reading the Record correctly would leave `consumed` false, the
	 * registration would still be present, direction 2 would expect false, and
	 * the guard would PASS — the licence surviving its own expiry, the registry
	 * saying PENDING about finished work, and the whole thing back to
	 * prose-tracking. The other direction is loud. The asymmetry ran backwards
	 * for a registry whose value is direction 2.
	 *
	 * So: files that IMPORT the Record, minus tests. "Which files import this"
	 * is a real query with a real answer; "which file did I expect to import it"
	 * is a guess that ages.
	 *
	 * THE TEST EXCLUSION IS LOAD-BEARING, not tidiness, and removing it as noise
	 * would fail the guard OPEN IN BOTH DIRECTIONS. Under v1's strict
	 * `behavior.` matcher this file did not self-match, because it accesses
	 * `AKAMAI_MSL_VERSION_BEHAVIOR.MSL4.publishingAuth`. The loosened matcher
	 * below deliberately matches any receiver — which means it also matches this
	 * file's own MSL4 assertion (`AKAMAI_MSL_VERSION_BEHAVIOR.MSL4.publishingAuth`
	 * carries the dot the matcher needs), and `msl-version-rails.test.ts` is an
	 * importer too. The two changes are individually safe and jointly hazardous.
	 *
	 * MEASURED, because the review's prediction and mine were both half right.
	 * Removing the filter does NOT fail silently in both directions: direction 2
	 * fires loudly, because a REGISTERED property now reads as consumed —
	 *
	 *   × publishingAuth is registered as PENDING (…) but something now reads it
	 *
	 * — which is the good half of having a bidirectional licence. What WOULD
	 * fail open is direction 1: an unregistered property mentioned anywhere in
	 * any test would read as production-consumed and the guard would say
	 * nothing. So the filter is load-bearing for direction 1 and merely noisy
	 * for direction 2, and it stays for the direction that is silent.
	 */
	const importerSources = (): string[] => {
		// THE REPO ROOT, not this package. The first cut walked
		// `packages/core` and my own mutation caught it: planting a
		// `publishingAuth` read in `apps/web/src/lib/server/plan-validation.ts`
		// — the exact file rail 3b's plumbing lands in — SURVIVED, because the
		// walk never reached `apps/`. A "derived" population scoped to the
		// package the Record lives in is the hard-coded path again, one
		// directory wider.
		const roots = [
			join(__dirname, "..", "..", "..", "..", "packages"),
			join(__dirname, "..", "..", "..", "..", "apps"),
		];
		const seen = new Set<string>();
		const walk = (dir: string): void => {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				if (
					entry.name === "node_modules" ||
					entry.name === "generated" ||
					entry.name === "dist" ||
					entry.name.startsWith(".")
				) {
					// Build output is not production source — and the db package's
					// `prisma generate` rewrites `packages/db/generated/client/*` in the
					// same turbo run as this walk, so reading it raced ENOENT on a
					// branch gate (2026-08-29, #354).
					continue;
				}
				const full = join(dir, entry.name);
				if (entry.isDirectory()) {
					walk(full);
				} else if (
					/\.tsx?$/.test(entry.name) &&
					!/\.test\.tsx?$/.test(entry.name)
				) {
					seen.add(full);
				}
			}
		};
		for (const root of roots) {
			try {
				walk(root);
			} catch {
				// A root that does not exist is not a finding.
			}
		}
		return [...seen]
			.flatMap((f) => {
				try {
					return [readFileSync(f, "utf8")];
				} catch {
					// A file that vanished between readdir and read (a concurrent
					// regenerate) is not a finding either.
					return [];
				}
			})
			.filter((src) => src.includes("AKAMAI_MSL_VERSION_BEHAVIOR"));
	};

	it("every anchor property is read in production, or registered as pending with its PR", () => {
		const sources = importerSources();
		expect(
			sources.length,
			"nothing imports the Record — the derivation broke, or the barrel export was removed",
		).toBeGreaterThan(1);
		// Any receiver, not a fixed local name: `const { publishingAuth } =
		// behavior` and `AKAMAI_MSL_VERSION_BEHAVIOR[v].publishingAuth` read the
		// property just as correctly as the `behavior.` the two current rails
		// happen to use, and that is a convention rather than a contract.
		const consumed = (prop: string) =>
			sources.some((src) =>
				new RegExp(`\\.\\s*${prop}\\b`).test(
					// The DECLARATION names every property, so the file that
					// declares them must not count as its own consumer.
					src.replace(
						/AKAMAI_MSL_VERSION_BEHAVIOR = \{[\s\S]*?\n\} as const[\s\S]*?>;/,
						"",
					),
				),
			);

		// Derived FROM the Record — a property added tomorrow is in this loop
		// without anyone remembering to add it, which is the whole point.
		const props = Object.keys(AKAMAI_MSL_VERSION_BEHAVIOR.MSL4);
		expect(props.length, "the Record lost its properties").toBeGreaterThan(0);

		for (const prop of props) {
			const pending = CONSUMER_PENDING[prop];
			if (pending === undefined) {
				expect(
					consumed(prop),
					`${prop} is read by nothing. Either wire a rail to it, or add it to CONSUMER_PENDING naming the PR that will — an unread classification is a label that reads like a guard.`,
				).toBe(true);
			} else {
				expect(
					consumed(prop),
					`${prop} is registered as PENDING ("${pending}") but something now reads it — delete the registration, and pin the rail's derivation with a mutation arm instead.`,
				).toBe(false);
			}
		}
	});

	it("no pending registration names a property the Record no longer has", () => {
		const props = new Set(Object.keys(AKAMAI_MSL_VERSION_BEHAVIOR.MSL4));
		for (const [prop, why] of Object.entries(CONSUMER_PENDING)) {
			expect(
				props.has(prop),
				`CONSUMER_PENDING licenses "${prop}" (${why}) which is not a property of the Record`,
			).toBe(true);
		}
	});
});
