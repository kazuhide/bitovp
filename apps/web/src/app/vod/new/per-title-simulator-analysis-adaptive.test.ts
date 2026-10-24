import type { PerTitleGoal } from "@bitovp/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	applyPerTitleAdvice,
	applySelectedPerTitleAdvice,
	hasPerTitleEvaluationCountEvidence,
} from "./per-title-simulator-advice";
import { perTitleAdvicePreview } from "./per-title-simulator-advice-preview-model";
import {
	analyzePerTitleSettings,
	perTitleAnalysisContextKey,
} from "./per-title-simulator-analysis";
import { adaptiveCountSatisfied } from "./per-title-simulator-analysis-adaptive";
import { assessPerTitleOrdinaryCap } from "./per-title-simulator-analysis-ordinary-cap";
import { tunePerTitleSettings } from "./per-title-simulator-tuning";

const injected = vi.hoisted(() => ({ goals: [] as PerTitleGoal[] }));
vi.mock("./per-title-simulator-analysis-candidates", async (load) => {
	const actual =
		await load<typeof import("./per-title-simulator-analysis-candidates")>();
	return {
		...actual,
		perTitleAnalysisCandidates: (
			...args: Parameters<typeof actual.perTitleAnalysisCandidates>
		) => [...actual.perTitleAnalysisCandidates(...args), ...injected.goals],
	};
});
afterEach(() => {
	injected.goals = [];
});

function ordinary(
	codec: PerTitleGoal["codec"] = "H264",
	kind: "exact" | "maximum" = "maximum",
): PerTitleGoal {
	return {
		strategy: "count",
		codec,
		minBitrate: 300_000,
		maxBitrate: 4_000_000,
		minBitrateStepSize: 2.128663656502157,
		maxBitrateStepSize: 2.1286666666666667,
		countPolicy: { kind, count: 4 },
		rows: [],
		autoRepresentations: {},
		automaticTemplates: [{ id: "ordinary" }],
		...(codec === "H265V2"
			? { targetQualityQp: 19 }
			: { targetQualityCrf: 18 }),
	};
}
const fields = (
	advice: ReturnType<typeof analyzePerTitleSettings>["advice"][number],
) =>
	advice.changes.map(({ scope, key, rowId }) => ({
		scope,
		key,
		...(rowId === undefined ? {} : { rowId }),
	}));
const quality = (goal: PerTitleGoal) => [
	goal.targetQualityCrf,
	goal.targetQualityQp,
	goal.complexityFactor,
	goal.resolutionScaleFactor,
	goal.codecMinBitrateFactor,
	goal.codecMaxBitrateFactor,
	goal.codecBufsizeFactor,
];

describe("one adaptive Per-Title evaluation", () => {
	for (const codec of ["H264", "H265", "H265V2", "VP9", "AV1"] as const)
		for (const kind of ["exact", "maximum"] as const) {
			it(`repairs count and cap permission together for ${codec} ${kind}`, () => {
				const goal = ordinary(codec, kind),
					before = structuredClone(goal);
				const options = {
					referenceGoal: goal,
					contextKey: perTitleAnalysisContextKey("adaptive"),
				};
				const result = analyzePerTitleSettings(goal, "adaptive", options);
				expect(result.decision.status).toBe("proposal");
				expect(result.advice).toHaveLength(1);
				const advice = result.advice[0];
				if (!advice) throw new Error("Missing checked adaptive advice");
				const selected = fields(advice);
				const full = applyPerTitleAdvice(goal, advice, options);
				const subset = applySelectedPerTitleAdvice(
					goal,
					advice,
					selected,
					options,
				);
				expect(full).not.toBeNull();
				expect(subset).not.toBeNull();
				if (!full || !subset)
					throw new Error("Checked advice could not be adopted");
				for (const adopted of [full, subset]) {
					const resolved = tunePerTitleSettings(adopted, goal);
					expect(resolved.proposal.api).toEqual(advice.proposal.api);
					expect(adopted.countPolicy).toEqual(goal.countPolicy);
					expect([adopted.minBitrate, adopted.maxBitrate]).toEqual([
						goal.minBitrate,
						goal.maxBitrate,
					]);
					expect(adopted.automaticTemplates).toEqual(goal.automaticTemplates);
					expect(quality(adopted)).toEqual(quality(goal));
					expect(
						hasPerTitleEvaluationCountEvidence(
							resolved.goal,
							resolved.proposal,
						),
					).toBe(true);
					expect(
						assessPerTitleOrdinaryCap(resolved.goal, resolved.proposal).status,
					).toBe("permitted");
					expect(resolved.proposal.countGuarantee).toBe(false);
					expect(
						analyzePerTitleSettings(adopted, "adaptive", options).decision
							.status,
					).toBe("keep-current");
				}
				const keep = perTitleAdvicePreview(
					goal,
					advice,
					{ selected: [], kept: selected },
					options,
				);
				expect(keep.status).toBe("ready");
				expect(keep.after?.api).toEqual(
					tunePerTitleSettings(goal, goal).proposal.api,
				);
				expect(
					applyPerTitleAdvice(goal, advice, {
						...options,
						contextKey: "analysis:cap",
					}),
				).toBeNull();
				expect(
					applyPerTitleAdvice(
						{ ...goal, maxBitrate: 5_000_000 },
						advice,
						options,
					),
				).toBeNull();
				expect(goal).toEqual(before);
			});
		}

	it("keeps an already compatible maximum without making it exact", () => {
		const goal = {
			...ordinary(),
			minBitrateStepSize: 2,
			maxBitrateStepSize: 2.5,
		};
		const result = analyzePerTitleSettings(goal, "adaptive");
		expect(result.decision.status).toBe("keep-current");
		expect(result.advice).toEqual([]);
		expect(result.ordinaryCap.status).toBe("permitted");
		expect(goal.countPolicy).toEqual({ kind: "maximum", count: 4 });
		expect(result.quality.status).toBe("requires-media");
	});

	it("checks unrestricted ordinary spacing without inventing a count requirement", () => {
		const goal: PerTitleGoal = {
			...ordinary(),
			strategy: "automatic",
			countPolicy: { kind: "unrestricted" },
			minBitrateStepSize: 1.5,
			maxBitrateStepSize: 1.9,
		};
		const before = structuredClone(goal),
			result = analyzePerTitleSettings(goal, "adaptive");
		expect(result.decision.status).toBe("keep-current");
		expect(result.advice).toEqual([]);
		expect(result.ordinaryCap.status).toBe("permitted");
		expect(result.reach.status).toBe("unknown");
		expect(result.quality.status).toBe("requires-media");
		expect(goal).toEqual(before);
	});

	it("explains a held spacing barrier and recalculates after release", () => {
		const goal = ordinary(),
			before = structuredClone(goal);
		const options = {
			referenceGoal: goal,
			protectedFields: [
				{ scope: "global" as const, key: "maxBitrateStepSize" },
			],
		};
		const held = analyzePerTitleSettings(goal, "adaptive", options);
		expect(held.advice).toEqual([]);
		expect(held.decision.status).not.toBe("keep-current");
		expect(held.relaxation?.fields).toContainEqual({
			scope: "global",
			key: "maxBitrateStepSize",
		});
		const released = analyzePerTitleSettings(goal, "adaptive", {
			referenceGoal: goal,
			protectedFields: [],
		});
		expect(released.advice).toHaveLength(1);
		expect(goal).toEqual(before);
	});

	it("keeps unselected raw Auto bounds while checking the resolved API", () => {
		const source = ordinary();
		const goal: PerTitleGoal = {
			...source,
			adjustments: {
				global: { maxBitrate: { mode: "auto", method: "proportional" } },
			},
		};
		const reference = { ...source, maxBitrate: 6_000_000 };
		const options = {
			referenceGoal: reference,
			contextKey: perTitleAnalysisContextKey("adaptive"),
		};
		const result = analyzePerTitleSettings(goal, "adaptive", options),
			advice = result.advice[0];
		expect(result.advice).toHaveLength(1);
		if (!advice) throw new Error("Missing normalized Auto advice");
		for (const adopted of [
			applyPerTitleAdvice(goal, advice, options),
			applySelectedPerTitleAdvice(goal, advice, fields(advice), options),
		]) {
			expect(adopted?.maxBitrate).toBe(4_000_000);
			if (!adopted) throw new Error("Missing Auto adoption");
			const resolved = tunePerTitleSettings(adopted, reference);
			expect(resolved.proposal.api.global.maxBitrate).toBe(6_000_000);
			expect(
				assessPerTitleOrdinaryCap(resolved.goal, resolved.proposal).status,
			).toBe("permitted");
			expect(adopted.adjustments?.global?.maxBitrate).toEqual(
				goal.adjustments?.global?.maxBitrate,
			);
		}
	});

	it("does not label a one-point witness as a maximum-one requirement", () => {
		const goal = {
			...ordinary(),
			minBitrateStepSize: 20,
			maxBitrateStepSize: 20,
		};
		const result = analyzePerTitleSettings(goal, "adaptive", {
			protectedFields: [{ scope: "global", key: "minBitrateStepSize" }],
		});
		expect(result.advice).toEqual([]);
		expect(result.decision.status).not.toBe("keep-current");
		const finding = result.findings.find(
			(item) => item.code === "ordinary-cap-spacing-blocked",
		);
		expect(finding?.message.en).toContain("maximum of 4");
		expect(finding?.message.en).not.toContain("One integer placement starts");
	});

	it("rejects a quality-changing candidate even when its spacing passes", () => {
		const goal = {
			...ordinary(),
			minBitrateStepSize: 1.5,
			maxBitrateStepSize: 1.9,
		};
		injected.goals = [
			{
				...goal,
				minBitrateStepSize: 2,
				maxBitrateStepSize: 2.5,
				targetQualityCrf: 22,
			},
		];
		const result = analyzePerTitleSettings(goal, "adaptive");
		expect(
			result.search.rejected["adaptive-quality-or-role-change"],
		).toBeGreaterThan(0);
		for (const advice of result.advice)
			expect(quality(advice.goal)).toEqual(quality(goal));
	});

	it("repairs unrestricted spacing without adding a count policy", () => {
		const goal: PerTitleGoal = {
			...ordinary(),
			strategy: "automatic",
			countPolicy: { kind: "unrestricted" },
			minBitrateStepSize: 2,
			maxBitrateStepSize: 2,
		};
		const options = {
			referenceGoal: goal,
			contextKey: perTitleAnalysisContextKey("adaptive"),
		};
		const result = analyzePerTitleSettings(goal, "adaptive", options),
			advice = result.advice[0];
		expect(result.advice).toHaveLength(1);
		if (!advice) throw new Error("Missing unrestricted spacing repair");
		const adopted = applyPerTitleAdvice(goal, advice, options);
		expect(adopted?.countPolicy).toEqual({ kind: "unrestricted" });
		if (!adopted) throw new Error("Missing unrestricted adoption");
		expect(
			analyzePerTitleSettings(adopted, "adaptive", options).decision.status,
		).toBe("keep-current");
		expect(tunePerTitleSettings(adopted, goal).proposal.countGuarantee).toBe(
			false,
		);
	});

	it("does not treat a partial count repair as a simultaneous cap repair", () => {
		const goal = {
			...ordinary(),
			minBitrateStepSize: 1.5,
			maxBitrateStepSize: 1.9,
		};
		const options = {
			referenceGoal: goal,
			contextKey: perTitleAnalysisContextKey("adaptive"),
		};
		const result = analyzePerTitleSettings(goal, "adaptive", options),
			advice = result.advice[0];
		expect(result.advice).toHaveLength(1);
		if (!advice) throw new Error("Missing joint count/cap repair");
		expect(fields(advice).length).toBeGreaterThan(1);
		const onlyMinimum = fields(advice).filter(
			(field) => field.key === "minBitrateStepSize",
		);
		expect(onlyMinimum).toHaveLength(1);
		const partialGoal = applySelectedPerTitleAdvice(
			goal,
			advice,
			onlyMinimum,
			options,
		);
		expect(partialGoal).not.toBeNull();
		if (!partialGoal) throw new Error("Missing editable partial draft");
		expect(partialGoal.maxBitrateStepSize).toBe(1.9);
		const actual = tunePerTitleSettings(partialGoal, goal).proposal;
		expect(actual.api.global.maxBitrateStepSize).toBe(1.9);
		expect(actual.status).toBe("conflict");
		expect(actual.applicable).toBe(false);
		const partial = perTitleAdvicePreview(
			goal,
			advice,
			{ selected: onlyMinimum, kept: [] },
			options,
		);
		expect(partial.status).toBe("conflict");
		expect(partial.after?.api).toEqual(actual.api);
		const reevaluated = analyzePerTitleSettings(partialGoal, "adaptive", {
			...options,
			protectedFields: onlyMinimum,
		});
		expect(reevaluated.decision.status).toBe("proposal");
		expect(reevaluated.advice).toHaveLength(1);
		expect(reevaluated.advice[0]?.goal.minBitrateStepSize).toBe(
			partialGoal.minBitrateStepSize,
		);
	});

	function mixed(): PerTitleGoal {
		return {
			strategy: "fixed-ranges",
			codec: "H264",
			minBitrate: 150_000,
			maxBitrate: 4_800_000,
			minBitrateStepSize: 1.5,
			maxBitrateStepSize: 4,
			countPolicy: { kind: "exact", count: 6 },
			autoRepresentations: false,
			targetQualityCrf: 18,
			fixedResolutionAndBitrateConfiguration: {
				forcedRenditionAboveHighestFixedRepresentation: 1,
				forcedRenditionAboveHighestFixedRepresentationFactor: 1.2,
				forcedRenditionAboveHighestFixedRepresentationCalculationMode:
					"LAST_CALCULATED_BITRATE",
			},
			rows: [
				[240, 260_000, 350_000],
				[240, 530_000, 700_000],
				[720, 1_060_000, 1_400_000],
				[960, 2_120_000, 2_800_000],
			].map(([height, minimum, maximum], index) => ({
				id: `fixed-${index}`,
				height: height as number,
				minBitrate: minimum,
				maxBitrate: maximum,
				bitrateSelectionMode: "COMPLEXITY_RANGE",
				lowComplexityBoundaryForMaxBitrate: 2_544_000,
				highComplexityBoundaryForMaxBitrate: 4_800_000,
			})),
			automaticTemplates: [
				{ id: "lower", height: 120 },
				{ id: "upper-a", height: 1280 },
				{ id: "upper-b", height: 1600 },
			],
		};
	}

	it("accepts a mixed count only under its recomputed, unmeasured source certificate", () => {
		const goal = mixed(),
			resolved = tunePerTitleSettings(goal, goal);
		expect(adaptiveCountSatisfied(resolved.goal, resolved.proposal)).toBe(true);
		expect(analyzePerTitleSettings(goal, "adaptive").decision.status).toBe(
			"keep-current",
		);
		expect(resolved.proposal.countGuarantee).toBe(false);
		const stale = structuredClone(resolved.proposal);
		const certificate = stale.derivation?.constraints?.conditionalModel;
		if (!certificate) throw new Error("Missing mixed source certificate");
		certificate.sourceConditions.lowerProbe.maximum++;
		expect(adaptiveCountSatisfied(resolved.goal, stale)).toBe(false);
		delete stale.derivation?.constraints?.conditionalModel;
		expect(adaptiveCountSatisfied(resolved.goal, stale)).toBe(false);
	});

	it("does not certify a known invalid mixed source from its declared six roles", () => {
		const goal = { ...mixed(), inputHeight: 500 };
		const result = analyzePerTitleSettings(goal, "adaptive");
		expect(result.decision.status).not.toBe("keep-current");
		expect(result.advice).toEqual([]);
	});

	it("retains an unverified Wizard flag while offering unrestricted mixed configuration repair", () => {
		const goal: PerTitleGoal = {
			...mixed(),
			countPolicy: { kind: "unrestricted" },
			maxBitrateStepSize: 1.6,
		};
		const options = {
			referenceGoal: goal,
			contextKey: perTitleAnalysisContextKey("adaptive"),
		};
		const result = analyzePerTitleSettings(goal, "adaptive", options),
			advice = result.advice[0];
		expect(result.decision.status).toBe("proposal");
		expect(result.advice).toHaveLength(1);
		if (!advice) throw new Error("Missing unrestricted mixed spacing repair");
		expect(advice.goal.countPolicy).toEqual({ kind: "unrestricted" });
		expect(advice.proposal.applicable).toBe(false);
		expect(advice.proposal.countGuarantee).toBe(false);
		expect(quality(advice.goal)).toEqual(quality(goal));
		const adopted = applyPerTitleAdvice(goal, advice, options);
		expect(adopted).not.toBeNull();
		if (!adopted) throw new Error("Missing simulator draft adoption");
		expect(tunePerTitleSettings(adopted, goal).proposal.applicable).toBe(false);
		expect(
			analyzePerTitleSettings(adopted, "adaptive", options).decision.status,
		).toBe("keep-current");
	});

	it("does not call a one-output count repair a cap-permission repair", () => {
		const goal: PerTitleGoal = {
			...ordinary(),
			countPolicy: { kind: "maximum", count: 1 },
		};
		const result = analyzePerTitleSettings(goal, "adaptive");
		expect(result.decision.status).not.toBe("keep-current");
		expect(result.advice).toEqual([]);
	});
});
