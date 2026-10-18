import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	compileExpectedArtefacts,
	planInputSchema,
	planOutputSchema,
} from "@bitovp/core";
import { describe, expect, it } from "vitest";
import {
	bucketFromLabel,
	capabilitiesFor,
	capabilityOfIoKind,
	loadScenarios,
	sourcesOf,
} from "./preflight";

/**
 * Preflight is the only thing standing between this harness and a false claim of
 * coverage, and it shipped with no tests at all (review catch). Its whole promise —
 * §3 of the design — is that every scenario is either machine-verified or a SKIP
 * naming the specific resource that would open it. There is no third state, and the
 * failure mode is not a crash: it is a scenario counted runnable that cannot run,
 * which then fails opaquely mid-run and is read as a product defect.
 *
 * That happened three times, all found by review, all pinned below.
 */

const scenarios = loadScenarios();

describe("loadScenarios", () => {
	it("every corpus fixture has a UC number (owner item 3 — the map may not go stale)", () => {
		// review-292 N4: two of the three Akamai fixtures shipped as uc00-
		// (unmapped) — the exact mixed-up console naming the numbering exists
		// to fix. This pins map coverage to the fixture population, so the
		// next fixture cannot land unmapped.
		const map = JSON.parse(
			readFileSync(
				join(import.meta.dirname, "data/fixture-to-uc.json"),
				"utf8",
			),
		) as Record<string, number>;
		const names = loadScenarios()
			.map((s) => s.name)
			.sort();
		const unmapped = names.filter((name) => map[name] === undefined);
		expect(unmapped).toEqual([]);
		// Symmetric (review-293 S4): a typo'd KEY would otherwise linger
		// forever — the map must be exactly the scenario population.
		expect(Object.keys(map).sort()).toEqual(names);
	});

	it("reads the whole corpus, so nothing here passes over an empty population", () => {
		// 9→10 / 77→78 : live-pinned-encoder joins —
		// gated behind PINNED_ENCODER_VERSION until Track 1 supplies the tag.
		// 83→84 : live-akamai-msl5, mapped to UC 19 alongside
		// the other three MSL fixtures — the same use case, a different protocol
		// version.
		// 84→85 / 70→71 on 2026-08-28: `vp9-webm-fixed-dash`.
		// 85→86 / 71→72 same day: `mixed-codec-dash-hls` .
		// 86→87 / 14→15 live on 2026-08-29: `live-mixed-codec-dash` (paid
		// the live half of the mixed-codec DASH rule).
		expect(scenarios.length).toBe(87);
		expect(scenarios.filter((s) => s.kind === "VOD").length).toBe(72);
		expect(scenarios.filter((s) => s.kind === "LIVE").length).toBe(15);
	});

	it("parses every live fixture instead of pattern-matching its filename", () => {
		// The first version derived live needs from /zixi/i and /esam/i on the NAME — the
		// practice `capabilitiesFor`'s own doc comment disavows — which meant "0 invalid"
		// covered only the 66 VOD plans and a malformed live fixture reported valid.
		const live = scenarios.filter((s) => s.kind === "LIVE");
		for (const s of live) {
			expect(s.invalid, `${s.name} must parse`).toBeUndefined();
		}
		const zixi = live.find((s) => s.name === "live-zixi");
		expect(zixi?.needs, "zixi read from liveInput.kind").toContain("ZIXI");
		const esam = live.find((s) => s.name === "live-esam-full");
		expect(esam?.needs, "POIS read from start.esam").toContain("POIS");
		// And the ones that need neither must claim neither, or the classifier is just
		// adding capabilities to everything.
		const simple = live.find((s) => s.name === "live-rtmp-simple");
		expect(simple?.needs).not.toContain("ZIXI");
		expect(simple?.needs).not.toContain("POIS");
	});

	it("reports no invalid plan anywhere in the corpus", () => {
		expect(scenarios.filter((s) => s.invalid !== undefined)).toEqual([]);
	});

	it("refuses to measure an empty corpus", () => {
		// The path resolution used to swallow an ENOENT and `continue`, which reported
		// `total 0 … 0 invalid` — a reassuring number over nothing, the exact failure
		// shape this project keeps rediscovering. It now throws instead, and the exact
		// count above is what would notice a silent shrink.
		expect(scenarios.length).toBeGreaterThan(70);
	});
});

describe("every plan IO kind is classified, none by omission (ledger #137)", () => {
	/**
	 * The population, derived from the SCHEMA rather than typed out here — a
	 * hand list would go stale the moment an output kind is added, which is
	 * precisely the event this guards.
	 *
	 * The defect it exists for: `capabilityOfIoKind` ends in `default:
	 * return undefined`, meaning "needs nothing registered". That is the
	 * fail-DANGEROUS polarity — a kind nobody taught it about does not become
	 * a named SKIP, it becomes *runnable*, and the run then fails opaquely
	 * mid-flight. AKAMAI_MSL walked straight into it: an MSL channel needs an
	 * Akamai-provisioned stream, and preflight called it ready to go without
	 * checking that anything supplied one. (This said the stream is something
	 * "no credential in the vault can supply" until 2026-08-25 — true when
	 * written, false since 2026-08-23, when an AKAMAI_MSL credential carrying
	 * streamId + eventName became exactly what supplies it.)
	 */
	// BOTH unions, because `capabilitiesFor` iterates `[...plan.inputs,
	// ...plan.outputs]` through the same function. The first cut derived only
	// the OUTPUT union, so a new INPUT kind still passed by omission — review-5
	// S1 planted one and this file stayed green at 17/17. Half a population is
	// the shape of instrument this repo keeps rediscovering.
	const ioKinds = [
		...planInputSchema.options.map((o) => `input:${o.shape.kind.value}`),
		...planOutputSchema.options.map((o) => `output:${o.shape.kind.value}`),
	];

	/**
	 * Kinds that legitimately need nothing registered, listed DELIBERATELY
	 * rather than reached by falling off the end of a switch. `HTTPS` is an
	 * auth-free host — the only credential-less input kind.
	 */
	const NEEDS_NOTHING = new Set<string>(["input:HTTPS"]);

	it("found both schema unions, so this does not pass over an empty list", () => {
		expect(ioKinds.length).toBeGreaterThan(10);
		expect(ioKinds).toContain("output:AKAMAI_MSL");
		expect(ioKinds).toContain("input:HTTPS");
	});

	it("maps every input and output kind to a capability, or declares it needs none", () => {
		const unclassified = ioKinds.filter(
			(tagged) =>
				capabilityOfIoKind(tagged.split(":")[1] as string) === undefined &&
				!NEEDS_NOTHING.has(tagged),
		);
		expect(
			unclassified,
			"an IO kind reaching `default: undefined` is counted RUNNABLE with no credential — classify it or add it to NEEDS_NOTHING deliberately",
		).toEqual([]);
	});

	it("classifies the MSL live fixture as needing Akamai MSL provisioning", () => {
		const msl = scenarios.find((s) => s.name === "live-akamai-msl");
		expect(msl, "the MSL fixture must be in the corpus").toBeDefined();
		expect(msl?.needs).toContain("AKAMAI_MSL");
		// And it must NOT claim a storage capability it does not use: MSL has
		// no bucket, so counting it as S3-blocked would be a different lie.
		expect(msl?.needs).not.toContain("S3");
	});
});

describe("capabilitiesFor — the three scenarios that were counted runnable and were not", () => {
	function needsOf(name: string): string[] {
		const s = scenarios.find((x) => x.name === name);
		if (!s?.plan) {
			throw new Error(`no plan for ${name}`);
		}
		return capabilitiesFor(s.plan, s.name);
	}

	it("separates a GCS service account from a GCS HMAC key", () => {
		// `preflight` folded GCS_SERVICE_ACCOUNT into GCS, so this scenario counted as
		// runnable on the registered HMAC credentials — which cannot satisfy it. Design
		// §3a reserved that decision for the owner and said it stays a named SKIP until
		// a service-account credential is registered.
		expect(needsOf("gcs-service-account-io")).toContain("GCS_SERVICE_ACCOUNT");
		expect(needsOf("gcs-service-account-io")).not.toContain("GCS");
	});

	it("declares SFTP, which nothing can satisfy, rather than counting the S3 input", () => {
		// These two declared nothing, so they came out `needs: [S3]` — runnable on their
		// INPUT — while `job.ts` cannot browse SFTP and could never fetch one artefact.
		for (const name of [
			"dash-hls-sftp-output-just-in-time",
			"dash-hls-sftp-output-post-encoding",
		]) {
			expect(needsOf(name), name).toContain("SFTP");
		}
	});

	it("still routes GENERIC_S3 to AKAMAI and S3 to S3", () => {
		// The separation must not have broken the kinds that were right.
		expect(needsOf("generic-s3-akamai-io")).toContain("AKAMAI");
		expect(needsOf("fixed-bitrate-hls-on-aws")).toContain("S3");
	});

	it("classifies every VOD fixture without throwing", () => {
		for (const s of scenarios) {
			const plan = s.plan;
			if (plan) {
				expect(() => capabilitiesFor(plan, s.name), s.name).not.toThrow();
			}
		}
	});
});

describe("per-title coverage across the whole corpus", () => {
	it("routes EVERY per-title muxing through the rung path, not just the one I tested", () => {
		// The completeness statement, measured rather than assumed. Two reviews found the
		// per-title path broken, and both times the fix was verified against ONE fixture
		// (`pertitle-h264-openapi`, then the MP4 one) — which is exactly the shape of
		// "a checker that greps one error code and reports clean on a tree it broke".
		//
		// The engine enters the per-rung path when a per-title muxing has `segmentNaming`
		// OR `filename`. Anything with neither stays on the shared-prefix path, where all
		// rungs alias to one listing and one probed file. That set must be EMPTY.
		const perTitle = scenarios
			.filter((s) => s.plan)
			.flatMap((s) => {
				const expected = compileExpectedArtefacts(
					s.plan as Parameters<typeof compileExpectedArtefacts>[0],
				);
				return expected.muxings
					.filter((m) => m.perTitle)
					.map((m) => ({ scenario: s.name, muxing: m }));
			});
		// If this ever reads 0 the assertion below is vacuous.
		expect(perTitle.length, "per-title muxings in the corpus").toBe(97);
		const stranded = perTitle
			.filter(({ muxing }) => !muxing.segmentNaming && !muxing.filename)
			.map(({ scenario, muxing }) => `${scenario}/${muxing.muxingKey}`);
		expect(
			stranded,
			"per-title muxings still on the shared-prefix path",
		).toEqual([]);
	});
});

describe("sourcesOf — the Dolby sidecars that were invisible", () => {
	it("reads videoInputPath and metadataInputPath, not just inputPath", () => {
		// `sources` is documented as exactly what the phase-B bootstrap stages, and only
		// `inputPath` was read — so the DV mezzanine and the metadata XML sidecar were
		// absent from every Dolby scenario's asset list. Two placeholder spellings live
		// ONLY in those fields.
		const dv = scenarios.find(
			(s) => s.name === "dolby-dv-separated-metadata-adm",
		);
		if (!dv?.plan) {
			throw new Error("fixture missing");
		}
		const sources = sourcesOf(dv.plan);
		expect(
			sources.length,
			"a DV plan with a separated metadata sidecar reads more than one file",
		).toBeGreaterThan(1);
	});

	it("surfaces the two placeholders that appear only in the sidecar fields", () => {
		const all = new Set(
			scenarios.flatMap((s) => (s.plan ? sourcesOf(s.plan) : [])),
		);
		// If these regress to absent, the bootstrap is told to stage a shorter list than
		// the run needs and the scenarios fail on a missing file.
		expect([...all].some((p) => /REDACTED_DV_MEZZANINE/.test(p))).toBe(true);
		expect([...all].some((p) => /REDACTED_DV_METADATA/.test(p))).toBe(true);
	});

	it("returns a sorted, de-duplicated list", () => {
		for (const s of scenarios) {
			if (!s.plan) {
				continue;
			}
			const sources = sourcesOf(s.plan);
			expect(sources, s.name).toEqual([...new Set(sources)].sort());
		}
	});
});

describe("bucketFromLabel", () => {
	it("takes the bucket out of the owner's label convention", () => {
		expect(
			bucketFromLabel("verify-akamai-input (bitmovin-api-jp-osa-1-input)"),
		).toBe("bitmovin-api-jp-osa-1-input");
	});

	it("returns undefined rather than guessing when there are no parens", () => {
		// A guess here picks a bucket in the wrong region and S3 answers "must be
		// addressed using the specified endpoint" — a lottery, which is what the probe
		// used to do across 114 buckets.
		expect(bucketFromLabel("verify-aws-bitmovin-solution")).toBeUndefined();
	});
});
