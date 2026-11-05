import { describe, expect, it } from "vitest";
import {
	evaluateQcGate,
	qcGateRuleSchema,
	type RenditionPooled,
} from "./qc-gate";
import { planQcSchema } from "./schema";

const banding = (max: number) => ({
	mean: max / 2,
	min: 0,
	max,
	frameCount: 2,
	durationSeconds: 1,
});
const rule = (severity: "WARN" | "FAIL" = "FAIL", lte = 5) =>
	qcGateRuleSchema.parse({
		metric: "CAMBI_MAX",
		scope: "PER_RENDITION",
		lte,
		severity,
	});

describe("independent banding quality control", () => {
	it("accepts banding without VMAF while retaining absent-band behavior", () => {
		expect(planQcSchema.parse({ vmaf: false, banding: true })).toMatchObject({
			vmaf: false,
			banding: true,
		});
		expect(planQcSchema.parse({ vmaf: false })).not.toHaveProperty("banding");
	});

	it("keeps historical lower-bound rules byte-identical", () => {
		const previous = { metric: "VMAF_MEAN", scope: "OVERALL", gte: 85 };
		expect(qcGateRuleSchema.parse(previous)).toEqual(previous);
	});

	it("accepts an upper CAMBI bound without inventing a 24 or 100 ceiling", () => {
		expect(rule("FAIL", 250)).toMatchObject({ lte: 250 });
		for (const lte of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(() => rule("FAIL", lte)).toThrow();
		}
		expect(() => qcGateRuleSchema.parse({ ...rule(), gte: 5 })).toThrow();
		expect(() =>
			qcGateRuleSchema.parse({ ...rule(), scope: "OVERALL" }),
		).toThrow();
	});

	it("passes equality and fails only a measured FAIL threshold breach", () => {
		const gate = { rules: [rule()], onFail: "MARK_ONLY" as const };
		expect(
			evaluateQcGate(gate, [{ rendition: "r", banding: banding(5) }], ["r"])
				.pass,
		).toBe(true);
		expect(
			evaluateQcGate(gate, [{ rendition: "r", banding: banding(5.01) }], ["r"])
				.pass,
		).toBe(false);
	});

	it("reports a warning breach without failing delivery", () => {
		const verdict = evaluateQcGate(
			{ rules: [rule("WARN")], onFail: "BLOCK_MANIFESTS" },
			[{ rendition: "r", banding: banding(6) }],
			["r"],
		);
		expect(verdict.pass).toBe(true);
		expect(verdict.ruleResults[0]).toMatchObject({
			pass: false,
			actuals: [{ rendition: "r", value: 6, pass: false }],
		});
	});

	it("never turns missing or invalid evidence into a successful warning gate", () => {
		const gate = { rules: [rule("WARN")], onFail: "BLOCK_MANIFESTS" as const };
		for (const rows of [
			[],
			[{ rendition: "r" }],
			[{ rendition: "r", banding: banding(Number.NaN) }],
			[{ rendition: "r", banding: banding(-1) }],
			[{ rendition: "r", banding: { ...banding(3), frameCount: 0 } }],
		] satisfies RenditionPooled[][]) {
			const verdict = evaluateQcGate(gate, rows, ["r"]);
			expect(verdict.pass).toBe(false);
			expect(verdict.ruleResults[0]?.actuals[0]?.value).toBeNull();
		}
	});

	it("holds every per-title variant and every promised rendition to the bar", () => {
		const gate = { rules: [rule()], onFail: "BLOCK_MANIFESTS" as const };
		const rows = [
			{ rendition: "r", variant: "a", banding: banding(1) },
			{ rendition: "r", variant: "b", banding: banding(6) },
		];
		const verdict = evaluateQcGate(gate, rows, ["r", "missing"]);
		expect(verdict.pass).toBe(false);
		expect(verdict.ruleResults[0]?.actuals).toEqual([
			{ rendition: "r", variant: "a", value: 1, pass: true },
			{ rendition: "r", variant: "b", value: 6, pass: false },
			{ rendition: "missing", value: null, pass: false },
		]);
	});
});
