import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compilePlan } from "./compiler";
import {
	SAMPLE_PRESET_FAMILIES,
	SAMPLE_PRESETS,
	samplePresetPlan,
} from "./sample-presets";
import { encodingPlanSchema } from "./schema";

const fixturesDir = join(__dirname, "__fixtures__");

/**
 * Synthetic compiler-golden fixtures that are NOT encoding examples scenarios and
 * therefore have no preset entry (trimming/concatenation have no encoding examples,
 * like Live). Mirror of the constant in scripts/generate-sample-presets.mjs.
 */
/**
 * Fixtures with no encoding examples counterpart. Read from the shared list rather
 * than copied: three copies existed and two drifted — `multi-output-s3-gcs`
 *  reached the test copies on 2026-08-17 and never reached the
 * preset generator, which could not complete from that day until
 * ran it.
 *
 * The row numbers stay in this comment on purpose: the shared list is JSON, and
 * the ledger-reference scanner reads only .ts/.tsx/.md — moving the pointers
 * into the data file would drop them out of the guarded set, which is precisely
 * the "reworded into a spelling the pattern cannot see" case that pin exists
 * for. It caught this move.
 */
const SYNTHETIC_FIXTURES = new Set<string>(
	(
		JSON.parse(
			readFileSync(join(fixturesDir, "synthetic-fixtures.json"), "utf8"),
		) as { names: string[] }
	).names,
);

/**
 * Sync gate for the GENERATED preset module: a fixture without a preset
 * entry (or a preset without a fixture) fails here, pointing at the
 * regeneration command. Content freshness is guarded by deep-equal against
 * the fixture files and by re-running the live compiler for opCount.
 */
describe("sample presets", () => {
	const fixtureNames = readdirSync(fixturesDir)
		.filter((file) => file.endsWith(".plan.json"))
		.map((file) => file.replace(/\.plan\.json$/, ""))
		.filter((name) => !SYNTHETIC_FIXTURES.has(name))
		.sort();

	it("has exactly one preset per plan fixture (regenerate when this fails)", () => {
		const presetNames = SAMPLE_PRESETS.map((preset) => preset.name).sort();
		// Mismatch ⇒ run: pnpm --filter @bitovp/core generate:presets
		expect(presetNames).toEqual(fixtureNames);
		expect(new Set(presetNames).size).toBe(SAMPLE_PRESETS.length);
	});

	it("returns an OWNED deep clone, not the shared singleton", () => {
		// The generator used to emit `return PLANS[name]`, so a mutation in one
		// caller leaked into the next, causing a test-isolation flake.
		// Nothing caught the divergence: the fix lived only in the
		// generated file, so re-running the documented generate:presets flow
		// silently reverted it. This test fails on the shared reference, so the
		// generator and the committed module can no longer drift apart.
		const first = samplePresetPlan("fixed-bitrate-hls-on-aws");
		const second = samplePresetPlan("fixed-bitrate-hls-on-aws");
		if (!first || !second) {
			throw new Error("preset missing");
		}
		expect(first).not.toBe(second);
		(first as { name: string }).name = "mutated-by-a-caller";
		expect((second as { name: string }).name).not.toBe("mutated-by-a-caller");
		// Nested objects must be cloned too — a shallow copy would still leak.
		const nested = (first as { bitmovin: Record<string, unknown> }).bitmovin;
		const nestedTwo = (second as { bitmovin: Record<string, unknown> })
			.bitmovin;
		expect(nested).not.toBe(nestedTwo);
	});

	it("embeds every fixture verbatim and classifies it", () => {
		// IDS ONLY since 's /presets pass: the title/description pairs
		// live in the web catalogue (both locales), where
		// `apps/web/src/app/presets/preset-copy.test.tsx` walks this same array
		// and fails on any missing pair — core carries no user-facing sentences.
		const familyIds = new Set(SAMPLE_PRESET_FAMILIES.map((f) => f.id));
		for (const preset of SAMPLE_PRESETS) {
			const onDisk = JSON.parse(
				readFileSync(join(fixturesDir, preset.fixture), "utf8"),
			);
			expect(samplePresetPlan(preset.name), preset.name).toEqual(onDisk);
			expect(preset.fixture).toBe(`${preset.name}.plan.json`);
			expect(familyIds.has(preset.family), preset.name).toBe(true);
		}
	});

	it("pins opCount to the live compiler output", () => {
		for (const preset of SAMPLE_PRESETS) {
			const plan = encodingPlanSchema.parse(samplePresetPlan(preset.name));
			expect(compilePlan(plan).length, preset.name).toBe(preset.opCount);
		}
	});

	it("returns undefined for unknown preset names", () => {
		expect(samplePresetPlan("not-a-preset")).toBeUndefined();
	});

	it("families mirror the encoding examples directory counts (COVERAGE §14)", () => {
		const counts = new Map<string, number>();
		for (const preset of SAMPLE_PRESETS) {
			counts.set(preset.family, (counts.get(preset.family) ?? 0) + 1);
		}
		expect(Object.fromEntries(counts)).toEqual({
			"fixed-bitrate": 12,
			pertitle: 5,
			drm: 5,
			dolby: 18,
			hdr10: 1,
			webvtt: 4,
			keyframes: 2,
			filters: 1,
			"forensic-watermark": 1,
			"audio-only": 1,
			"ai-scene-analysis": 5,
			"dash-timeline": 1,
		});
	});
});
