import { describe, expect, it } from "vitest";
import {
	buildPerTitleSetup,
	type PerTitleSetupInput,
} from "./per-title-guided-setup-model";
import { assessPerTitleCountStructure } from "./per-title-simulator-analysis-count";
import { tunePerTitleSettings } from "./per-title-simulator-tuning";

const requirements = (): PerTitleSetupInput => ({
	strategy: "fixed-ranges",
	codec: "H264",
	minBitrate: 160_000,
	maxBitrate: 5_000_000,
	inputHeight: 1152,
	count: 6,
	automaticEdges: { lowerHeight: 160, upperHeights: [960, 1152] },
	rows: [
		{ id: "small-a", height: 320, minBitrate: 400_000, maxBitrate: 640_000 },
		{ id: "small-b", height: 320, minBitrate: 750_000, maxBitrate: 1_100_000 },
		{ id: "medium", height: 576, minBitrate: 1_200_000, maxBitrate: 1_700_000 },
		{ id: "large", height: 768, minBitrate: 2_000_000, maxBitrate: 2_800_000 },
	],
});

describe("new mixed Per-Title requirements", () => {
	it.each([
		"H264",
		"H265",
		"VP9",
	] as const)("creates %s ordinary edges and fixed ranges without importing API settings", (codec) => {
		const input = { ...requirements(), codec };
		const before = structuredClone(input);
		const result = buildPerTitleSetup(input);
		expect(result.goal).not.toBeNull();
		expect(result.proposal).not.toBeNull();
		if (!result.goal || !result.proposal) throw Error("Expected a setup");
		const { goal, proposal } = result;
		expect(goal.countPolicy).toEqual({ kind: "exact", count: 6 });
		expect(goal.autoRepresentations).toBe(false);
		expect(goal.automaticTemplates?.map((row) => row.height)).toEqual([
			160, 960, 1152,
		]);
		expect(
			goal.rows?.map((row) => [row.height, row.minBitrate, row.maxBitrate]),
		).toEqual(
			input.rows.map((row) => [row.height, row.minBitrate, row.maxBitrate]),
		);
		const rule = goal.fixedResolutionAndBitrateConfiguration;
		expect(rule?.forcedRenditionAboveHighestFixedRepresentation).toBe(1);
		expect(
			rule?.forcedRenditionAboveHighestFixedRepresentationCalculationMode,
		).toBe("LAST_CALCULATED_BITRATE");
		expect(
			rule?.forcedRenditionAboveHighestFixedRepresentationFactor,
		).toBeGreaterThan(1);
		expect(
			rule?.forcedRenditionAboveHighestFixedRepresentationFactor,
		).toBeLessThan(goal.minBitrateStepSize ?? 0);
		for (const row of goal.rows ?? []) {
			expect(row.bitrateSelectionMode).toBe("COMPLEXITY_RANGE");
			expect(row.highComplexityBoundaryForMaxBitrate).toBe(input.maxBitrate);
		}
		expect(
			new Set(goal.rows?.map((row) => row.lowComplexityBoundaryForMaxBitrate))
				.size,
		).toBe(1);
		expect(goal.targetQualityCrf).toBeUndefined();
		expect(goal.targetQualityQp).toBeUndefined();
		expect(tunePerTitleSettings(goal, goal).proposal.api).toEqual(proposal.api);
		expect(proposal.countGuarantee).toBe(false);
		expect(assessPerTitleCountStructure(goal, proposal)).toMatchObject({
			status: "declared-compatible",
			declaredCount: 6,
			upper: { required: 1, selection: "one-of" },
			nativeCount: "requires-media",
		});
		expect(input).toEqual(before);
	});

	it.each([
		{ automaticEdges: { lowerHeight: 320 } },
		{ automaticEdges: { upperHeights: [768, 960] } },
		{ automaticEdges: { upperHeights: [960, 960] } },
		{ automaticEdges: { upperHeights: [1280] } },
		{ automaticEdges: { lowerHeight: 159.5 } },
		{ automaticEdges: { upperHeights: [Number.NaN] } },
		{ count: 7 },
		{ strategy: "required-resolutions" as const },
	])("rejects incompatible automatic edge requirements %j", (patch) => {
		const result = buildPerTitleSetup({ ...requirements(), ...patch });
		expect(result.status).toBe("conflict");
		expect(result.goal).toBeNull();
		expect(result.proposal).toBeNull();
	});

	it("does not pretend broad ordinary probes prove a native count", () => {
		const input = requirements();
		const result = buildPerTitleSetup(input);
		expect(result.status).toBe("unverified");
		expect(
			result.issues.some((issue) => issue.code === "mixed-count-conditional"),
		).toBe(true);
		expect(result.proposal?.countGuarantee).toBe(false);
	});

	it("rejects a separate starting role with no bitrate room below the fixed band", () => {
		const input = requirements();
		input.rows = input.rows.map((row, index) =>
			index === 0
				? { ...row, minBitrate: input.minBitrate, maxBitrate: 240_000 }
				: row,
		);
		const result = buildPerTitleSetup(input);
		expect(result.status).toBe("conflict");
		expect(result.goal).toBeNull();
	});

	it("leaves a ratio margin against fitting two ordinary upper steps", () => {
		const result = buildPerTitleSetup({
			strategy: "fixed-ranges",
			codec: "H264",
			minBitrate: 100_000,
			maxBitrate: 2_230_000,
			automaticEdges: { lowerHeight: 160, upperHeights: [960] },
			rows: [
				{ id: "small", height: 320, minBitrate: 300_000, maxBitrate: 300_000 },
				{
					id: "large",
					height: 640,
					minBitrate: 1_000_000,
					maxBitrate: 1_000_000,
				},
			],
		});
		expect(result.goal).not.toBeNull();
		const step = result.goal?.minBitrateStepSize ?? 0;
		expect(step).toBeGreaterThan(1.5);
		expect((step - 0.01) ** 2 * 1_000_000).toBeGreaterThan(2_230_000);
		expect(result.proposal?.countGuarantee).toBe(false);
	});

	it.each([
		"H264",
		"H265",
		"VP9",
	] as const)("allocates omitted bands for %s without a preset", (codec) => {
		const input = requirements();
		input.codec = codec;
		input.rows = input.rows.map(({ id, height }) => ({ id, height }));
		delete input.count;
		const result = buildPerTitleSetup(input);
		expect(result.goal?.countPolicy).toEqual({ kind: "exact", count: 6 });
		expect(
			result.goal?.rows?.every(
				(row) =>
					(row.minBitrate ?? 0) >= input.minBitrate &&
					(row.maxBitrate ?? Infinity) <= input.maxBitrate,
			),
		).toBe(true);
		expect(result.status).toBe("unverified");
	});
});
