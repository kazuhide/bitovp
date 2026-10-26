import type { PerTitleGoal } from "@bitovp/core";
import { describe, expect, it } from "vitest";
import {
	applyPerTitleAdvice,
	applySelectedPerTitleAdvice,
	createPerTitleEvaluationAdvice,
	type PerTitleAdviceOptions,
} from "./per-title-simulator-advice";
import { perTitleAdvicePreview } from "./per-title-simulator-advice-preview-model";
import { analyzePerTitleSettings } from "./per-title-simulator-analysis";
import { assessPerTitleValidity } from "./per-title-simulator-analysis-validity";
import { tunePerTitleSettings } from "./per-title-simulator-tuning";

const goal = (): PerTitleGoal => ({
	strategy: "fixed-ranges",
	codec: "H264",
	minBitrate: 200_000,
	maxBitrate: 4_800_000,
	minBitrateStepSize: 1.5,
	maxBitrateStepSize: 4,
	countPolicy: { kind: "exact", count: 4 },
	autoRepresentations: false,
	fixedResolutionAndBitrateConfiguration: {
		forcedRenditionAboveHighestFixedRepresentation: 1,
		forcedRenditionAboveHighestFixedRepresentationFactor: 1.2,
		forcedRenditionAboveHighestFixedRepresentationCalculationMode:
			"LAST_CALCULATED_BITRATE",
	},
	rows: [
		{ id: "first", height: 400, minBitrate: 400_000, maxBitrate: 600_000 },
		{ id: "last", height: 800, minBitrate: 1_400_000, maxBitrate: 1_800_000 },
	].map((row) => ({
		...row,
		bitrateSelectionMode: "COMPLEXITY_RANGE",
		lowComplexityBoundaryForMaxBitrate: 1_700_000,
		highComplexityBoundaryForMaxBitrate: 3_200_000,
	})),
	automaticTemplates: [
		{ id: "bottom", height: 200 },
		{ id: "upper-a", height: 1000 },
		{ id: "upper-b", height: 1200 },
	],
});

const repaired = (current: PerTitleGoal): PerTitleGoal => ({
	...current,
	rows: current.rows?.map((row) =>
		row.id === "last"
			? {
					...row,
					maxBitrate: 2_230_000,
					highComplexityBoundaryForMaxBitrate: current.maxBitrate,
				}
			: row,
	),
});

describe("a declared single upper output is an adoption requirement", () => {
	it("reports an error while the current settings permit two upper outputs", () => {
		const current = goal();
		const result = assessPerTitleValidity(
			current,
			tunePerTitleSettings(current, current).proposal,
		);
		expect(result).toContainEqual(
			expect.objectContaining({
				code: "upper-output-limit",
				severity: "conflict",
			}),
		);
	});

	it("does not certify a changed configuration that still permits two upper outputs", () => {
		const current = goal();
		const unsafe = { ...current, maxBitrateStepSize: 5 };
		expect(createPerTitleEvaluationAdvice(current, unsafe)).toBeNull();
	});

	it("rechecks the requirement when a full recommendation is adopted", () => {
		const current = goal();
		const advice = createPerTitleEvaluationAdvice(current, repaired(current));
		if (!advice) throw new Error("Expected the complete upper-output repair.");
		const unsafe = { ...current, maxBitrateStepSize: 5 };
		expect(
			applyPerTitleAdvice(current, {
				...advice,
				goal: unsafe,
				proposal: tunePerTitleSettings(unsafe, unsafe).proposal,
			}),
		).toBeNull();
	});

	it("keeps partial edits available as conflicting drafts for reevaluation", () => {
		const current = goal();
		const advice = createPerTitleEvaluationAdvice(current, repaired(current));
		if (!advice) throw new Error("Expected the complete upper-output repair.");
		const selected = [
			{
				scope: "stream" as const,
				rowId: "last",
				key: "highComplexityBoundaryForMaxBitrate",
			},
		];
		const partial = applySelectedPerTitleAdvice(current, advice, selected);
		expect(partial).not.toBeNull();
		const preview = perTitleAdvicePreview(current, advice, {
			selected,
			kept: [],
		});
		expect(preview.status).toBe("conflict");
		expect(preview.mode).toBe("selected");
		expect(preview.after?.api).toEqual(
			tunePerTitleSettings(partial ?? current, partial ?? current).proposal.api,
		);
	});

	it("accepts the complete repair without changing input requirements", () => {
		const current = goal();
		const candidate = repaired(current);
		const snapshot = structuredClone(current);
		const advice = createPerTitleEvaluationAdvice(current, candidate);
		if (!advice) throw new Error("Expected the complete upper-output repair.");
		const adopted = applyPerTitleAdvice(current, advice);
		if (!adopted)
			throw new Error("Expected the complete repair to be adopted.");
		expect(tunePerTitleSettings(adopted, adopted).proposal.api).toEqual(
			tunePerTitleSettings(candidate, candidate).proposal.api,
		);
		expect(
			perTitleAdvicePreview(current, advice, { selected: [], kept: [] }).status,
		).toBe("ready");
		expect(current).toEqual(snapshot);
		expect(advice.goal.countPolicy).toEqual(current.countPolicy);
		expect(advice.goal.minBitrate).toBe(current.minBitrate);
		expect(advice.goal.maxBitrate).toBe(current.maxBitrate);
	});

	it.each([
		"cap",
		"bandwidth",
		"preserve",
		"count",
	] as const)("offers only upper-limit repairs under the %s objective", (intent) => {
		const current = goal();
		const result = analyzePerTitleSettings(current, intent);
		expect(result.findings).toContainEqual(
			expect.objectContaining({
				code: "upper-output-limit",
				severity: "conflict",
			}),
		);
		expect(result.advice.length).toBeGreaterThan(0);
		for (const advice of result.advice) {
			expect(
				assessPerTitleValidity(advice.goal, advice.proposal).filter((finding) =>
					finding.code.startsWith("upper-output-limit"),
				),
			).toEqual([]);
			expect(advice.goal.countPolicy).toEqual(current.countPolicy);
			expect(advice.explanation?.en).toContain("required 4 outputs");
			expect(advice.explanation?.ja).toContain("指定の 4 本");
			expect(advice.explanation?.en).toContain(
				"does not certify the total native count",
			);
			expect(advice.explanation?.ja).toContain(
				"総出力本数・解像度・画質は素材で確認",
			);
		}
	});

	it("retains held fields instead of bypassing the upper-output requirement", () => {
		const current = goal();
		const options: PerTitleAdviceOptions = {
			protectedFields: [
				{ scope: "global", key: "minBitrateStepSize" },
				{ scope: "global", key: "maxBitrateStepSize" },
				...(current.rows ?? []).flatMap((row) =>
					[
						"minBitrate",
						"maxBitrate",
						"lowComplexityBoundaryForMaxBitrate",
						"highComplexityBoundaryForMaxBitrate",
					].map((key) => ({ scope: "stream" as const, rowId: row.id, key })),
				),
			],
		};
		expect(analyzePerTitleSettings(current, "count", options).advice).toEqual(
			[],
		);
	});
});
