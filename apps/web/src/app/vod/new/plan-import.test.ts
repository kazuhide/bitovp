import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { encodingPlanSchema, PROVIDERS_FOR_IO_KIND } from "@bitovp/core";
import { describe, expect, it } from "vitest";
import {
	buildSubmissionPlan,
	collectCredentialRefs,
	collectPlaceholders,
	countPendingPlaceholders,
	importedAccountId,
	isPlaceholderCredentialId,
	listStorageRefs,
	parseImportedPlan,
	replaceCredentialId,
	replacePlaceholder,
	summarizePlanSections,
	withStorageLocation,
} from "./plan-import";

// bitmovin.accountId is z.uuid — vault BitmovinAccount ids.
const ACCOUNT_ID = "00000000-0000-4000-8000-00000000aaaa";
const PLAN_ACCOUNT_ID = "00000000-0000-4000-8000-00000000bbbb";

const fixturesDir = join(
	__dirname,
	"../../../../../../packages/core/src/plan/__fixtures__",
);

/**
 * P2 exit criterion (ROADMAP): the drm/dolby/pertitle/AISA scenarios run
 * end-to-end FROM THE UI. The import path is the UI entry point — every
 * golden plan must import, validate green, and the submission body must
 * deep-equal the fixture (modulo the documented accountId injection).
 */
const EXIT_FIXTURES = [
	// drm 5
	"cenc-cbc-drm-on-aws",
	"pertitle-h264-fmp4-ts-drm-on-aws",
	"pertitle-h264-mp4-smooth-drm-on-aws",
	"pertitle-h265-fmp4-drm-on-aws",
	"pertitle-vp9-webm-cenc-drm-on-aws",
	// dolby 14
	"dolby-audio-only-atmos-damf",
	"dolby-audio-only-atmos-adm",
	"dolby-atmos-progressive-mp4",
	"dolby-dv-ddp-multi-audio",
	"dolby-dv-embedded-ddp",
	"dolby-dv-hdr10-sdr-2ladder-profile81",
	"dolby-dv-hdr10-sdr-3ladder-profile5-single-input",
	"dolby-dv-hdr10-sdr-3ladder-profile5-dv-sdr-inputs",
	"dolby-dv-atmos-damf",
	"dolby-dv-atmos-damf-aac",
	"dolby-dv-atmos-adm",
	"dolby-dv-atmos-damf-https",
	"dolby-dv-atmos-adm-https",
	"dolby-dv-separated-metadata-adm",
	// pertitle 5
	"pertitle-h264-fmp4-ts-dash-hls-on-aws",
	"pertitle-h265-fmp4-dash-hls-on-aws",
	"pertitle-vp9-webm-fmp4-dash-on-aws",
	"pertitle-h264-openapi",
	"pertitle-h264-separate-av-inputs",
	// ai-scene-analysis 5
	"ai-scene-analysis-passthrough",
	"ai-scene-analysis-pertitle",
	"ai-scene-analysis-passthrough-test",
	"ai-scene-analysis-pertitle-test",
	"ai-scene-analysis-batch-item",
];

// Synthetic compiler-golden fixtures with no encoding examples (trimming/concat,
// GenericS3/GCS I/O, like Live) — not part of the "56 encoding examples scenarios"
// this suite tracks.
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

describe("plan import (expert mode)", () => {
	const allFixtures = readdirSync(fixturesDir)
		.filter((f) => f.endsWith(".plan.json"))
		.map((f) => f.replace(/\.plan\.json$/, ""))
		.filter((name) => !SYNTHETIC_FIXTURES.has(name));

	it("covers all 56 golden plans (the suite shrinks loudly, not silently)", () => {
		expect(allFixtures).toHaveLength(56);
	});

	it("the exit-fixture list exists on disk", () => {
		for (const name of EXIT_FIXTURES) {
			expect(allFixtures).toContain(name);
		}
	});

	for (const name of allFixtures) {
		const exit = EXIT_FIXTURES.includes(name);
		it(`imports ${name}${exit ? " (P2 exit fixture)" : ""}`, () => {
			const text = readFileSync(join(fixturesDir, `${name}.plan.json`), "utf8");
			const result = parseImportedPlan(text);
			if (!result.ok) {
				throw new Error(result.errorKey);
			}
			const { raw, evaluation } = result.imported;
			// Submission payload is the import, verbatim.
			expect(raw).toEqual(JSON.parse(text));
			if (!evaluation.ok) {
				throw new Error(evaluation.zodMessage);
			}
			expect(evaluation.plan).toEqual(
				encodingPlanSchema.parse(JSON.parse(text)),
			);
			expect(evaluation.issues.filter((i) => i.level === "error")).toEqual([]);
			expect(evaluation.opCount).toBeGreaterThan(0);
			// The OPS themselves, not just their count — review-170's mutation
			// (ops: [] with opCount intact) passed the entire web suite: the badge
			// said "122 operations" while the Operations tab said "fix the
			// validation errors". Well-typed-but-wrong is the realistic
			// regression; typecheck only catches the deleted field.
			expect(evaluation.ops).toHaveLength(evaluation.opCount);
			expect(evaluation.ops[0]?.step).toBeTruthy();
			expect(summarizePlanSections(raw).length).toBeGreaterThan(3);
			// The wizard's POST body: the fixture verbatim plus the injected
			// account (no golden carries one — the single exception).
			expect(importedAccountId(result.imported)).toBeUndefined();
			const fixture = JSON.parse(text) as Record<string, unknown>;
			const body = buildSubmissionPlan(result.imported, ACCOUNT_ID);
			expect(body).toEqual({
				...fixture,
				bitmovin: {
					...(fixture.bitmovin as Record<string, unknown>),
					accountId: ACCOUNT_ID,
				},
			});
			// The injected plan still parses (accountId is a schema field).
			expect(encodingPlanSchema.safeParse(body).success).toBe(true);
		});
	}

	it("respects a plan-carried accountId verbatim", () => {
		const text = readFileSync(
			join(fixturesDir, "ai-scene-analysis-passthrough.plan.json"),
			"utf8",
		);
		const plan = JSON.parse(text) as { bitmovin: Record<string, unknown> };
		plan.bitmovin.accountId = PLAN_ACCOUNT_ID;
		const result = parseImportedPlan(JSON.stringify(plan));
		if (!result.ok) {
			throw new Error(result.errorKey);
		}
		expect(importedAccountId(result.imported)).toBe(PLAN_ACCOUNT_ID);
		// The wizard selection must NOT override the plan's own account.
		expect(buildSubmissionPlan(result.imported, ACCOUNT_ID)).toEqual(plan);
	});

	it("rejects non-JSON input with a readable error", () => {
		const result = parseImportedPlan("not json {");
		expect(result.ok).toBe(false);
		if (!result.ok) {
			// A message KEY now, with the parser detail carried separately.
			expect(result.errorKey).toBe("wizardX.importNotValidJson");
			expect(result.errorDetail).toBeTruthy();
		}
	});

	it("rejects JSON that is not an object", () => {
		const result = parseImportedPlan("[1, 2]");
		expect(result.ok).toBe(false);
	});

	it("surfaces schema issues for incomplete plans", () => {
		const result = parseImportedPlan('{"planVersion": 1}');
		if (!result.ok) {
			throw new Error(result.errorKey);
		}
		expect(result.imported.evaluation.ok).toBe(false);
	});

	it("surfaces validator rails for schema-valid but invalid plans", () => {
		const text = readFileSync(
			join(fixturesDir, "dolby-dv-hdr10-sdr-2ladder-profile81.plan.json"),
			"utf8",
		);
		const plan = JSON.parse(text) as { generation: { timing: string } };
		plan.generation.timing = "JUST_IN_TIME"; // multi-encoding ⇒ POST only
		const result = parseImportedPlan(JSON.stringify(plan));
		if (!result.ok) {
			throw new Error(result.errorKey);
		}
		const evaluation = result.imported.evaluation;
		if (!evaluation.ok) {
			throw new Error(evaluation.zodMessage);
		}
		expect(
			evaluation.issues.some((i) => i.code === "PLAN_MULTI_ENCODING_JIT"),
		).toBe(true);
	});
});

/**
 * Preset-checklist helpers: presets are golden fixtures whose credentials,
 * buckets and <INSERT_*>/{YOUR *} paths are placeholders — the checklist
 * swaps them via these pure functions and re-runs parseImportedPlan.
 */
describe("preset checklist helpers", () => {
	const load = (name: string) =>
		JSON.parse(
			readFileSync(join(fixturesDir, `${name}.plan.json`), "utf8"),
		) as Record<string, unknown>;

	it("collects credential refs with contexts and provider filters", () => {
		const raw = load("cenc-cbc-drm-on-aws");
		const refs = collectCredentialRefs(raw);
		const input = refs.find(
			(ref) => ref.id === "00000000-0000-4000-8000-000000000001",
		);
		expect(input?.providers).toEqual(["AWS_S3"]);
		expect(input?.contexts).toEqual(["inputs[0] S3"]);
		const drm = refs.find(
			(ref) => ref.id === "00000000-0000-4000-8000-000000000005",
		);
		expect(drm?.providers).toEqual(["DRM_CENC"]);
		expect(drm?.contexts).toHaveLength(6); // 5 video + 1 audio CENC rows
		expect(isPlaceholderCredentialId(input?.id ?? "")).toBe(true);
	});

	it("collects SFTP and NexGuard provider filters", () => {
		const sftp = collectCredentialRefs(
			load("dash-hls-sftp-output-post-encoding"),
		);
		expect(
			sftp.find((ref) => ref.contexts.some((c) => c.includes("outputs")))
				?.providers,
		).toEqual(["SFTP"]);
		const nexguard = collectCredentialRefs(load("nexguard-watermarking"));
		expect(
			nexguard.find((ref) => ref.contexts.some((c) => c.includes("nexguard")))
				?.providers,
		).toEqual(["NEXGUARD"]);
	});

	it("allows SPEKE provider credentials when replacing imported DRM refs", () => {
		const refs = collectCredentialRefs({
			drm: [
				{
					kind: "SPEKE",
					credentialId: "00000000-0000-4000-8000-000000000005",
				},
				{
					kind: "FAIRPLAY",
					credentialId: "00000000-0000-4000-8000-000000000006",
				},
			],
		});
		expect(refs[0]?.providers).toEqual(["DRM_SPEKE"]);
		expect(refs[1]?.providers).toEqual(["DRM_CENC"]);
	});

	/**
	 * Audit AA972-IMPORT-001, both halves, over the whole corpus.
	 *
	 * The arms above cover AWS_S3 / DRM_CENC / SFTP / NEXGUARD — which are
	 * precisely the four the broken helper got RIGHT (S3 and SFTP by name, the
	 * other two through their own branches). Everything it got wrong was
	 * untested, and the Kantar credential was not merely misclassified but
	 * INVISIBLE: `kantar` is a top-level field and the collector only walked
	 * arrays, so a placeholder there passed the Start gate.
	 *
	 * The MISS half is derived by walking the fixture JSON directly — asking the
	 * collector what it found and then checking that it found it would be the
	 * same instrument twice. The MISCLASSIFICATION half is weaker and worth
	 * naming: it reads the same core table the collector reads, so it cannot
	 * catch a wrong VALUE in that table, only a collector that stops consulting
	 * it. Table values are pinned by the worker's drift test, which derives the
	 * executor's accepted set by running every provider through every IO op —
	 * the one layer of the three that kills a wrong table value.
	 */
	it("finds every credential-bearing field in every fixture, with the right providers", () => {
		const files = readdirSync(fixturesDir).filter((f) =>
			f.endsWith(".plan.json"),
		);
		expect(files.length).toBeGreaterThan(60);

		/**
		 * Independent walk: every credentialId OCCURRENCE, with its kind.
		 *
		 * Occurrences, not ids. Keying this by id alone made presence of the ID
		 * stand in for presence of the LOCATION, so a credential-bearing field
		 * the collector never walks was invisible whenever its UUID also
		 * appeared somewhere the collector does walk — and these fixtures reuse
		 * placeholder ids by convention, so that is the normal case, not the
		 * corner. Review demonstrated it both ways: a planted field with a fresh
		 * UUID failed this test, the same planted field with a reused UUID
		 * passed it.
		 */
		const walk = (
			value: unknown,
			out: Map<string, { kinds: Set<string>; count: number }>,
			kind = "-",
		): void => {
			if (Array.isArray(value)) {
				for (const item of value) {
					walk(item, out, kind);
				}
				return;
			}
			if (value === null || typeof value !== "object") {
				return;
			}
			const rec = value as Record<string, unknown>;
			const here = typeof rec.kind === "string" ? rec.kind : kind;
			if (typeof rec.credentialId === "string") {
				const entry = out.get(rec.credentialId) ?? {
					kinds: new Set<string>(),
					count: 0,
				};
				entry.kinds.add(here);
				entry.count += 1;
				out.set(rec.credentialId, entry);
			}
			for (const [k, v] of Object.entries(rec)) {
				if (k !== "credentialId") {
					walk(v, out, here);
				}
			}
		};

		const missed: string[] = [];
		const misclassified: string[] = [];
		for (const file of files) {
			const raw = JSON.parse(
				readFileSync(join(fixturesDir, file), "utf8"),
			) as Record<string, unknown>;
			const truth = new Map<string, { kinds: Set<string>; count: number }>();
			walk(raw, truth);
			const found = new Map(
				collectCredentialRefs(raw).map((r) => [r.id, r] as const),
			);
			for (const [id, entry] of truth) {
				const ref = found.get(id);
				if (!ref) {
					missed.push(`${file}: ${id} (not collected at all)`);
					continue;
				}
				// COUNT, not presence: the collector reports one context per
				// location it visits, so a shortfall means a location it walked
				// past — which id-presence alone cannot see.
				if (ref.contexts.length !== entry.count) {
					missed.push(
						`${file}: ${id} appears at ${entry.count} location(s), collected ${ref.contexts.length}`,
					);
				}
			}
			// Provider correctness, for the refs that name a storage kind.
			for (const [id, ref] of found) {
				for (const kind of truth.get(id)?.kinds ?? []) {
					const expected = PROVIDERS_FOR_IO_KIND[kind];
					if (expected === undefined) {
						continue; // DRM/NexGuard/Kantar have their own branches
					}
					for (const p of expected) {
						if (!ref.providers.includes(p)) {
							misclassified.push(`${file}: ${kind} → missing ${p}`);
						}
					}
				}
			}
		}
		expect(missed).toEqual([]);
		expect(misclassified).toEqual([]);
	});

	it("finds the Kantar credential — a top-level field, not an array", () => {
		const refs = collectCredentialRefs(load("kantar-audio-watermark"));
		const kantar = refs.find((r) => r.contexts.includes("kantar"));
		expect(kantar?.providers).toEqual(["KANTAR"]);
		// The consequence that made it High: the Start gate reads these refs,
		// so an unseen placeholder is a plan that submits with a fake id.
		expect(isPlaceholderCredentialId(kantar?.id ?? "")).toBe(true);
	});

	it("the Start gate counts the Kantar placeholder — the outcome, not the collector", () => {
		// `countPendingPlaceholders` is built ON `collectCredentialRefs`, so a
		// credential the collector cannot see is a placeholder the Start gate
		// never counts: the plan submits with a fake id and fails at Bitmovin.
		// Asserted at the gate rather than at the collector, because THIS is
		// the property that must survive a later refactor of either one.
		const raw = load("kantar-audio-watermark");
		const before = countPendingPlaceholders(raw);
		expect(before).toBeGreaterThan(0);
		// And it goes away once the operator assigns a real credential —
		// otherwise a gate that never opens would pass this test too.
		const resolved = replaceCredentialId(
			raw,
			(collectCredentialRefs(raw).find((r) => r.contexts.includes("kantar"))
				?.id ?? "") as string,
			"11111111-2222-4333-8444-555555555555",
		);
		expect(countPendingPlaceholders(resolved)).toBe(before - 1);
	});

	it("replaceCredentialId rewrites every occurrence and nothing else", () => {
		const raw = load("cenc-cbc-drm-on-aws");
		const real = "11111111-2222-4333-8444-555555555555";
		const next = replaceCredentialId(
			raw,
			"00000000-0000-4000-8000-000000000005",
			real,
		);
		const drm = next.drm as { credentialId: string; kid: string }[];
		expect(drm.every((row) => row.credentialId === real)).toBe(true);
		// Non-credential fields (kid) and other refs stay untouched.
		expect(drm[0]?.kid).toBe("43214321432143214321432143214321");
		expect((next.inputs as { credentialId: string }[])[0]?.credentialId).toBe(
			"00000000-0000-4000-8000-000000000001",
		);
		// Original is not mutated.
		expect((raw.drm as { credentialId: string }[])[0]?.credentialId).toBe(
			"00000000-0000-4000-8000-000000000005",
		);
	});

	it("collects placeholder tokens but never the C4 run-time placeholders", () => {
		const dolby = collectPlaceholders(load("dolby-dv-separated-metadata-adm"));
		expect(dolby.map((p) => p.token).sort()).toEqual([
			"<INSERT_DOLBY_ATMOS_ADM_PATH>",
			"<INSERT_DOLBY_VISION_METADATA_PATH>",
			"<INSERT_DOLBY_VISION_VIDEO_PATH>",
		]);
		const perTitle = collectPlaceholders(
			load("pertitle-h265-fmp4-dash-hls-on-aws"),
		);
		expect(perTitle.map((p) => p.token)).toEqual(["{YOUR INPUT FILE PATH}"]);
		// {height}/{bitrate}/{uuid} C4 placeholders must NOT be flagged.
		expect(
			perTitle.some((p) => /\{(height|bitrate|uuid)\}/.test(p.token)),
		).toBe(false);
	});

	it("replacePlaceholder swaps tokens inside longer strings too", () => {
		const raw = load("dolby-dv-separated-metadata-adm");
		const next = replacePlaceholder(
			raw,
			"<INSERT_DOLBY_VISION_VIDEO_PATH>",
			"masters/dv.mov",
		);
		const ingest = next.ingest as { inputPath: string }[];
		expect(ingest[0]?.inputPath).toBe("masters/dv.mov");
		expect(collectPlaceholders(next).map((p) => p.token)).not.toContain(
			"<INSERT_DOLBY_VISION_VIDEO_PATH>",
		);
	});

	it("lists and rewrites storage locations per kind", () => {
		const raw = load("dash-hls-sftp-output-post-encoding");
		const refs = listStorageRefs(raw);
		expect(refs).toEqual([
			{
				section: "inputs",
				index: 0,
				key: "main",
				kind: "S3",
				location: "sample-input-bucket",
			},
			// SFTP host/port live in the vault credential — not editable here.
			{
				section: "outputs",
				index: 0,
				key: "origin",
				kind: "SFTP",
				location: null,
			},
		]);
		const next = withStorageLocation(raw, "inputs", 0, "my-bucket");
		expect((next.inputs as { bucket: string }[])[0]?.bucket).toBe("my-bucket");
		// SFTP rows are left untouched.
		expect(withStorageLocation(raw, "outputs", 0, "x").outputs).toEqual(
			raw.outputs,
		);
	});

	it("countPendingPlaceholders gates a placeholder preset until the checklist resolves it", () => {
		// 3 placeholder credential ids + 3 <INSERT_*> tokens — Start disabled.
		const raw = load("dolby-dv-separated-metadata-adm");
		expect(countPendingPlaceholders(raw)).toBe(6);
		// Resolve exactly the way the checklist does: replaceCredentialId per
		// pending ref, replacePlaceholder per token — the gate clears.
		let next = raw;
		for (const ref of collectCredentialRefs(raw)) {
			if (isPlaceholderCredentialId(ref.id)) {
				next = replaceCredentialId(
					next,
					ref.id,
					"11111111-2222-4333-8444-555555555555",
				);
			}
		}
		expect(countPendingPlaceholders(next)).toBe(3); // tokens still pending
		for (const placeholder of collectPlaceholders(next)) {
			next = replacePlaceholder(next, placeholder.token, "real/object/path");
		}
		expect(countPendingPlaceholders(next)).toBe(0);
		// The original raw plan is untouched (gate recomputes per edit).
		expect(countPendingPlaceholders(raw)).toBe(6);
	});

	it("countPendingPlaceholders never counts C4 run-time placeholders", () => {
		// 2 placeholder credentials + {YOUR INPUT FILE PATH} = 3 to resolve.
		const raw = load("pertitle-h265-fmp4-dash-hls-on-aws");
		expect(countPendingPlaceholders(raw)).toBe(3);
		let next = raw;
		for (const ref of collectCredentialRefs(raw)) {
			next = replaceCredentialId(
				next,
				ref.id,
				"11111111-2222-4333-8444-555555555555",
			);
		}
		next = replacePlaceholder(next, "{YOUR INPUT FILE PATH}", "in/master.mov");
		// {uuid}/{bitrate}/{height} stay in the plan (C4) — and never gate.
		expect(JSON.stringify(next)).toMatch(/\{(uuid|bitrate|height)\}/);
		expect(countPendingPlaceholders(next)).toBe(0);
	});

	it("checklist edits keep the plan importable and green", () => {
		const raw = load("dolby-dv-separated-metadata-adm");
		let next = replaceCredentialId(
			raw,
			"00000000-0000-4000-8000-000000000007",
			"11111111-2222-4333-8444-555555555555",
		);
		next = withStorageLocation(next, "inputs", 1, "metadata-bucket");
		next = replacePlaceholder(
			next,
			"<INSERT_DOLBY_VISION_METADATA_PATH>",
			"metadata/dv.xml",
		);
		const result = parseImportedPlan(JSON.stringify(next));
		if (!result.ok) {
			throw new Error(result.errorKey);
		}
		const evaluation = result.imported.evaluation;
		if (!evaluation.ok) {
			throw new Error(evaluation.zodMessage);
		}
		expect(evaluation.issues.filter((i) => i.level === "error")).toEqual([]);
		expect(evaluation.opCount).toBeGreaterThan(0);
		// The OPS themselves, not just their count — review-170's mutation
		// (ops: [] with opCount intact) passed the entire web suite: the badge
		// said "122 operations" while the Operations tab said "fix the
		// validation errors". Well-typed-but-wrong is the realistic
		// regression; typecheck only catches the deleted field.
		expect(evaluation.ops).toHaveLength(evaluation.opCount);
		expect(evaluation.ops[0]?.step).toBeTruthy();
	});
});
