import { describe, expect, it } from "vitest";
import {
	type PerTitleGoal,
	type PerTitleProposal,
	proposePerTitleSettings,
	recommendPerTitleSettings,
} from "./per-title-simulator";

const COUNT =
	"fixedResolutionAndBitrateConfiguration.forcedRenditionAboveHighestFixedRepresentation";

function required<T>(value: T | undefined): T {
	if (value === undefined)
		throw new Error("Expected an authoring fixture value");
	return value;
}

function authoringGoal(
	structure: "closed" | "mixed" | "expanded",
	selection: "OPTIMIZED" | "COMPLEXITY_RANGE",
	zero: boolean,
): PerTitleGoal {
	const rows = [
		{ id: "small", height: 240, minBitrate: 160_000, maxBitrate: 200_000 },
		{ id: "medium", height: 480, minBitrate: 400_000, maxBitrate: 480_000 },
		{ id: "large", height: 720, minBitrate: 1_000_000, maxBitrate: 1_200_000 },
	].map((row) => ({
		...row,
		bitrateSelectionMode: selection,
		...(selection === "COMPLEXITY_RANGE"
			? {
					lowComplexityBoundaryForMaxBitrate: 1_000_000,
					highComplexityBoundaryForMaxBitrate: 2_400_000,
				}
			: {}),
	}));
	return {
		strategy: "fixed-ranges",
		codec: "H264",
		minBitrate: 100_000,
		maxBitrate: 2_400_000,
		minBitrateStepSize: 1.5,
		maxBitrateStepSize: 4,
		countPolicy: { kind: "unrestricted" },
		autoRepresentations: structure === "expanded" ? {} : false,
		rows,
		...(structure === "closed"
			? {}
			: {
					automaticTemplates: [
						{ id: "lower", height: 180 },
						{ id: "upper", height: 1080 },
					],
				}),
		...(zero
			? {
					fixedResolutionAndBitrateConfiguration: {
						forcedRenditionAboveHighestFixedRepresentation: 0,
					},
				}
			: {}),
		settingLocks: {
			global: [
				"minBitrate",
				"maxBitrate",
				"minBitrateStepSize",
				"maxBitrateStepSize",
				"autoRepresentations",
				COUNT,
			],
			streams: Object.fromEntries(
				rows.map((row) => [
					row.id,
					[
						"minBitrate",
						"maxBitrate",
						"bitrateSelectionMode",
						"lowComplexityBoundaryForMaxBitrate",
						"highComplexityBoundaryForMaxBitrate",
					],
				]),
			),
		},
	};
}

function expectUnknownCount(proposal: PerTitleProposal) {
	expect(proposal.countGuarantee).toBe(false);
	expect(proposal.derivation?.targetSatisfied).toBe(false);
	expect(proposal.derivation?.constraints?.status).toBe("unknown");
	expect(proposal.derivation?.integerWitness).toBeUndefined();
	expect(proposal.derivation?.minimumStepRange).toBeUndefined();
	expect(
		proposal.scenarios.every(
			(scenario) =>
				scenario.status === "unknown" && scenario.modelCountRange === null,
		),
	).toBe(true);
}

describe("unrestricted Per-Title authoring", () => {
	it.each([
		"unrestricted",
		"exact",
		"maximum",
	] as const)("treats an explicit zero rule like absence for an ordinary $0 layout", (kind) => {
		const goal: PerTitleGoal = {
			strategy: "automatic",
			codec: "H264",
			minBitrate: 128_000,
			maxBitrate: 4_000_000,
			minBitrateStepSize: 1.5,
			maxBitrateStepSize: 6,
			autoRepresentations: {},
			countPolicy: kind === "unrestricted" ? { kind } : { kind, count: 2 },
		};
		const rule = { forcedRenditionAboveHighestFixedRepresentation: 0 };
		const methods: Array<(input: PerTitleGoal) => PerTitleProposal[]> = [
			proposePerTitleSettings,
			(input) => [recommendPerTitleSettings(input)],
		];
		for (const method of methods) {
			const baseline = method(goal);
			const zero = method({
				...goal,
				fixedResolutionAndBitrateConfiguration: rule,
			});
			expect(zero).toEqual(
				baseline.map((proposal) => ({
					...proposal,
					api: {
						...proposal.api,
						global: {
							...proposal.api.global,
							fixedResolutionAndBitrateConfiguration: rule,
						},
					},
				})),
			);
			expect(zero.every((proposal) => proposal.countGuarantee === false)).toBe(
				true,
			);
		}
	});

	it.each(
		(["closed", "mixed", "expanded"] as const).flatMap((structure) =>
			(["OPTIMIZED", "COMPLEXITY_RANGE"] as const).flatMap((selection) =>
				[false, true].map((zero) => ({ structure, selection, zero })),
			),
		),
	)("permits $structure $selection settings with explicit zero: $zero without certifying a count", ({
		structure,
		selection,
		zero,
	}) => {
		const goal = authoringGoal(structure, selection, zero);
		const before = structuredClone(goal);
		const proposal = recommendPerTitleSettings(goal);
		expect(proposal).toMatchObject({ status: "candidate", applicable: true });
		expectUnknownCount(proposal);
		expect(proposal.derivation?.constraints?.scope).toBe(
			structure === "closed" ? "closed-ladder" : "conditional",
		);
		expect(proposal.api.global).toMatchObject({
			minBitrate: goal.minBitrate,
			maxBitrate: goal.maxBitrate,
			minBitrateStepSize: goal.minBitrateStepSize,
			maxBitrateStepSize: goal.maxBitrateStepSize,
		});
		expect(proposal.api.global.fixedResolutionAndBitrateConfiguration).toEqual(
			goal.fixedResolutionAndBitrateConfiguration,
		);
		expect(proposal.api.streams.map((row) => [row.rowId, row.mode])).toEqual([
			...(goal.rows ?? []).map((row) => [
				row.id,
				"PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
			]),
			...(goal.automaticTemplates ?? []).map((row) => [
				row.id,
				"PER_TITLE_TEMPLATE",
			]),
		]);
		for (const row of goal.rows ?? []) {
			expect(
				proposal.api.streams.find((stream) => stream.rowId === row.id),
			).toMatchObject({
				height: row.height,
				perTitleSettings: {
					minBitrate: row.minBitrate,
					maxBitrate: row.maxBitrate,
					bitrateSelectionMode: row.bitrateSelectionMode,
					...(selection === "COMPLEXITY_RANGE"
						? {
								lowComplexityBoundaryForMaxBitrate:
									row.lowComplexityBoundaryForMaxBitrate,
								highComplexityBoundaryForMaxBitrate:
									row.highComplexityBoundaryForMaxBitrate,
							}
						: {}),
				},
			});
		}
		expect(
			proposal.diagnostics.some((item) => item.severity === "conflict"),
		).toBe(false);
		expect(
			proposal.diagnostics.some((item) => item.code === "forced-count-unknown"),
		).toBe(false);
		expect(goal).toEqual(before);
	});

	it.each([
		{ forcedRenditionAboveHighestFixedRepresentation: 1 },
		{
			forcedRenditionAboveHighestFixedRepresentation: 1,
			forcedRenditionAboveHighestFixedRepresentationFactor: 1.2,
			forcedRenditionAboveHighestFixedRepresentationCalculationMode:
				"LAST_CALCULATED_BITRATE" as const,
		},
		{},
	])("does not enable unverified positive or partial additional-rendition rules %j", (rule) => {
		const goal = {
			...authoringGoal("mixed", "COMPLEXITY_RANGE", false),
			fixedResolutionAndBitrateConfiguration: rule,
		};
		const proposal = recommendPerTitleSettings(goal);
		expect(proposal.applicable).toBe(false);
		expectUnknownCount(proposal);
		expect(proposal.api.global.fixedResolutionAndBitrateConfiguration).toEqual(
			rule,
		);
	});

	it.each([
		"invalid-range",
		"spacing-conflict",
		"unknown-order",
		"invalid-zero-rule",
	] as const)("retains the %s authoring block", (reason) => {
		const goal = authoringGoal("mixed", "COMPLEXITY_RANGE", true);
		if (reason === "invalid-range")
			required(goal.rows?.[0]).maxBitrate = 4_000_000;
		if (reason === "spacing-conflict") {
			goal.minBitrateStepSize = 8;
			goal.maxBitrateStepSize = 8;
		}
		if (reason === "unknown-order") required(goal.rows?.[0]).height = 480;
		if (reason === "invalid-zero-rule")
			required(
				goal.fixedResolutionAndBitrateConfiguration,
			).forcedRenditionAboveHighestFixedRepresentationFactor = 0;
		const proposal = recommendPerTitleSettings(goal);
		expect(proposal.applicable).toBe(false);
		expect(proposal.derivation?.targetSatisfied).not.toBe(true);
		expect(proposal.countGuarantee).toBe(false);
	});

	it.each([
		"exact",
		"maximum",
	] as const)("does not bypass an unsatisfied %s count with a disabled additional rule", (kind) => {
		const goal = authoringGoal("mixed", "COMPLEXITY_RANGE", true);
		goal.countPolicy = { kind, count: 1 };
		const proposal = recommendPerTitleSettings(goal);
		expect(proposal.applicable).toBe(false);
		expect(proposal.derivation?.targetSatisfied).toBe(false);
		expect(proposal.countGuarantee).toBe(false);
	});
});
