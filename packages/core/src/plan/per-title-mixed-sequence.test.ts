import { describe, expect, it } from "vitest";
import { certifyPerTitleMixedSequence } from "./per-title-mixed-sequence";
import {
	type PerTitleApiSettings,
	type PerTitleCodec,
	type PerTitleGoal,
	recommendPerTitleSettings,
} from "./per-title-simulator";

const forced = {
	forcedRenditionAboveHighestFixedRepresentation: 1,
	forcedRenditionAboveHighestFixedRepresentationFactor: 1.2,
	forcedRenditionAboveHighestFixedRepresentationCalculationMode:
		"LAST_CALCULATED_BITRATE" as const,
};

function mixed(codec: PerTitleCodec = "H264"): PerTitleGoal {
	return {
		strategy: "fixed-ranges",
		codec,
		minBitrate: 150_000,
		maxBitrate: 4_800_000,
		minBitrateStepSize: 1.5,
		maxBitrateStepSize: 4,
		countPolicy: { kind: "exact", count: 6 },
		autoRepresentations: false,
		inputHeight: 1600,
		rows: [
			{ id: "fixed-a", height: 240, minBitrate: 260_000, maxBitrate: 350_000 },
			{ id: "fixed-b", height: 240, minBitrate: 530_000, maxBitrate: 700_000 },
			{
				id: "fixed-c",
				height: 720,
				minBitrate: 1_060_000,
				maxBitrate: 1_400_000,
			},
			{
				id: "fixed-d",
				height: 960,
				minBitrate: 2_120_000,
				maxBitrate: 2_800_000,
			},
		].map((row) => ({
			...row,
			bitrateSelectionMode: "COMPLEXITY_RANGE",
			lowComplexityBoundaryForMaxBitrate: 2_544_000,
			highComplexityBoundaryForMaxBitrate: 4_800_000,
		})),
		automaticTemplates: [
			{ id: "lower", height: 120 },
			{ id: "upper-a", height: 1280 },
			{ id: "upper-b", height: 1600 },
		],
		fixedResolutionAndBitrateConfiguration: { ...forced },
		settingLocks: {
			global: [
				"minBitrate",
				"maxBitrate",
				"minBitrateStepSize",
				"maxBitrateStepSize",
				...Object.keys(forced).map(
					(key) => `fixedResolutionAndBitrateConfiguration.${key}`,
				),
			],
		},
	};
}

describe("conditional mixed Per-Title sequence admission", () => {
	it("rejects a ranged API certificate after the raw fixed stream mode changes", () => {
		const original = mixed();
		const api = recommendPerTitleSettings(original).api;
		expect(certifyPerTitleMixedSequence(original, api)).not.toBeNull();
		const changed: PerTitleGoal = {
			...original,
			rows: original.rows?.map((row, index) =>
				index === 0
					? {
							...row,
							mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION",
						}
					: row,
			),
		};
		expect(certifyPerTitleMixedSequence(changed, api)).toBeNull();
		expect(recommendPerTitleSettings(changed).countGuarantee).toBe(false);
	});
	for (const codec of ["H264", "H265", "H265V2", "VP9", "AV1"] as const) {
		it(`admits the ${codec} model under an explicit unmeasured lower-probe condition`, () => {
			const goal = mixed(codec);
			const before = structuredClone(goal);
			const result = recommendPerTitleSettings(goal);
			expect(result.applicable).toBe(true);
			expect(result.status).toBe("candidate");
			expect(result.evidence).toBe("model-only");
			expect(result.countGuarantee).toBe(false);
			expect(result.derivation?.targetSatisfied).toBe(true);
			expect(result.derivation?.constraints).toMatchObject({
				status: "checked",
				scope: "conditional",
				conditionalModel: {
					kind: "mixed-role-sequence",
					count: 6,
					fixedRowIds: ["fixed-a", "fixed-b", "fixed-c", "fixed-d"],
					lowerRowId: "lower",
					upperCandidateRowIds: ["upper-a", "upper-b"],
					sourceConditions: {
						geometry: {
							postRoundingWidthOrderPreserved: { status: "not-measured" },
						},
						lowerProbe: {
							status: "not-measured",
							rowId: "lower",
							minimum: 150_000,
							maximum: 223_498,
						},
					},
				},
			});
			expect(result.api.global).toMatchObject({
				minBitrate: goal.minBitrate,
				maxBitrate: goal.maxBitrate,
				minBitrateStepSize: goal.minBitrateStepSize,
				maxBitrateStepSize: goal.maxBitrateStepSize,
				fixedResolutionAndBitrateConfiguration: forced,
			});
			expect(result.api.streams).toHaveLength(7);
			expect(
				result.api.streams.filter((row) => row.mode === "PER_TITLE_TEMPLATE"),
			).toHaveLength(3);
			for (const row of goal.rows ?? []) {
				expect(
					result.api.streams.find((stream) => stream.rowId === row.id),
				).toMatchObject({
					height: row.height,
					mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
					perTitleSettings: {
						minBitrate: row.minBitrate,
						maxBitrate: row.maxBitrate,
						lowComplexityBoundaryForMaxBitrate:
							row.lowComplexityBoundaryForMaxBitrate,
						highComplexityBoundaryForMaxBitrate:
							row.highComplexityBoundaryForMaxBitrate,
					},
				});
			}
			expect(recommendPerTitleSettings(goal).api).toEqual(result.api);
			expect(goal).toEqual(before);
		});
	}

	for (const mutate of [
		(goal: PerTitleGoal) => {
			goal.autoRepresentations = {};
		},
		(goal: PerTitleGoal) => {
			goal.countPolicy = { kind: "maximum", count: 6 };
		},
		(goal: PerTitleGoal) => {
			goal.minBitrateStepSize = NaN;
		},
	]) {
		it("does not admit an unsupported or malformed model", () => {
			const goal = mixed();
			mutate(goal);
			const result = recommendPerTitleSettings(goal);
			expect(result.derivation?.targetSatisfied).not.toBe(true);
			expect(result.derivation?.constraints).not.toMatchObject({
				conditionalModel: { kind: "mixed-role-sequence" },
			});
		});
	}

	it("checks explicit widths instead of silently assuming height order", () => {
		const goal = mixed();
		goal.rows = goal.rows?.map((row) => ({ ...row, width: row.height * 2 }));
		goal.automaticTemplates = goal.automaticTemplates?.map((row) => ({
			...row,
			width: (row.height ?? 0) * 2,
		}));
		goal.inputWidth = 3200;
		const proposal = recommendPerTitleSettings(goal);
		expect(proposal.applicable).toBe(true);
		expect(
			proposal.derivation?.constraints?.conditionalModel?.sourceConditions
				.geometry,
		).toEqual({
			status: "not-measured",
			basis: "width",
			commonSourceAspectRatio: false,
			minimumSourceDimension: 3200,
			postRoundingWidthOrderPreserved: { status: "not-measured" },
		});
	});

	for (const basis of ["height", "width"] as const) {
		it(`keeps an omitted source ${basis} as an explicit minimum-extent hypothesis`, () => {
			const goal = mixed();
			if (basis === "width") {
				goal.rows = goal.rows?.map((row) => ({
					...row,
					width: row.height * 2,
				}));
				goal.automaticTemplates = goal.automaticTemplates?.map((row) => ({
					...row,
					width: (row.height ?? 0) * 2,
				}));
			} else delete goal.inputHeight;
			const before = structuredClone(goal);
			const proposal = recommendPerTitleSettings(goal);
			expect(proposal.applicable).toBe(true);
			expect(proposal.derivation?.targetSatisfied).toBe(true);
			expect(
				proposal.derivation?.constraints?.conditionalModel?.sourceConditions
					.geometry,
			).toEqual({
				status: "not-measured",
				basis,
				commonSourceAspectRatio: basis === "height",
				minimumSourceDimension: basis === "height" ? 1600 : 3200,
				postRoundingWidthOrderPreserved: { status: "not-measured" },
			});
			expect(proposal.countGuarantee).toBe(false);
			expect(goal).toEqual(before);
		});
	}

	it("does not present close height candidates as verified rounded-width order", () => {
		const goal = mixed();
		goal.automaticTemplates = [
			{ id: "lower", height: 120 },
			{ id: "upper-close", height: 962 },
		];
		goal.inputHeight = 1080;
		const proposal = recommendPerTitleSettings(goal);
		const model = proposal.derivation?.constraints?.conditionalModel;
		expect(
			model?.sourceConditions.geometry.postRoundingWidthOrderPreserved,
		).toEqual({ status: "not-measured" });
		expect(model?.upperCandidateRowIds).toEqual(["upper-close"]);
		expect(proposal.countGuarantee).toBe(false);
		expect(goal.inputWidth).toBeUndefined();
		expect(proposal.api.streams.every((row) => row.width === undefined)).toBe(
			true,
		);
	});

	it("rejects a known undersized height even when explicit widths select the width basis", () => {
		const goal = mixed();
		goal.rows = goal.rows?.map((row) => ({ ...row, width: row.height * 2 }));
		goal.automaticTemplates = goal.automaticTemplates?.map((row) => ({
			...row,
			width: (row.height ?? 0) * 2,
		}));
		goal.inputWidth = 3200;
		const api = recommendPerTitleSettings(goal).api;
		goal.inputHeight = 1400;
		expect(certifyPerTitleMixedSequence(goal, api)).toBeNull();
	});

	it("rejects a malformed supplied width even when height is the ordering basis", () => {
		const goal = mixed();
		const api = recommendPerTitleSettings(goal).api;
		goal.inputWidth = NaN;
		expect(certifyPerTitleMixedSequence(goal, api)).toBeNull();
	});

	it("retains codec-specific quality controls without claiming a quality optimum", () => {
		const goal = mixed("H265V2");
		goal.targetQualityQp = 19;
		const proposal = recommendPerTitleSettings(goal);
		expect(proposal.applicable).toBe(true);
		expect(proposal.api.global.targetQualityQp).toBe(19);
		expect(proposal.api.global.targetQualityCrf).toBeUndefined();
		expect(
			proposal.derivation?.constraints?.conditionalModel?.sourceConditions
				.lowerProbe.status,
		).toBe("not-measured");
		expect(
			proposal.scenarios.every((scenario) => scenario.modelRungs.length === 0),
		).toBe(true);
	});

	it("does not promote malformed authoring locks", () => {
		const goal = mixed();
		goal.settingLocks = { global: ["not-a-setting"] };
		const proposal = recommendPerTitleSettings(goal);
		expect(proposal.applicable).toBe(false);
		expect(proposal.derivation?.constraints?.conditionalModel).toBeUndefined();
	});

	it("withholds the upper-branch certificate near a floating/floor boundary", () => {
		const goal: PerTitleGoal = {
			...mixed(),
			minBitrate: 100_000,
			maxBitrate: 666_027,
			countPolicy: { kind: "exact", count: 3 },
			rows: [
				{
					id: "constant",
					height: 240,
					minBitrate: 300_000,
					maxBitrate: 300_000,
					bitrateSelectionMode: "COMPLEXITY_RANGE",
					lowComplexityBoundaryForMaxBitrate: 360_000,
					highComplexityBoundaryForMaxBitrate: 666_027,
				},
			],
			automaticTemplates: [
				{ id: "lower", height: 120 },
				{ id: "upper", height: 1080 },
			],
		};
		const near = recommendPerTitleSettings(goal);
		expect(near.derivation?.constraints?.conditionalModel).toBeUndefined();
		const away = recommendPerTitleSettings({ ...goal, maxBitrate: 666_000 });
		expect(away.applicable).toBe(true);
		expect(away.derivation?.constraints?.conditionalModel?.count).toBe(3);
	});

	const invalidGoals: Array<[string, (goal: PerTitleGoal) => void]> = [
		[
			"a missing lower template",
			(goal) => {
				goal.automaticTemplates = goal.automaticTemplates?.slice(1);
			},
		],
		[
			"two lower templates",
			(goal) => {
				goal.automaticTemplates = [
					...(goal.automaticTemplates ?? []),
					{ id: "lower-2", height: 100 },
				];
			},
		],
		[
			"an intermediate ordinary template",
			(goal) => {
				goal.automaticTemplates = [
					...(goal.automaticTemplates ?? []),
					{ id: "middle", height: 480 },
				];
			},
		],
		[
			"a malformed source dimension",
			(goal) => {
				goal.inputHeight = NaN;
			},
		],
		[
			"a candidate above the source",
			(goal) => {
				goal.inputHeight = 1400;
			},
		],
		[
			"a mixed width/height basis",
			(goal) => {
				goal.rows = goal.rows?.map((row, i) =>
					i === 0 ? { ...row, width: 480 } : row,
				);
			},
		],
		[
			"two highest fixed templates",
			(goal) => {
				goal.rows = goal.rows?.map((row) =>
					row.id === "fixed-c" ? { ...row, height: 960 } : row,
				);
			},
		],
		[
			"a duplicated row identity",
			(goal) => {
				goal.automaticTemplates = goal.automaticTemplates?.map((row, i) =>
					i === 0 ? { ...row, id: "fixed-a" } : row,
				);
			},
		],
		[
			"an optimized fixed selection",
			(goal) => {
				goal.rows = goal.rows?.map((row) => ({
					...row,
					bitrateSelectionMode: "OPTIMIZED",
				}));
			},
		],
		[
			"a missing complexity boundary",
			(goal) => {
				goal.rows = goal.rows?.map((row, i) =>
					i === 0
						? { ...row, highComplexityBoundaryForMaxBitrate: undefined }
						: row,
				);
			},
		],
		[
			"an overlapping fixed band",
			(goal) => {
				goal.rows = goal.rows?.map((row, i) =>
					i === 1 ? { ...row, minBitrate: 300_000 } : row,
				);
			},
		],
		[
			"a reused first fixed band",
			(goal) => {
				goal.rows = goal.rows?.map((row, i) =>
					i === 0 ? { ...row, maxBitrate: 520_000 } : row,
				);
			},
		],
		[
			"a gap before the first band",
			(goal) => {
				goal.maxBitrateStepSize = 2;
			},
		],
		[
			"room for two upper targets",
			(goal) => {
				goal.rows = goal.rows?.map((row, i) =>
					i === 3
						? { ...row, minBitrate: 1_600_000, maxBitrate: 1_900_000 }
						: row,
				);
			},
		],
		[
			"a forced fallback over the cap",
			(goal) => {
				goal.fixedResolutionAndBitrateConfiguration = {
					...forced,
					forcedRenditionAboveHighestFixedRepresentationFactor: 2,
				};
			},
		],
		[
			"two forced fallbacks",
			(goal) => {
				goal.fixedResolutionAndBitrateConfiguration = {
					...forced,
					forcedRenditionAboveHighestFixedRepresentation: 2,
				};
			},
		],
		[
			"an unsupported forced mode",
			(goal) => {
				goal.fixedResolutionAndBitrateConfiguration = {
					...forced,
					forcedRenditionAboveHighestFixedRepresentationCalculationMode:
						"MAXIMUM",
				};
			},
		],
		[
			"a missing forced factor",
			(goal) => {
				goal.fixedResolutionAndBitrateConfiguration = {
					...forced,
					forcedRenditionAboveHighestFixedRepresentationFactor: undefined,
				};
			},
		],
		[
			"an unsupported forced field",
			(goal) => {
				goal.fixedResolutionAndBitrateConfiguration = {
					...forced,
					unsupported: true,
				} as typeof forced;
			},
		],
		[
			"a one-role discrepancy",
			(goal) => {
				goal.countPolicy = { kind: "exact", count: 7 };
			},
		],
		[
			"an API-invalid global floor",
			(goal) => {
				goal.minBitrate = 9_999;
			},
		],
		[
			"an unsupported global field",
			(goal) => {
				goal.targetQualityQp = 20;
			},
		],
	];
	for (const [label, mutate] of invalidGoals) {
		it(`does not certify ${label}`, () => {
			const goal = mixed();
			const api = recommendPerTitleSettings(goal).api;
			mutate(goal);
			expect(certifyPerTitleMixedSequence(goal, api)).toBeNull();
		});
	}

	const staleApis: Array<[string, (api: PerTitleApiSettings) => void]> = [
		[
			"overall bounds",
			(api) => {
				api.global.maxBitrate++;
			},
		],
		[
			"minimum spacing",
			(api) => {
				api.global.minBitrateStepSize = 1.6;
			},
		],
		[
			"maximum spacing",
			(api) => {
				api.global.maxBitrateStepSize = 5;
			},
		],
		[
			"forcing",
			(api) => {
				api.global.fixedResolutionAndBitrateConfiguration = {
					...forced,
					forcedRenditionAboveHighestFixedRepresentationFactor: 1.3,
				};
			},
		],
		[
			"a fixed endpoint",
			(api) => {
				const setting = api.streams[0]?.perTitleSettings;
				if (setting?.maxBitrate !== undefined) setting.maxBitrate++;
			},
		],
		[
			"a fixed selection mode",
			(api) => {
				const setting = api.streams[0]?.perTitleSettings;
				if (setting) setting.bitrateSelectionMode = "OPTIMIZED";
			},
		],
		[
			"an automatic mode",
			(api) => {
				const row = api.streams.find((row) => row.rowId === "upper-a");
				if (row) row.mode = "PER_TITLE_TEMPLATE_FIXED_RESOLUTION";
			},
		],
		[
			"a duplicate stream",
			(api) => {
				api.streams.push({
					...(api.streams[0] as PerTitleApiSettings["streams"][number]),
				});
			},
		],
		[
			"automatic generation",
			(api) => {
				api.global.autoRepresentations = {};
			},
		],
		[
			"malformed rows",
			(api) => {
				api.streams[0] =
					null as unknown as PerTitleApiSettings["streams"][number];
			},
		],
		[
			"a malformed rule",
			(api) => {
				api.global.fixedResolutionAndBitrateConfiguration =
					[] as unknown as typeof forced;
			},
		],
	];
	for (const [label, mutate] of staleApis) {
		it(`does not transfer proof to stale ${label}`, () => {
			const goal = mixed();
			const api = structuredClone(recommendPerTitleSettings(goal).api);
			mutate(api);
			expect(certifyPerTitleMixedSequence(goal, api)).toBeNull();
		});
	}

	it("requires the arithmetic conditions even when goal and API are edited together", () => {
		for (const [, mutate] of invalidGoals) {
			const goal = mixed();
			mutate(goal);
			const result = recommendPerTitleSettings(goal);
			expect(result.derivation?.constraints?.conditionalModel).toBeUndefined();
			expect(result.derivation?.targetSatisfied).not.toBe(true);
		}
	});
});
