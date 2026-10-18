import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compilePlan } from "./compiler";
import { type EncodingPlan, encodingPlanSchema } from "./schema";
import {
	instantiateTemplatePlan,
	renderTemplateOutputPrefix,
	templateSourceSites,
} from "./template-instantiate";
import { planHasErrors, validatePlan } from "./validate";

const dir = join(__dirname, "__fixtures__");
const FIXTURES = readdirSync(dir)
	.filter((f) => f.endsWith(".plan.json"))
	.map((f) => f.slice(0, -".plan.json".length))
	.sort();

function loadPlan(name: string): EncodingPlan {
	return encodingPlanSchema.parse(
		JSON.parse(readFileSync(join(dir, `${name}.plan.json`), "utf8")),
	);
}

const NOW = new Date("2026-08-17T00:00:00.000Z");
const UUID = "0f9d8c7b";

/**
 *  PR1. The instantiation core, held to the #87 bar: the whole
 * corpus must instantiate, re-parse, re-COMPILE, and walk clean — including
 * the multi-input class (Dolby, concatenation, separate-A/V) that the watch
 * rule deliberately excludes and that is exactly the set of hardened
 * workflows worth templating.
 */
describe("templateSourceSites — the DERIVED ask-list", () => {
	it("matches an independent structural count on every fixture — two instruments, not one", () => {
		// Second instrument: walk the raw JSON for path-bearing fields
		// (inputPath / videoInputPath / metadataInputPath on objects that
		// also carry inputKey). The enumerated deriver and the walk must
		// agree on EVERY fixture; a schema shape one of them misses is a
		// disagreement, not a silent gap.
		for (const name of FIXTURES) {
			const raw = JSON.parse(
				readFileSync(join(dir, `${name}.plan.json`), "utf8"),
			) as Record<string, unknown>;
			let walked = 0;
			const walk = (node: unknown): void => {
				if (Array.isArray(node)) {
					for (const item of node) {
						walk(item);
					}
					return;
				}
				if (typeof node !== "object" || node === null) {
					return;
				}
				const rec = node as Record<string, unknown>;
				if (typeof rec.inputKey === "string") {
					// /Path$/, not an enumerated list (review-109pr1): the
					// deriver and this walk previously shared their field
					// VOCABULARY, so a new path field added to the schema and
					// missed by the deriver would have been missed by both —
					// agreement without coverage. Any *Path key on an
					// inputKey-bearing object now counts.
					for (const [key, value] of Object.entries(rec)) {
						if (key.endsWith("Path") && typeof value === "string") {
							walked += 1;
						}
					}
				}
				for (const v of Object.values(rec)) {
					walk(v);
				}
			};
			walk(raw);
			const derived = templateSourceSites(loadPlan(name)).length;
			expect(derived, name).toBe(walked);
		}
	});

	it("pins the measured counts for the interesting shapes", () => {
		// Literals measured 2026-08-17 (not guessed): single-file plans,
		// separate A/V, a VTT sidecar, concatenation, Atmos, and the
		// 8-site Dolby Vision 3-ladder — the corpus's maximum.
		const counts = Object.fromEntries(
			FIXTURES.map((name) => [
				name,
				templateSourceSites(loadPlan(name)).length,
			]),
		);
		expect(counts["vmaf-only-h264"]).toBe(1);
		expect(counts["dolby-atmos-progressive-mp4"]).toBe(1);
		expect(counts["mp4-fixed-bitrate-hls-on-aws"]).toBe(2);
		expect(counts["pertitle-h264-separate-av-inputs"]).toBe(2);
		expect(counts["concatenation-two-sources"]).toBe(2);
		expect(counts["mp4-fixed-bitrate-hls-vtt-on-aws"]).toBe(3);
		expect(counts["dolby-dv-3ladder-profile5-dash-ondemand"]).toBe(8);
		// Every plan in the corpus has at least one site — a template with
		// zero sources would be unlaunchable and unrepresentable.
		for (const [name, n] of Object.entries(counts)) {
			expect(n, name).toBeGreaterThanOrEqual(1);
		}
	});

	it("a VISION stream with a metadata sidecar yields TWO sites off one stream", () => {
		const plan = FIXTURES.map(loadPlan).find((p) =>
			p.dolbyStreams.some(
				(s) => s.kind === "VISION" && s.metadataInputPath !== undefined,
			),
		);
		expect(
			plan,
			"corpus carries a separated-metadata VISION plan",
		).toBeTruthy();
		const sites = templateSourceSites(plan as EncodingPlan);
		const vision = sites.filter(
			(s) => s.dolbyKind === "VISION" && s.field === "videoInputPath",
		);
		expect(vision.length).toBeGreaterThanOrEqual(1);
		const first = vision[0] as (typeof vision)[number];
		const metadata = sites.find(
			(s) => s.siteId === `${first.streamKey}:metadata`,
		);
		expect(metadata?.field).toBe("metadataInputPath");
		expect(metadata?.inputKey).toBe(first.inputKey);
	});
});

describe("instantiateTemplatePlan — the corpus sweep (the #87 bar, generalized)", () => {
	for (const name of FIXTURES) {
		it(`${name}: substitute every site → re-parses, re-compiles, walks clean`, () => {
			const plan = loadPlan(name);
			const sites = templateSourceSites(plan);
			const sources = Object.fromEntries(
				sites.map((s) => [
					s.siteId,
					{
						objectKey: `launched/${s.siteId.replace(/[^A-Za-z0-9_-]/g, "_")}.dat`,
					},
				]),
			);
			const result = instantiateTemplatePlan({
				presetBody: JSON.parse(
					readFileSync(join(dir, `${name}.plan.json`), "utf8"),
				),
				sources,
				outputPrefixTemplate: "tpl-{template}/{date}-{uuid}",
				name: `${name} [launch]`,
				templateName: name,
				now: NOW,
				uuid: UUID,
			});
			expect(result.ok, JSON.stringify(!result.ok && result.issues)).toBe(true);
			if (!result.ok) {
				return;
			}
			const launched = result.plan;
			expect(result.outputPrefix).toBe(`tpl-${name}/2026-08-17-${UUID}`);

			// Every site's path IS the substituted value — asserted by
			// re-deriving sites on the RESULT (relation, not presence).
			const after = templateSourceSites(launched);
			expect(after.map((s) => s.siteId).sort()).toEqual(
				sites.map((s) => s.siteId).sort(),
			);
			for (const s of after) {
				expect(s.currentPath, s.siteId).toBe(
					`launched/${s.siteId.replace(/[^A-Za-z0-9_-]/g, "_")}.dat`,
				);
			}

			// Zero un-rebased destinations: every {outputKey, path} in the
			// result sits under the prefix (the #87 pin's walk).
			let destinations = 0;
			const walk = (node: unknown): void => {
				if (Array.isArray(node)) {
					for (const item of node) {
						walk(item);
					}
					return;
				}
				if (typeof node !== "object" || node === null) {
					return;
				}
				const rec = node as Record<string, unknown>;
				if (typeof rec.outputKey === "string" && typeof rec.path === "string") {
					destinations += 1;
					expect(rec.path, `${name} destination`).toMatch(
						new RegExp(
							`^${result.outputPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/`,
						),
					);
				}
				for (const v of Object.values(rec)) {
					walk(v);
				}
			};
			walk(launched);
			expect(
				destinations,
				"a plan with no destinations verifies nothing",
			).toBeGreaterThan(0);

			// Instantiation preserves the valid quality settings of every template.
			expect(planHasErrors(validatePlan(launched))).toBe(false);
			expect(() => compilePlan(launched)).not.toThrow();
			expect(launched.name).toBe(`${name} [launch]`);
		});
	}
});

describe("instantiateTemplatePlan — semantics and refusals", () => {
	const body = () =>
		JSON.parse(
			readFileSync(join(dir, "mp4-fixed-bitrate-hls-on-aws.plan.json"), "utf8"),
		) as Record<string, unknown>;
	const base = {
		outputPrefixTemplate: "runs/{date}/{uuid}",
		name: "launch",
		templateName: "t",
		now: NOW,
		uuid: UUID,
	};

	it("zero-edit re-run: absent sources keep the template's own paths", () => {
		const template = encodingPlanSchema.parse(body());
		const before = templateSourceSites(template);
		const result = instantiateTemplatePlan({ presetBody: body(), ...base });
		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		const after = templateSourceSites(result.plan);
		expect(after.map((s) => s.currentPath)).toEqual(
			before.map((s) => s.currentPath),
		);
		// But the OUTPUTS moved — a re-run must never overwrite the template's
		// previous outputs even when the inputs are identical.
		expect(result.outputPrefix).toBe(`runs/2026-08-17/${UUID}`);
	});

	it("partial substitution touches exactly the named site", () => {
		const template = encodingPlanSchema.parse(body());
		const sites = templateSourceSites(template);
		expect(sites.length).toBe(2);
		const [first, second] = sites as [
			(typeof sites)[number],
			(typeof sites)[number],
		];
		const result = instantiateTemplatePlan({
			presetBody: body(),
			sources: { [first.siteId]: { objectKey: "new/source.mov" } },
			...base,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		const after = templateSourceSites(result.plan);
		expect(after.find((s) => s.siteId === first.siteId)?.currentPath).toBe(
			"new/source.mov",
		);
		expect(after.find((s) => s.siteId === second.siteId)?.currentPath).toBe(
			second.currentPath,
		);
	});

	it("an input move applies bucket+credential to the INPUT when providers agree", () => {
		const template = encodingPlanSchema.parse(body());
		const sites = templateSourceSites(template);
		const sources = Object.fromEntries(
			sites.map((s) => [
				s.siteId,
				{
					objectKey: `moved/${s.siteId}.mov`,
					bucket: "other-bucket",
					credentialId: "11111111-2222-4333-8444-555555555555",
				},
			]),
		);
		const result = instantiateTemplatePlan({
			presetBody: body(),
			sources,
			...base,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		const movedInputKeys = new Set(sites.map((s) => s.inputKey));
		for (const inp of result.plan.inputs) {
			if (movedInputKeys.has(inp.key)) {
				// toMatchObject, not property reads: the input union includes
				// bucket-less kinds (HTTPS), and a moved input MUST be bucket-bearing —
				// a missing field fails the match rather than failing to compile.
				expect(inp).toMatchObject({
					bucket: "other-bucket",
					credentialId: "11111111-2222-4333-8444-555555555555",
				});
			}
		}
	});

	it("DISAGREEING moves on a shared input are a named refusal, not a guess", () => {
		const template = encodingPlanSchema.parse(body());
		const sites = templateSourceSites(template);
		const shared = sites.filter(
			(s) => s.inputKey === (sites[0] as (typeof sites)[number]).inputKey,
		);
		// This fixture's two sites share one input — the conflict shape exists.
		expect(shared.length).toBe(2);
		const [a, b] = shared as [(typeof sites)[number], (typeof sites)[number]];
		const result = instantiateTemplatePlan({
			presetBody: body(),
			sources: {
				[a.siteId]: {
					objectKey: "x.mov",
					bucket: "bucket-one",
					credentialId: "11111111-2222-4333-8444-555555555555",
				},
				[b.siteId]: {
					objectKey: "y.mov",
					bucket: "bucket-two",
					credentialId: "11111111-2222-4333-8444-555555555555",
				},
			},
			...base,
		});
		expect(result.ok).toBe(false);
		if (result.ok) {
			return;
		}
		expect(result.issues[0]?.code).toBe("SHARED_INPUT_CONFLICT");
		expect(result.issues[0]?.message).toContain(a.inputKey);
	});

	it("a move onto a kind with no bucket+credentialId pair is INPUT_KIND_NOT_MOVABLE, by NAME (review-109pr1 I1)", () => {
		// The Azure fixture's input carries container+credentialId, not
		// bucket+credentialId; the HTTPS Dolby fixture's input carries host
		// only. Before I1 both were refused by an incidental strict-zod
		// REPARSE_FAILED ("Unrecognized key") — real refusals, wrong name.
		for (const fixture of [
			"fixed-bitrate-dash-hls-streamcondition-on-azure",
			"dolby-dv-atmos-adm-https",
		]) {
			const raw = JSON.parse(
				readFileSync(join(dir, `${fixture}.plan.json`), "utf8"),
			);
			const sites = templateSourceSites(encodingPlanSchema.parse(raw));
			const first = sites[0] as (typeof sites)[number];
			const result = instantiateTemplatePlan({
				presetBody: raw,
				sources: {
					[first.siteId]: {
						objectKey: "moved/in.mov",
						bucket: "other-bucket",
						credentialId: "11111111-2222-4333-8444-555555555555",
					},
				},
				...base,
			});
			expect(result.ok).toBe(false);
			if (result.ok) {
				return;
			}
			expect(result.issues[0]?.code).toBe("INPUT_KIND_NOT_MOVABLE");
			expect(result.issues[0]?.message).toMatch(/cannot be moved/);
		}
	});

	it("bucket without credentialId (or vice versa) is INCOMPLETE_INPUT_MOVE — an input moves whole", () => {
		const sites = templateSourceSites(encodingPlanSchema.parse(body()));
		const first = sites[0] as (typeof sites)[number];
		const result = instantiateTemplatePlan({
			presetBody: body(),
			sources: {
				[first.siteId]: { objectKey: "x.mov", bucket: "only-bucket" },
			},
			...base,
		});
		expect(result.ok).toBe(false);
		if (result.ok) {
			return;
		}
		// review-109pr1 I2: its own code — the UI branches on codes, and this
		// is not a disagreement between sites.
		expect(result.issues[0]?.code).toBe("INCOMPLETE_INPUT_MOVE");
	});

	it("an unknown siteId is refused BY NAME — the ask-list is the contract", () => {
		const result = instantiateTemplatePlan({
			presetBody: body(),
			sources: { "no-such-site": { objectKey: "x.mov" } },
			...base,
		});
		expect(result.ok).toBe(false);
		if (result.ok) {
			return;
		}
		expect(result.issues[0]?.code).toBe("UNKNOWN_SITE");
		expect(result.issues[0]?.message).toContain("no-such-site");
	});

	it("an EMPTY rendered output prefix is refused — the #87 overwrite rule", () => {
		const result = instantiateTemplatePlan({
			presetBody: body(),
			...base,
			outputPrefixTemplate: "{ext}",
			// {ext} of a path with no extension renders "" — the refusal must
			// fire on the RENDERED value, not the template text.
			sources: {
				[(
					templateSourceSites(
						encodingPlanSchema.parse(body()),
					)[0] as TemplateSite
				).siteId]: { objectKey: "no-extension-source" },
			},
		});
		expect(result.ok).toBe(false);
		if (result.ok) {
			return;
		}
		expect(result.issues[0]?.code).toBe("EMPTY_OUTPUT_PREFIX");
	});

	it("a non-plan body is refused before anything else", () => {
		const result = instantiateTemplatePlan({
			presetBody: { not: "a plan" },
			...base,
		});
		expect(result.ok).toBe(false);
		if (result.ok) {
			return;
		}
		expect(result.issues[0]?.code).toBe("NOT_A_PLAN");
	});
});

describe("renderTemplateOutputPrefix — token contract", () => {
	it("renders the five tokens and leaves unknown ones verbatim", () => {
		const rendered = renderTemplateOutputPrefix(
			"{template}/{date}/{uuid}/{basename}.{ext}/{rule}",
			{
				objectKey: "in/master File.MOV",
				templateName: "daily",
				now: NOW,
				uuid: UUID,
			},
		);
		// {rule} is the WATCH renderer's token — here it stays verbatim, the
		// same unknown-token contract the watch renderer documents.
		expect(rendered).toBe(`daily/2026-08-17/${UUID}/master File.mov/{rule}`);
	});

	it("collapses duplicate slashes and trims the edges", () => {
		expect(
			renderTemplateOutputPrefix("/a//{date}///b/", {
				objectKey: "x.mp4",
				templateName: "t",
				now: NOW,
				uuid: UUID,
			}),
		).toBe("a/2026-08-17/b");
	});
});

type TemplateSite = ReturnType<typeof templateSourceSites>[number];
