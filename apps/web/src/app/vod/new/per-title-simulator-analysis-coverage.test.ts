import {
	type PerTitleGoal,
	type PerTitleProposal,
	previewPerTitleOutput,
} from "@bitovp/core";
import { describe, expect, it } from "vitest";
import { buildPerTitleSetup } from "./per-title-guided-setup-model";
import {
	applyPerTitleAdvice,
	applySelectedPerTitleAdvice,
	createPerTitleEvaluationAdvice,
	hasPerTitleEvaluationCountEvidence,
	type PerTitleAdviceOptions,
} from "./per-title-simulator-advice";
import { perTitleAdvicePreview } from "./per-title-simulator-advice-preview-model";
import {
	analyzePerTitleSettings,
	type PerTitleAnalysisIntent,
	perTitleAnalysisContextKey,
} from "./per-title-simulator-analysis";
import { assessPerTitleCountStructure } from "./per-title-simulator-analysis-count";
import { assessPerTitleLadder } from "./per-title-simulator-analysis-ladder";
import { assessPerTitleReach } from "./per-title-simulator-analysis-reach";
import { assessPerTitleValidity } from "./per-title-simulator-analysis-validity";
import {
	initializePerTitleSettings,
	tunePerTitleSettings,
} from "./per-title-simulator-tuning";

const matrix = [
	["automatic", "cap", "repair"],
	["automatic", "bandwidth", "repair"],
	["automatic", "count", "repair"],
	["automatic", "preserve", "repair"],
	["count", "cap", "repair"],
	["count", "bandwidth", "repair"],
	["count", "count", "repair"],
	["count", "preserve", "repair"],
	["required-resolutions", "cap", "media-cap"],
	["required-resolutions", "bandwidth", "media-count"],
	["required-resolutions", "count", "media-count"],
	["required-resolutions", "preserve", "media-count"],
	["fixed-resolutions", "cap", "media-cap"],
	["fixed-resolutions", "bandwidth", "repair"],
	["fixed-resolutions", "count", "repair"],
	["fixed-resolutions", "preserve", "repair"],
	["fixed-ranges", "cap", "repair"],
	["fixed-ranges", "bandwidth", "repair"],
	["fixed-ranges", "count", "repair"],
	["fixed-ranges", "preserve", "repair"],
] as const;
const protectedQuality: PerTitleAdviceOptions = {
	protectedFields: [{ scope: "global", key: "targetQualityCrf" }],
};

function matrixGoal(strategy: PerTitleGoal["strategy"]): PerTitleGoal {
	const goal: PerTitleGoal = {
		strategy,
		codec: "H264",
		minBitrate: 100_000,
		maxBitrate: 4_000_000,
		minBitrateStepSize: 1.5,
		maxBitrateStepSize: 1.9,
		targetQualityCrf: 18,
		countPolicy: { kind: "exact", count: 3 },
	};
	if (strategy === "required-resolutions")
		return {
			...goal,
			rows: [{ id: "required", height: 720 }],
			automaticTemplates: [
				{ id: "lower", height: 180 },
				{ id: "upper", height: 1080 },
			],
		};
	if (strategy === "fixed-resolutions")
		return {
			...goal,
			autoRepresentations: false,
			rows: [360, 720, 1080].map((height, index) => ({
				id: `fixed-${index}`,
				height,
			})),
		};
	if (strategy === "fixed-ranges")
		return {
			...goal,
			autoRepresentations: false,
			rows: [200_000, 800_000, 3_200_000].map((bitrate, index) => ({
				id: `fixed-${index}`,
				height: [360, 720, 1080][index] ?? 720,
				minBitrate: bitrate,
				maxBitrate: bitrate,
				bitrateSelectionMode: "COMPLEXITY_RANGE",
				lowComplexityBoundaryForMaxBitrate: 200_000,
				highComplexityBoundaryForMaxBitrate: 4_000_000,
			})),
		};
	return goal;
}

function wizardGoal(strategy: PerTitleGoal["strategy"]): PerTitleGoal {
	const fixture = matrixGoal(strategy);
	const setup = buildPerTitleSetup({
		strategy,
		codec: fixture.codec,
		minBitrate: fixture.minBitrate,
		maxBitrate: fixture.maxBitrate,
		...(strategy === "automatic" ? {} : { count: 3 }),
		rows: (fixture.rows ?? []).map((row) => {
			if (row.height === undefined)
				throw new Error("Fixture height is required");
			return { ...row, height: row.height };
		}),
	});
	expect(setup.goal).not.toBeNull();
	if (!setup.goal) throw new Error("Expected a loadable guided setup.");
	// Preserve the wizard's explicit ordinary template through editor loading.
	return initializePerTitleSettings({
		...setup.goal,
		countPolicy: { kind: "exact", count: 3 },
		minBitrateStepSize: 1.5,
		maxBitrateStepSize: 1.9,
	});
}

function requirements(goal: PerTitleGoal) {
	return {
		strategy: goal.strategy,
		codec: goal.codec,
		minBitrate: goal.minBitrate,
		maxBitrate: goal.maxBitrate,
		countPolicy: goal.countPolicy,
		targetQualityCrf: goal.targetQualityCrf,
		rows: goal.rows?.map(({ id, height, width }) => ({ id, height, width })),
		automaticTemplates: goal.automaticTemplates,
	};
}

function checkAdoption(
	goal: PerTitleGoal,
	intent: PerTitleAnalysisIntent,
	result: ReturnType<typeof analyzePerTitleSettings>,
	options: PerTitleAdviceOptions = protectedQuality,
) {
	const context = {
		...options,
		contextKey: perTitleAnalysisContextKey(intent),
	};
	for (const advice of result.advice) {
		expect(requirements(advice.goal)).toEqual(requirements(goal));
		expect(advice.proposal.countGuarantee).toBe(false);
		const applied = applyPerTitleAdvice(goal, advice, context);
		expect(applied).not.toBeNull();
		if (!applied) throw new Error("Expected an adoptable adjustment.");
		expect(requirements(applied)).toEqual(requirements(goal));
		const normalized = tunePerTitleSettings(applied, applied).proposal;
		expect(normalized.api).toEqual(advice.proposal.api);
		expect(
			assessPerTitleValidity(applied, normalized).filter(
				(finding) => finding.severity === "conflict",
			),
		).toEqual([]);
		const rechecked = analyzePerTitleSettings(applied, intent, options);
		expect(
			rechecked.findings.some((finding) => finding.severity === "conflict"),
		).toBe(false);
		if (advice.proof === "model-count")
			expect(hasPerTitleEvaluationCountEvidence(applied, normalized)).toBe(
				true,
			);
	}
}

function checkOrdinaryCap(goal: PerTitleGoal, proposal: PerTitleProposal) {
	if (goal.countPolicy.kind === "unrestricted")
		throw new Error("This check requires an explicit placement budget.");
	const counts =
		goal.countPolicy.kind === "exact"
			? [goal.countPolicy.count]
			: Array.from({ length: goal.countPolicy.count }, (_, index) => index + 1);
	// Exhaust the permitted lengths independently of the binary assessment.
	const permitsCap = counts.some((count) => {
		const projection = previewPerTitleOutput(proposal, {
			countPolicy: { kind: "exact", count },
		});
		const slots = projection.rows.filter(({ kind }) => kind === "count-slot");
		return (
			projection.countProjection?.status === "conditional" &&
			slots.length === count &&
			slots.at(-1)?.maximumBitrate === goal.maxBitrate
		);
	});
	expect(permitsCap).toBe(true);
	if (goal.countPolicy.kind === "maximum")
		expect(
			previewPerTitleOutput(proposal, { countPolicy: goal.countPolicy })
				.countProjection,
		).toMatchObject({ kind: "maximum", reason: "maximum-only" });
}

describe("Per-Title evaluation coverage", () => {
	it.each(
		(
			[
				["unconstrained", [{ id: "ordinary-a" }, { id: "ordinary-b" }]],
				[
					"heights",
					[
						{ id: "ordinary-a", height: 360 },
						{ id: "ordinary-b", height: 1080 },
					],
				],
				[
					"dimensions",
					[
						{ id: "ordinary-a", height: 360, width: 640 },
						{ id: "ordinary-b", height: 1080, width: 1920 },
					],
				],
			] as const
		).flatMap(([label, templates]) =>
			(["adaptive", "cap", "bandwidth", "count", "preserve"] as const).map(
				(intent) => [label, intent, templates] as const,
			),
		),
	)("checks pure ordinary alternatives with %s under %s", (_label, intent, templates) => {
		const goal: PerTitleGoal = {
			...wizardGoal("automatic"),
			countPolicy: { kind: "exact", count: 6 },
			automaticTemplates: templates.map((template) => ({ ...template })),
		};
		const result = analyzePerTitleSettings(goal, intent, protectedQuality);
		expect(result.decision.status).toBe("proposal");
		expect(result.advice.length).toBeGreaterThan(0);
		for (const advice of result.advice) {
			expect(advice.proof).toBe("model-count");
			expect(advice.proposal.api.streams).toHaveLength(2);
			expect(
				advice.proposal.api.streams.every(
					(stream) => stream.mode === "PER_TITLE_TEMPLATE",
				),
			).toBe(true);
			expect(advice.goal.automaticTemplates).toEqual(goal.automaticTemplates);
			if (intent === "cap" || intent === "adaptive")
				checkOrdinaryCap(advice.goal, advice.proposal);
		}
		// This certifies spacing capacity, not which alternative or dimensions the
		// native encoder selects. Mixed fixed/ordinary settings stay conditional.
		checkAdoption(goal, intent, result);
	});

	it.each([
		1, 256,
	])("repairs the supported model boundary count %s without rewriting it", (count) => {
		const goal: PerTitleGoal = {
			...matrixGoal("count"),
			countPolicy: { kind: "exact", count },
		};
		const result = analyzePerTitleSettings(goal, "count", protectedQuality);
		expect(result.decision.status).toBe("proposal");
		expect(result.advice.length).toBeGreaterThan(0);
		expect(
			result.advice.every((advice) => advice.proof === "model-count"),
		).toBe(true);
		checkAdoption(goal, "count", result);
	});

	it("links a zero requested count to its requirement instead of adopting a repair", () => {
		const goal: PerTitleGoal = {
			...matrixGoal("count"),
			countPolicy: { kind: "exact", count: 0 },
		};
		const result = analyzePerTitleSettings(goal, "count", protectedQuality);
		expect(result.advice).toEqual([]);
		expect(result.decision.status).not.toBe("keep-current");
		expect(result.findings).toContainEqual(
			expect.objectContaining({
				code: "invalid-count-requirement",
				severity: "conflict",
				fields: [{ scope: "global", key: "countPolicy" }],
			}),
		);
		expect(goal.countPolicy).toEqual({ kind: "exact", count: 0 });
	});

	it("reports count 257 as a model limit with a requirement action rather than a provider maximum", () => {
		const goal: PerTitleGoal = {
			...matrixGoal("count"),
			countPolicy: { kind: "exact", count: 257 },
		};
		const result = analyzePerTitleSettings(goal, "count", protectedQuality);
		expect(result.advice).toEqual([]);
		expect(result.decision.status).toBe("inspect-only");
		expect(result.findings).toContainEqual(
			expect.objectContaining({
				code: "count-model-limit",
				severity: "warning",
				fields: [{ scope: "global", key: "countPolicy" }],
				message: {
					en: expect.stringMatching(/256.*model|model.*256/i),
					ja: expect.stringContaining("256"),
				},
			}),
		);
		const reason = result.findings.find(
			({ code }) => code === "count-model-limit",
		);
		expect(reason?.message.en).toMatch(/not.*provider/i);
		expect(reason?.message.en).toMatch(/reduce.*count|count.*reduce/i);
		expect(goal.countPolicy).toEqual({ kind: "exact", count: 257 });
	});

	it("keeps the greatest API bitrate integer when repairing count spacing", () => {
		const goal = { ...matrixGoal("count"), maxBitrate: 2_147_483_647 };
		const result = analyzePerTitleSettings(goal, "count", protectedQuality);
		expect(result.decision.status).toBe("proposal");
		expect(result.advice.length).toBeGreaterThan(0);
		expect(
			result.findings.some(
				({ code, fields }) =>
					code === "invalid-value" &&
					fields?.some(({ key }) => key === "maxBitrate"),
			),
		).toBe(false);
		checkAdoption(goal, "count", result);
	});

	it.each([
		["one", 1, 1.9, "non-increasing-spacing"],
		["below one", 0.5, 1.9, "non-increasing-spacing"],
		["zero", 0, 1.9, "invalid-value"],
		["not a number", Number.NaN, 1.9, "invalid-value"],
		["infinite", 1.5, Infinity, "invalid-value"],
		["reversed", 2, 1.5, "step-range-order"],
	] as const)("repairs %s spacing only with a valid, explicitly adoptable candidate", (_label, minimum, maximum, code) => {
		const goal: PerTitleGoal = {
			...matrixGoal("count"),
			minBitrateStepSize: minimum,
			maxBitrateStepSize: maximum,
		};
		const before = structuredClone(goal);
		const result = analyzePerTitleSettings(goal, "count", protectedQuality);
		expect(result.findings).toContainEqual(
			expect.objectContaining({
				code,
				fields: expect.arrayContaining([
					expect.objectContaining({ scope: "global" }),
				]),
			}),
		);
		expect(result.advice.length).toBeGreaterThan(0);
		for (const advice of result.advice) {
			const global = advice.proposal.api.global;
			expect(Number.isFinite(global.minBitrateStepSize)).toBe(true);
			expect(global.minBitrateStepSize).toBeGreaterThan(1);
			expect(Number.isFinite(global.maxBitrateStepSize)).toBe(true);
			expect(global.maxBitrateStepSize).toBeGreaterThanOrEqual(
				global.minBitrateStepSize,
			);
		}
		checkAdoption(goal, "count", result);
		expect(goal).toEqual(before);
	});

	it("retains a checked mixed structural repair under the count objective", () => {
		const goal: PerTitleGoal = {
			strategy: "fixed-ranges",
			codec: "H264",
			minBitrate: 100_000,
			maxBitrate: 6_000_000,
			minBitrateStepSize: 1.5,
			maxBitrateStepSize: 5,
			countPolicy: { kind: "exact", count: 5 },
			autoRepresentations: false,
			fixedResolutionAndBitrateConfiguration: {
				forcedRenditionAboveHighestFixedRepresentation: 1,
				forcedRenditionAboveHighestFixedRepresentationFactor: 2,
				forcedRenditionAboveHighestFixedRepresentationCalculationMode:
					"LAST_CALCULATED_BITRATE",
			},
			rows: [
				{ id: "first", height: 360, minBitrate: 400_000, maxBitrate: 500_000 },
				{
					id: "middle",
					height: 720,
					minBitrate: 1_000_000,
					maxBitrate: 1_200_000,
				},
				{
					id: "top",
					height: 1080,
					minBitrate: 2_800_000,
					maxBitrate: 3_000_000,
				},
			].map((row) => ({
				...row,
				bitrateSelectionMode: "COMPLEXITY_RANGE",
				lowComplexityBoundaryForMaxBitrate: 5_600_000,
				highComplexityBoundaryForMaxBitrate: 6_000_000,
			})),
			automaticTemplates: [
				{ id: "lower", height: 180 },
				{ id: "upper", height: 1440 },
			],
		};
		const compatible = analyzePerTitleSettings(goal, "preserve");
		expect(compatible.countStructure.status).toBe("declared-compatible");
		expect(compatible.ladder.lowerSlots?.maximum).toBe(3);
		expect(compatible.ladder.upperSlots?.maximum).toBe(1);
		expect(
			compatible.advice.some((advice) => advice.facts.lowerSlots === 2),
		).toBe(true);
		// A feasible conditional structural improvement already exists; changing
		// the selected objective must not make that same count repair disappear.
		const result = analyzePerTitleSettings(goal, "count");
		expect(result.advice.length).toBeGreaterThan(0);
		expect(result.advice.some((advice) => advice.facts.lowerSlots === 2)).toBe(
			true,
		);
		for (const advice of result.advice) {
			expect(advice.proof).toBe("conditional-settings");
			expect(advice.proposal.countGuarantee).toBe(false);
			const structure = assessPerTitleCountStructure(
				advice.goal,
				advice.proposal,
			);
			expect(structure).toMatchObject({
				status: "declared-compatible",
				required: 5,
				declaredCount: 5,
			});
			const ladder = assessPerTitleLadder(advice.goal, advice.proposal);
			expect(ladder.lowerSlots?.maximum).toBeLessThanOrEqual(3);
			expect(ladder.upperSlots?.maximum).toBeLessThanOrEqual(1);
		}
		checkAdoption(goal, "count", result, {});
	});

	it.each(
		matrix.flatMap((row) =>
			(["raw", "wizard"] as const).map((phase) => [...row, phase] as const),
		),
	)("checks %s / %s through the %s path after %s initialization", (strategy, intent, expected, phase) => {
		const goal =
			phase === "wizard" ? wizardGoal(strategy) : matrixGoal(strategy);
		const before = structuredClone(goal);
		const result = analyzePerTitleSettings(goal, intent, protectedQuality);
		if (strategy === "fixed-resolutions" && intent === "cap")
			expect(result.advice).toEqual([]);
		if (expected === "repair") {
			expect(result.advice.length).toBeGreaterThan(0);
			expect(result.decision.status).toBe("proposal");
		} else if (!result.advice.length) {
			expect(result.decision.status).not.toBe("keep-current");
			if (expected === "media-cap") {
				expect(result.reach.status).toBe("unknown");
				expect(result.findings.map(({ code }) => code)).toContain(
					"cap-unresolved",
				);
				if (strategy === "fixed-resolutions") {
					// Resolving a count does not determine media-selected bitrates at
					// fixed resolutions. Keep the count repair as a separate operation.
					expect(result.reach.blockers).toContain("fixed-bitrate-unresolved");
					expect(result.ordinaryCap.status).toBe("unavailable");
					const countRepair = analyzePerTitleSettings(
						goal,
						"count",
						protectedQuality,
					);
					expect(countRepair.advice.length).toBeGreaterThan(0);
					for (const advice of countRepair.advice) {
						expect(advice.proof).toBe("model-count");
						expect(
							assessPerTitleReach(advice.goal, advice.proposal).status,
						).toBe("unknown");
					}
					checkAdoption(goal, "count", countRepair);
				}
			} else {
				// Freely selected resolutions do not certify the native count.
				expect(result.reach.count.status).not.toBe("model-checked");
				expect(result.findings.map(({ code }) => code)).toContain(
					"count-conditional",
				);
			}
			expect(
				result.quality.checks.some(({ en }) =>
					en.includes("measured video bitrate"),
				),
			).toBe(true);
		}
		checkAdoption(goal, intent, result);
		expect(goal).toEqual(before);
	});

	it("finds a joint cap and spacing repair that independently passes every check", () => {
		const goal = matrixGoal("fixed-ranges");
		const candidate: PerTitleGoal = {
			...goal,
			maxBitrateStepSize: 5,
			rows: goal.rows?.map((row) =>
				row.id === "fixed-2" ? { ...row, maxBitrate: 4_000_000 } : row,
			),
		};
		const proposal = tunePerTitleSettings(candidate, candidate).proposal;
		const reach = assessPerTitleReach(candidate, proposal);
		// The first gap requires ratio 4; reaching 4M from the middle 800k
		// point requires ratio 5. Raising only the top endpoint leaves a conflict.
		expect(createPerTitleEvaluationAdvice(goal, candidate)).not.toBeNull();
		expect(reach).toMatchObject({
			status: "conditional-reachable",
			adaptation: "conditional",
			certainty: "all-permitted-rates",
			high: { minimum: 4_000_000, maximum: 4_000_000 },
			low: { minimum: 3_831_578, maximum: 3_831_578 },
			count: { status: "model-checked", minimum: 3, maximum: 3 },
		});
		const result = analyzePerTitleSettings(goal, "cap", protectedQuality);
		expect(result.advice.length).toBeGreaterThan(0);
		checkAdoption(goal, "cap", result);
	});

	it.each([
		"cap",
		"bandwidth",
		"count",
		"preserve",
	] as const)("evaluates equivalent implicit and wizard-explicit ordinary templates consistently for %s", (intent) => {
		const explicit = {
			...wizardGoal("automatic"),
			countPolicy: { kind: "exact" as const, count: 6 },
		};
		const implicit = structuredClone(explicit);
		delete implicit.automaticTemplates;
		expect(tunePerTitleSettings(explicit, explicit).proposal.api).toEqual(
			tunePerTitleSettings(implicit, implicit).proposal.api,
		);
		const listed = analyzePerTitleSettings(explicit, intent);
		const inferred = analyzePerTitleSettings(implicit, intent);
		expect(listed.advice.length).toBeGreaterThan(0);
		expect(listed.decision.status).toBe("proposal");
		expect(listed.advice.map(({ proposal }) => proposal.api)).toEqual(
			inferred.advice.map(({ proposal }) => proposal.api),
		);
		checkAdoption(explicit, intent, listed, {});
		checkAdoption(implicit, intent, inferred, {});
	});

	it.each([
		"H264",
		"H265",
		"VP9",
		"AV1",
	] as const)("offers an adoptable count repair for supported codec %s", (codec) => {
		const goal = { ...matrixGoal("count"), codec, targetQualityCrf: undefined };
		const result = analyzePerTitleSettings(goal, "count");
		expect(result.advice.length).toBeGreaterThan(0);
		checkAdoption(goal, "count", result, {});
	});

	it("keeps H265V2 outside the usual codec gate while retaining explicit legacy support", () => {
		const input = {
			strategy: "count" as const,
			codec: "H265V2" as const,
			minBitrate: 100_000,
			maxBitrate: 4_000_000,
			count: 3,
			rows: [],
		};
		const unsupported = buildPerTitleSetup(input);
		expect(unsupported.goal).toBeNull();
		expect(unsupported.issues.map(({ code }) => code)).toContain(
			"unsupported-codec",
		);
		expect(buildPerTitleSetup(input, ["H265V2"]).goal?.codec).toBe("H265V2");
	});

	it.each(
		(["H264", "H265", "VP9", "AV1"] as const).flatMap((codec) =>
			[1, 2, 3, 6, 8].flatMap((count) =>
				(["exact", "maximum"] as const).flatMap((kind) =>
					(["adaptive", "cap", "preserve"] as const).map(
						(intent) => [codec, count, kind, intent] as const,
					),
				),
			),
		),
	)("separates automatic %s count %s (%s) repair from the %s objective's proof", (codec, count, kind, intent) => {
		const goal: PerTitleGoal = {
			...wizardGoal("automatic"),
			codec,
			targetQualityCrf: undefined,
			countPolicy: { kind, count },
		};
		const current = tunePerTitleSettings(goal, goal).proposal;
		expect(hasPerTitleEvaluationCountEvidence(goal, current)).toBe(false);
		const result = analyzePerTitleSettings(goal, intent);
		if ((intent === "cap" || intent === "adaptive") && count === 1) {
			expect(result.advice).toEqual([]);
			expect(result.decision.status).toBe("no-certified-candidate");
			expect(result.reach.status).toBe("unknown");
			// A single placement starts at the minimum, for either count policy.
			expect(result.ordinaryCap.status).toBe("blocked");
			expect(result.ordinaryCap.lastSlot).toEqual({
				minimum: goal.minBitrate,
				maximum: goal.minBitrate,
			});
			expect(result.findings).toContainEqual(
				expect.objectContaining({
					code: "ordinary-cap-spacing-blocked",
					severity: "warning",
					fields: expect.arrayContaining([
						{ scope: "global", key: "countPolicy" },
					]),
				}),
			);
			const countRepair = analyzePerTitleSettings(goal, "count");
			expect(countRepair.decision.status).toBe("proposal");
			expect(countRepair.advice.length).toBeGreaterThan(0);
			for (const advice of countRepair.advice) {
				expect(advice.proof).toBe("model-count");
				expect(advice.facts.countRequirementRepair).toBe(1);
				expect(advice.goal.countPolicy).toEqual(goal.countPolicy);
				const applied = applyPerTitleAdvice(goal, advice, {
					contextKey: perTitleAnalysisContextKey("count"),
				});
				if (!applied)
					throw new Error("Expected an adoptable count-only repair.");
				const capAfterCountRepair = analyzePerTitleSettings(applied, "cap");
				expect(capAfterCountRepair.advice).toEqual([]);
				expect(capAfterCountRepair.decision.status).toBe(
					"no-certified-candidate",
				);
			}
			checkAdoption(goal, "count", countRepair, {});
			return;
		}
		expect(result.advice.length).toBeGreaterThan(0);
		expect(result.decision.status).toBe("proposal");
		for (const advice of result.advice) {
			expect(advice.proof).toBe("model-count");
			expect(advice.facts.countRequirementRepair).toBe(1);
			expect(
				advice.changes.every(({ key }) => key.endsWith("BitrateStepSize")),
			).toBe(true);
			// Count arithmetic does not establish media-derived cap use or resolutions.
			expect(assessPerTitleReach(advice.goal, advice.proposal).status).toBe(
				"unknown",
			);
			if (intent === "cap" || intent === "adaptive") {
				checkOrdinaryCap(advice.goal, advice.proposal);
			}
		}
		checkAdoption(goal, intent, result, {});
	});

	it.each([
		"LAST_CALCULATED_BITRATE",
		"MINIMUM",
		"MAXIMUM",
		"AVERAGE",
	] as const)("repairs the %s forced branch while preserving held lower bounds", (mode) => {
		for (const factor of [0.5, 1, 1.2]) {
			const goal: PerTitleGoal = {
				strategy: "fixed-ranges",
				codec: "H264",
				minBitrate: 100_000,
				maxBitrate: 6_000_000,
				minBitrateStepSize: 1.5,
				maxBitrateStepSize: 4,
				targetQualityCrf: 18,
				countPolicy: { kind: "unrestricted" },
				autoRepresentations: false,
				fixedResolutionAndBitrateConfiguration: {
					forcedRenditionAboveHighestFixedRepresentation: 1,
					forcedRenditionAboveHighestFixedRepresentationFactor: factor,
					forcedRenditionAboveHighestFixedRepresentationCalculationMode: mode,
				},
				rows: [
					{
						id: "lower",
						height: 360,
						minBitrate: 300_000,
						maxBitrate: 500_000,
					},
					{
						id: "upper",
						height: 720,
						minBitrate: 1_000_000,
						maxBitrate: 4_800_000,
					},
				].map((row) => ({
					...row,
					bitrateSelectionMode: "COMPLEXITY_RANGE",
					lowComplexityBoundaryForMaxBitrate: 1_500_000,
					highComplexityBoundaryForMaxBitrate: 4_000_000,
				})),
				automaticTemplates: [{ id: "top", height: 1080 }],
			};
			const options: PerTitleAdviceOptions = {
				protectedFields: [
					...(protectedQuality.protectedFields ?? []),
					{ scope: "stream", rowId: "lower", key: "minBitrate" },
					{ scope: "stream", rowId: "lower", key: "maxBitrate" },
				],
			};
			const result = analyzePerTitleSettings(goal, "cap", options);
			expect(result.advice.length).toBeGreaterThan(0);
			for (const advice of result.advice) {
				expect(
					advice.goal.rows?.find(({ id }) => id === "lower"),
				).toMatchObject({ minBitrate: 300_000, maxBitrate: 500_000 });
				const reach = assessPerTitleReach(advice.goal, advice.proposal);
				expect(reach.high?.maximum).toBe(6_000_000);
				expect(reach.low?.maximum).toBeLessThan(6_000_000);
			}
			checkAdoption(goal, "cap", result, options);
		}
	});

	it.each([
		"exact",
		"maximum",
	] as const)("repairs a %s count while keeping both global limits", (kind) => {
		const goal = matrixGoal("count");
		goal.countPolicy = { kind, count: 3 };
		const result = analyzePerTitleSettings(goal, "count", protectedQuality);
		expect(result.advice.length).toBeGreaterThan(0);
		for (const advice of result.advice) {
			expect(advice.proof).toBe("model-count");
			expect(
				advice.changes.every(({ key }) => key.endsWith("BitrateStepSize")),
			).toBe(true);
		}
		checkAdoption(goal, "count", result);
	});

	it.each([
		[9_999, 4_000_000, "global-bitrate-below-api-minimum"],
		[4_000_000, 100_000, "global-range-order"],
		[100_000, 2_147_483_648, "invalid-value"],
	] as const)("does not silently repair invalid requirement bounds %s..%s", (minimum, maximum, code) => {
		const goal = {
			...matrixGoal("count"),
			minBitrate: minimum,
			maxBitrate: maximum,
		};
		const before = structuredClone(goal);
		const result = analyzePerTitleSettings(goal, "count", protectedQuality);
		expect(result.advice).toEqual([]);
		expect(result.decision.status).not.toBe("keep-current");
		expect(result.findings.map((finding) => finding.code)).toContain(code);
		expect(goal).toEqual(before);
	});

	it("keeps an equal global envelope instead of widening it for an impossible increasing count", () => {
		const goal = {
			...matrixGoal("count"),
			minBitrate: 10_000,
			maxBitrate: 10_000,
		};
		const result = analyzePerTitleSettings(goal, "count", protectedQuality);
		expect(result.advice).toEqual([]);
		expect(result.decision.status).not.toBe("keep-current");
		expect(result.findings.map(({ code }) => code)).not.toContain(
			"global-range-order",
		);
		expect(goal.minBitrate).toBe(10_000);
		expect(goal.maxBitrate).toBe(10_000);
	});

	it("honours held point endpoints and spacing without claiming that the invalid ladder is unchanged", () => {
		const goal = matrixGoal("fixed-ranges");
		const before = structuredClone(goal);
		const options: PerTitleAdviceOptions = {
			protectedFields: [
				{ scope: "global", key: "minBitrateStepSize" },
				{ scope: "global", key: "maxBitrateStepSize" },
				...(goal.rows ?? []).flatMap(({ id }) => [
					{ scope: "stream" as const, rowId: id, key: "minBitrate" },
					{ scope: "stream" as const, rowId: id, key: "maxBitrate" },
				]),
			],
		};
		const result = analyzePerTitleSettings(goal, "cap", options);
		expect(result.advice).toEqual([]);
		expect(result.decision.status).not.toBe("keep-current");
		expect(result.findings.map(({ code }) => code)).toContain(
			"adjacent-gap-unproved",
		);
		expect(goal).toEqual(before);
	});

	it("re-evaluates a conflicting partial repair without borrowing the full recommendation proof", () => {
		const goal = matrixGoal("fixed-ranges");
		const candidate: PerTitleGoal = {
			...goal,
			maxBitrateStepSize: 5,
			rows: goal.rows?.map((row) =>
				row.id === "fixed-2" ? { ...row, maxBitrate: 4_000_000 } : row,
			),
		};
		const context = { contextKey: perTitleAnalysisContextKey("cap") };
		const advice = createPerTitleEvaluationAdvice(goal, candidate, context);
		if (!advice) throw new Error("Expected the independently checked repair.");
		const selected = [
			{ scope: "stream" as const, rowId: "fixed-2", key: "maxBitrate" },
		];
		const preview = perTitleAdvicePreview(
			goal,
			advice,
			{ selected, kept: [] },
			context,
		);
		expect(preview.status).toBe("conflict");
		const partial = applySelectedPerTitleAdvice(
			goal,
			advice,
			selected,
			context,
		);
		expect(partial).not.toBeNull();
		if (!partial) throw new Error("Expected a partial simulator draft.");
		expect(partial.maxBitrateStepSize).toBe(1.9);
		expect(partial.rows?.find(({ id }) => id === "fixed-2")?.maxBitrate).toBe(
			4_000_000,
		);
		const rechecked = analyzePerTitleSettings(partial, "cap");
		expect(rechecked.decision.status).not.toBe("keep-current");
		expect(rechecked.findings.map(({ code }) => code)).toContain(
			"configuration-conflict",
		);
		expect(
			applyPerTitleAdvice({ ...goal, maxBitrate: 5_000_000 }, advice, context),
		).toBeNull();
		expect(
			applyPerTitleAdvice(goal, advice, { contextKey: "analysis:count" }),
		).toBeNull();
	});
});
