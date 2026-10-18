import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { compilePlan } from "./compiler";
import {
	checkDeliverySpec,
	DELIVERY_SPECS,
	deliverySpec,
	exportDeliveryPreset,
	importDeliveryPreset,
} from "./delivery-presets";
import { encodingPlanSchema } from "./schema";
import { planToEncodingTemplateYaml } from "./template";

/**
 * Delivery presets . Three layers, per the design's §8:
 *  - SELF-PINNING: every shipped spec satisfies its own plan, and the
 *    constraint COUNTS are pinned — removing a constraint row from a shipped
 *    spec fails here (the design's mutation bar), not in a review comment.
 *  - COMPILER + TEMPLATE gates: each shipped plan compiles and exports to
 *    template YAML (the C25 caveat's in-repo half; the LIVE-api half is the
 *    row's real-credential validation, blocked with everything else on the
 *    2026-08-14 start-1004 investigation).
 *  - The checker itself: eq/gte/lte/oneOf, and the unresolved-path rule — a
 *    path the plan dropped is a DEVIATION, never a silent pass.
 */

describe("shipped delivery specs", () => {
	it("ships exactly the two schema-supported specs (the other two are authoring-guide examples)", () => {
		expect(DELIVERY_SPECS.map((spec) => spec.id)).toEqual([
			"mezz-h264-1080p-50m",
			"mezz-h265-2160p",
		]);
	});

	it.each(
		DELIVERY_SPECS.map((spec) => [spec.id, spec] as const),
	)("%s satisfies its OWN plan (self-pinning rule)", (_id, spec) => {
		expect(checkDeliverySpec(spec.plan, spec)).toEqual([]);
	});

	it("pins each spec's constraint count — a dropped row is a broken spec", () => {
		// The design's mutation bar: deleting a constraint from a shipped spec
		// must fail a COUNT, not merely stop checking something silently.
		expect(
			Object.fromEntries(
				DELIVERY_SPECS.map((spec) => [spec.id, spec.constraints.length]),
			),
		).toEqual({
			"mezz-h264-1080p-50m": 9,
			// 6→7 (review-205 I1): the audio-codec row H265 was missing —
			// the sentence said AAC, the row checked only the rate.
			"mezz-h265-2160p": 7,
		});
	});

	it.each(
		DELIVERY_SPECS.map((spec) => [spec.id, spec] as const),
	)("%s compiles and exports to template YAML (in-repo C25 half)", (_id, spec) => {
		const ops = compilePlan(spec.plan);
		expect(ops.length).toBeGreaterThan(0);
		expect(ops.filter((op) => op.kind === "CREATE_MUXING_MP4")).toHaveLength(2);
		// No manifests on a file-delivery plan — nothing to start beyond
		// the encoding itself.
		expect(ops.some((op) => op.kind === "CREATE_MANIFEST_HLS")).toBe(false);
		const yaml = planToEncodingTemplateYaml(spec.plan);
		expect(() => parse(yaml)).not.toThrow();
		expect(parse(yaml)).toBeTruthy();
	});

	it("suggested gates are schema-valid and advisory-shaped", () => {
		for (const spec of DELIVERY_SPECS) {
			expect(spec.suggestedGate?.onFail).toBe("MARK_ONLY");
		}
	});

	it("deliverySpec() resolves ids and misses honestly", () => {
		expect(deliverySpec("mezz-h264-1080p-50m")?.name).toContain("H.264");
		expect(deliverySpec("nope")).toBeUndefined();
	});
});

describe("checkDeliverySpec", () => {
	const spec = {
		constraints: [
			{
				requirement: "codec",
				path: "renditions.0.codec",
				expect: { eq: "H264" },
			},
			{
				requirement: "bitrate window",
				path: "renditions.0.bitrate",
				expect: { gte: 10, lte: 20 },
			},
			{
				requirement: "container choice",
				path: "muxings.0.kind",
				expect: { oneOf: ["MP4", "TS"] },
			},
		],
	};

	it("passes a conforming plan and reports each miss with the found value", () => {
		expect(
			checkDeliverySpec(
				{
					renditions: [{ codec: "H264", bitrate: 15 }],
					muxings: [{ kind: "TS" }],
				},
				spec,
			),
		).toEqual([]);
		const deviations = checkDeliverySpec(
			{
				renditions: [{ codec: "H265", bitrate: 25 }],
				muxings: [{ kind: "WEBM" }],
			},
			spec,
		);
		expect(deviations).toHaveLength(3);
		expect(deviations[0]).toMatchObject({
			path: "renditions.0.codec",
			actual: "H265",
		});
	});

	it("an UNRESOLVED path is a deviation, never a pass (the unmeasured lesson)", () => {
		const deviations = checkDeliverySpec({}, spec);
		expect(deviations).toHaveLength(3);
		expect(deviations.every((d) => d.actual === undefined)).toBe(true);
	});

	it("a range constraint over a non-number fails rather than coercing", () => {
		expect(
			checkDeliverySpec(
				{
					renditions: [{ codec: "H264", bitrate: "15" }],
					muxings: [{ kind: "MP4" }],
				},
				spec,
			).some((d) => d.path === "renditions.0.bitrate"),
		).toBe(true);
	});
});

describe("import/export round-trip", () => {
	it("export → import is identity, with zero self-deviations for shipped specs", () => {
		for (const spec of DELIVERY_SPECS) {
			const result = importDeliveryPreset(exportDeliveryPreset(spec));
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.spec).toEqual(spec);
				expect(result.selfDeviations).toEqual([]);
			}
		}
	});

	it("rejects non-JSON, wrong formatVersion, missing fields, invalid plan", () => {
		expect(importDeliveryPreset("not json").ok).toBe(false);
		expect(importDeliveryPreset(JSON.stringify({ formatVersion: 2 })).ok).toBe(
			false,
		);
		expect(
			importDeliveryPreset(
				JSON.stringify({ formatVersion: 1, spec: { id: "x" } }),
			).ok,
		).toBe(false);
		const spec = DELIVERY_SPECS[0];
		if (!spec) {
			throw new Error("no shipped specs");
		}
		const badPlan = JSON.parse(exportDeliveryPreset(spec)) as {
			spec: { plan: Record<string, unknown> };
		};
		badPlan.spec.plan = { planVersion: 999 };
		const rejected = importDeliveryPreset(JSON.stringify(badPlan));
		expect(rejected.ok).toBe(false);
		if (!rejected.ok) {
			expect(rejected.error).toContain("Plan invalid");
		}
	});

	it("SELF-DEVIATIONS are reported, not rejected — silence is the failure mode", () => {
		const spec = DELIVERY_SPECS[0];
		if (!spec) {
			throw new Error("no shipped specs");
		}
		const loose = JSON.parse(exportDeliveryPreset(spec)) as {
			spec: { constraints: { expect: { eq?: unknown } }[] };
		};
		// Tighten a constraint the example plan no longer meets.
		const first = loose.spec.constraints[0];
		if (!first) {
			throw new Error("no constraints");
		}
		first.expect = { eq: "AV1" };
		const result = importDeliveryPreset(JSON.stringify(loose));
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.selfDeviations).toHaveLength(1);
			expect(result.selfDeviations[0]?.actual).toBe("H264");
		}
	});

	it("the exported file never carries a secret-shaped key (plans carry credential IDS only)", () => {
		for (const spec of DELIVERY_SPECS) {
			const text = exportDeliveryPreset(spec).toLowerCase();
			for (const needle of ["secret", "apikey", "password", "accesskey"]) {
				expect(text).not.toContain(needle);
			}
		}
	});

	it("an imported plan re-parses through the STRICT schema (no unknown-key smuggling)", () => {
		const spec = DELIVERY_SPECS[0];
		if (!spec) {
			throw new Error("no shipped specs");
		}
		const smuggle = JSON.parse(exportDeliveryPreset(spec)) as {
			spec: { plan: Record<string, unknown> };
		};
		smuggle.spec.plan.evil = { exfiltrate: true };
		expect(importDeliveryPreset(JSON.stringify(smuggle)).ok).toBe(false);
	});
});

describe("plan schema guard", () => {
	it("both shipped plans survive a strict re-parse of their JSON round-trip", () => {
		for (const spec of DELIVERY_SPECS) {
			const reparsed = encodingPlanSchema.parse(
				JSON.parse(JSON.stringify(spec.plan)),
			);
			expect(reparsed).toEqual(spec.plan);
		}
	});
});

describe("review-205 folds — the checker fails closed on author slips", () => {
	it("a DDPLUS audio master DEVIATES from the H265 spec (I1 — the codec row exists now)", () => {
		const spec = deliverySpec("mezz-h265-2160p");
		if (!spec) {
			throw new Error("shipped spec missing");
		}
		const plan = structuredClone(spec.plan) as {
			renditions: { codec: string }[];
		};
		const audio = plan.renditions[1];
		if (!audio) {
			throw new Error("audio rendition missing");
		}
		audio.codec = "DDPLUS";
		// Still a schema-valid plan — the reviewer's exact probe.
		expect(encodingPlanSchema.safeParse(plan).success).toBe(true);
		const deviations = checkDeliverySpec(plan, spec);
		expect(deviations.some((d) => d.path === "renditions.1.codec")).toBe(true);
	});

	it("a NON-FINITE gte/lte bound deviates instead of always passing (I4)", () => {
		const base = deliverySpec("mezz-h264-1080p-50m");
		if (!base) {
			throw new Error("shipped spec missing");
		}
		for (const bad of [Number.NaN, null, "45000000", {}]) {
			const spec = {
				...base,
				constraints: [
					{
						requirement: "poisoned bound",
						path: "renditions.0.bitrate",
						expect: { gte: bad as unknown as number },
					},
				],
			};
			expect(
				checkDeliverySpec(base.plan, spec).length,
				`gte=${JSON.stringify(bad)} must deviate`,
			).toBe(1);
		}
	});

	it("{eq: undefined} on an UNRESOLVED path deviates — absence is not expressible (I4)", () => {
		const base = deliverySpec("mezz-h264-1080p-50m");
		if (!base) {
			throw new Error("shipped spec missing");
		}
		const spec = {
			...base,
			constraints: [
				{
					requirement: "no such field",
					path: "muxings.0.fragmentDuration",
					expect: { eq: undefined as unknown as string },
				},
			],
		};
		expect(checkDeliverySpec(base.plan, spec).length).toBe(1);
	});

	it("a JSON __proto__ path segment MISSES, never walks the prototype (N8)", () => {
		const base = deliverySpec("mezz-h264-1080p-50m");
		if (!base) {
			throw new Error("shipped spec missing");
		}
		const spec = {
			...base,
			constraints: [
				{
					requirement: "prototype walk",
					path: "__proto__.constructor",
					expect: { eq: "anything" },
				},
			],
		};
		// Unresolved ⇒ deviation (the module's headline rule).
		expect(checkDeliverySpec(base.plan, spec).length).toBe(1);
	});
});

describe('review-205 I3 — import validates the WHOLE metadata, not just "is object"', () => {
	function fileWith(constraint: Record<string, unknown>): string {
		const base = deliverySpec("mezz-h264-1080p-50m");
		if (!base) {
			throw new Error("shipped spec missing");
		}
		const file = JSON.parse(exportDeliveryPreset(base)) as {
			spec: { constraints: unknown[] };
		};
		file.spec.constraints = [constraint];
		return JSON.stringify(file);
	}

	it("a SCALAR oneOf is rejected at import (it used to THROW out of satisfies → silent no-op)", () => {
		const result = importDeliveryPreset(
			fileWith({
				requirement: "codec",
				path: "renditions.0.codec",
				expect: { oneOf: "H264" },
			}),
		);
		expect(result.ok).toBe(false);
	});

	it('a QUOTED-number gte is rejected at import (it used to import "fine" then always pass)', () => {
		const result = importDeliveryPreset(
			fileWith({
				requirement: "bitrate",
				path: "renditions.0.bitrate",
				expect: { gte: "45000000" },
			}),
		);
		expect(result.ok).toBe(false);
	});

	it("a poisoned suggestedGate is rejected at import", () => {
		const base = deliverySpec("mezz-h264-1080p-50m");
		if (!base) {
			throw new Error("shipped spec missing");
		}
		const file = JSON.parse(exportDeliveryPreset(base)) as {
			spec: { suggestedGate?: unknown };
		};
		file.spec.suggestedGate = { rules: "all-of-them", onFail: "EXPLODE" };
		expect(importDeliveryPreset(JSON.stringify(file)).ok).toBe(false);
	});
});
