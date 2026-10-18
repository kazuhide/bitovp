#!/usr/bin/env node
/**
 * Generates src/plan/sample-presets.ts from the __fixtures__ *.plan.json
 * goldens — the 56 encoding examples scenarios become one-click wizard presets.
 *
 * The output is CHECKED IN (no build-time codegen): it embeds static JSON
 * imports of the fixtures plus hand-written title/description metadata from
 * the map below. `sample-presets.test.ts` fails whenever a fixture exists
 * without a preset entry (or vice versa), so adding fixture #57 forces a
 * metadata entry here and a re-run:
 *
 *   pnpm --filter @bitovp/core generate:presets && pnpm check:fix
 *
 * opCount comes from the paired *.ops.json golden (the compiler tests pin
 * ops.json ↔ compilePlan, and the sync test re-checks against the live
 * compiler) so the gallery never compiles plans at render time.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "../src/plan/__fixtures__");
const outFile = join(here, "../src/plan/sample-presets.ts");

/**
 * Synthetic compiler-golden fixtures that are NOT encoding examples scenarios and
 * therefore NOT user-facing sample presets. They exist only to pin the
 * compiler output for capabilities with no encoding examples (like Live), so they
 * are excluded from the preset gallery (and from the COVERAGE §14 counts).
 * Keep this in sync with the same constant in sample-presets.test.ts.
 */
const SYNTHETIC_FIXTURES = new Set(
	JSON.parse(readFileSync(join(fixturesDir, "synthetic-fixtures.json"), "utf8"))
		.names,
);

/** Family ids mirror the encoding examples directories (COVERAGE §14). */
const FAMILIES = [
	["fixed-bitrate", "Fixed bitrate"],
	["pertitle", "Per-Title"],
	["drm", "DRM"],
	["dolby", "Dolby Vision & Atmos"],
	["hdr10", "HDR10"],
	["webvtt", "WebVTT subtitles"],
	["keyframes", "Keyframes (ad cues)"],
	["filters", "Filters"],
	["forensic-watermark", "Forensic watermark"],
	["audio-only", "Audio-only"],
	["ai-scene-analysis", "AI Scene Analysis"],
	["dash-timeline", "DASH segment timeline"],
];

/**
 * Fixture-name → family. Order matters: "-vtt" and "drm" markers win over
 * the fixed-bitrate / pertitle prefixes so families match the sample dirs
 * (webvtt 4, drm 5 — the counts in the COVERAGE §14 table).
 */
function familyOf(name) {
	if (name.includes("-vtt")) {
		return "webvtt";
	}
	if (name.includes("drm")) {
		return "drm";
	}
	if (name.startsWith("ai-scene-analysis")) {
		return "ai-scene-analysis";
	}
	if (name.startsWith("audio-only")) {
		return "audio-only";
	}
	if (name.startsWith("dash-template-and-timeline")) {
		return "dash-timeline";
	}
	if (name.startsWith("dash-hls-sftp")) {
		return "fixed-bitrate";
	}
	// . Grouped with fixed-bitrate for the same reason
	// dash-hls-sftp is: the fixture exists to exercise a STORAGE kind, and its
	// ladder is an ordinary fixed-bitrate one. The family names what the plan
	// encodes, not where it writes.
	if (name.startsWith("akamai-netstorage")) {
		return "fixed-bitrate";
	}
	//  PR-b, and a PRE-EXISTING gap this row happened to surface:
	// the fixture landed 2026-08-17 and nothing has run this generator since,
	// so it has been unable to complete ever since — silently, because the only
	// caller is a manual script. Same family reasoning as above: a delivery
	// mirror is about where the plan writes, not what it encodes.
	if (name.startsWith("multi-output")) {
		return "fixed-bitrate";
	}
	if (name.startsWith("deinterlace")) {
		return "filters";
	}
	if (name.startsWith("dolby")) {
		return "dolby";
	}
	if (
		name.startsWith("fixed-bitrate") ||
		name.startsWith("mp4-fixed-bitrate")
	) {
		return "fixed-bitrate";
	}
	if (name.startsWith("hdr10")) {
		return "hdr10";
	}
	if (name.startsWith("keyframes")) {
		return "keyframes";
	}
	if (name.startsWith("nexguard")) {
		return "forensic-watermark";
	}
	if (name.startsWith("pertitle")) {
		return "pertitle";
	}
	throw new Error(
		`No family rule for fixture "${name}" — add one to scripts/generate-sample-presets.mjs`,
	);
}

/** Hand-written one-liners per fixture (COVERAGE §14 semantics). */
// Titles/descriptions moved to the WEB catalogue (apps/web/src/lib/i18n/
// messages/{en,ja}.ts, the `presetGallery` namespace, keyed on the stable
// preset name) — core is UI-free and must not hold user-facing sentences
// . This generator emits IDS ONLY; adding a preset means adding
// its fixture here AND its two catalogue keys in both locales (the gallery's
// totality test fails until both exist).

const names = readdirSync(fixturesDir)
	.filter((file) => file.endsWith(".plan.json"))
	.map((file) => file.replace(/\.plan\.json$/, ""))
	.filter((name) => !SYNTHETIC_FIXTURES.has(name))
	.sort();

const familyIds = FAMILIES.map(([id]) => id);
const entries = names.map((name) => {
	const family = familyOf(name);
	const ops = JSON.parse(
		readFileSync(join(fixturesDir, `${name}.ops.json`), "utf8"),
	);
	if (!Array.isArray(ops)) {
		throw new Error(`${name}.ops.json is not an operations array`);
	}
	return { name, family, opCount: ops.length };
});

// Stable order: family (declared order), then name.
entries.sort(
	(a, b) =>
		familyIds.indexOf(a.family) - familyIds.indexOf(b.family) ||
		a.name.localeCompare(b.name),
);

const identifier = (name) =>
	`plan_${name.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase())}`;

const q = JSON.stringify;
const lines = [];
lines.push("/**");
lines.push(" * GENERATED FILE — do not edit by hand.");
lines.push(
	" * Regenerate: pnpm --filter @bitovp/core generate:presets && pnpm check:fix",
);
lines.push(" *");
lines.push(
	" * One preset per encoding examples golden (src/plan/__fixtures__/*.plan.json,",
);
lines.push(
	" * the acceptance fixtures). sample-presets.test.ts fails when this file",
);
lines.push(" * drifts from the fixture directory.");
lines.push(" */");
// Alphabetical by path so biome's organizeImports leaves the file stable.
for (const name of names) {
	lines.push(
		`import ${identifier(name)} from "./__fixtures__/${name}.plan.json";`,
	);
}
lines.push("");
lines.push(
	`export type SamplePresetFamily =\n${familyIds.map((id) => `\t| ${q(id)}`).join("\n")};`,
);
lines.push("");
lines.push("export type SamplePreset = {");
lines.push("\t/** Fixture name — also the /vod/new?preset= parameter. */");
lines.push("\tname: string;");
lines.push("\tfamily: SamplePresetFamily;");

lines.push(
	"\t/** Fixture filename under packages/core/src/plan/__fixtures__/. */",
);
lines.push("\tfixture: string;");
lines.push(
	"\t/** Compiled operation count (length of the paired .ops.json golden). */",
);
lines.push("\topCount: number;");
lines.push("};");
lines.push("");
lines.push(
	"/** Gallery grouping order — mirrors the encoding examples directories. */",
);
lines.push(
	"export const SAMPLE_PRESET_FAMILIES: {\n\tid: SamplePresetFamily;\n}[] = [",
);
for (const [id] of FAMILIES) {
	lines.push(`\t{ id: ${q(id)} },`);
}
lines.push("];");
lines.push("");
lines.push("export const SAMPLE_PRESETS: SamplePreset[] = [");
for (const e of entries) {
	lines.push("\t{");
	lines.push(`\t\tname: ${q(e.name)},`);
	lines.push(`\t\tfamily: ${q(e.family)},`);

	lines.push(`\t\tfixture: ${q(`${e.name}.plan.json`)},`);
	lines.push(`\t\topCount: ${e.opCount},`);
	lines.push("\t},");
}
lines.push("];");
lines.push("");
lines.push("const PLANS: Record<string, unknown> = {");
for (const { name } of entries) {
	lines.push(`\t${q(name)}: ${identifier(name)},`);
}
lines.push("};");
lines.push("");
lines.push("/** The plan JSON for a preset (undefined for unknown names). */");
lines.push(
	"export function samplePresetPlan(\n\tname: string,\n): Record<string, unknown> | undefined {",
);
lines.push(
	"\t// Own-property check so prototype names (__proto__, constructor, …)",
);
lines.push("\t// coming from the URL stay unknown instead of leaking objects.");
lines.push("\tif (!Object.hasOwn(PLANS, name)) {");
lines.push("\t\treturn undefined;");
lines.push("\t}");
lines.push(
	"\t// Deep-clone the imported-JSON singleton: callers (the API route, the",
);
lines.push(
	"\t// wizard's preset import, tests) treat the plan as owned and may mutate it.",
);
lines.push("\t// A shared reference would leak mutations into later callers.");
lines.push("\t// Fixtures are pure JSON, so a JSON round-trip is a sufficient");
lines.push("\t// dependency-free deep clone.");
lines.push(
	"\treturn JSON.parse(JSON.stringify(PLANS[name])) as Record<string, unknown>;",
);
lines.push("}");
lines.push("");

writeFileSync(outFile, lines.join("\n"));
console.log(`Wrote ${entries.length} presets to ${outFile}`);
