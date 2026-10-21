import { describe, expect, it } from "vitest";
import {
	type PerTitleGoal,
	type PerTitleProposal,
	recommendPerTitleSettings,
} from "./per-title-simulator";

const mixed: PerTitleGoal = {
	strategy: "fixed-ranges",
	codec: "H264",
	minBitrate: 100_000,
	maxBitrate: 2_400_000,
	countPolicy: { kind: "unrestricted" },
	rows: [
		{ id: "small", height: 240, minBitrate: 160_000, maxBitrate: 200_000 },
		{ id: "medium", height: 480, minBitrate: 400_000, maxBitrate: 480_000 },
		{ id: "large", height: 720, minBitrate: 1_000_000, maxBitrate: 1_200_000 },
	],
	automaticTemplates: [
		{ id: "candidate-small", height: 180 },
		{ id: "candidate-large", height: 1080 },
	],
};

const requiredStreams = (proposal: PerTitleProposal) =>
	proposal.api.streams.filter(
		(stream) =>
			stream.mode === "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
	);

function expectUnproven(proposal: PerTitleProposal) {
	expect(proposal.applicable).toBe(false);
	expect(proposal.status).not.toBe("candidate");
	expect(proposal.derivation?.targetSatisfied).toBe(false);
	expect(proposal.derivation?.constraints?.status).toBe("unknown");
	expect(proposal.countGuarantee).toBe(false);
	expect(proposal.derivation?.selectedMinStep).toBe(
		proposal.api.global.minBitrateStepSize,
	);
	expect(proposal.derivation?.selectedMaxStep).toBe(
		proposal.api.global.maxBitrateStepSize,
	);
}

describe("conditional Per-Title calibration", () => {
	it("emits calibrated fixed rows while retaining every automatic candidate", () => {
		const before = structuredClone(mixed);
		const result = recommendPerTitleSettings(mixed);
		for (const stream of requiredStreams(result)) {
			expect(stream.perTitleSettings).toMatchObject({
				bitrateSelectionMode: "COMPLEXITY_RANGE",
				lowComplexityBoundaryForMaxBitrate: 1_000_000,
				highComplexityBoundaryForMaxBitrate: 2_400_000,
			});
		}
		expect(requiredStreams(result)).toHaveLength(3);
		expect(
			result.api.streams
				.filter((stream) => stream.mode === "PER_TITLE_TEMPLATE")
				.map((stream) => [
					stream.rowId,
					stream.height,
					stream.perTitleSettings,
				]),
		).toEqual([
			["candidate-small", 180, undefined],
			["candidate-large", 1080, undefined],
		]);
		expectUnproven(result);
		expect(result.derivation?.constraints?.scope).toBe("conditional");
		expect(mixed).toEqual(before);
	});

	it("recalculates missing upper boundaries when the overall maximum changes", () => {
		const initial = recommendPerTitleSettings(mixed);
		const enlarged = recommendPerTitleSettings({
			...mixed,
			maxBitrate: 3_600_000,
		});
		for (const [index, stream] of requiredStreams(enlarged).entries()) {
			expect(stream.perTitleSettings?.highComplexityBoundaryForMaxBitrate).toBe(
				3_600_000,
			);
			expect(
				requiredStreams(initial)[index]?.perTitleSettings
					?.highComplexityBoundaryForMaxBitrate,
			).toBe(2_400_000);
			expect(stream.perTitleSettings?.minBitrate).toBe(
				mixed.rows?.[index]?.minBitrate,
			);
			expect(stream.perTitleSettings?.maxBitrate).toBe(
				mixed.rows?.[index]?.maxBitrate,
			);
		}
		expectUnproven(enlarged);
	});

	it("keeps an unrestricted closed candidate applicable without certifying a total count", () => {
		const result = recommendPerTitleSettings({
			...mixed,
			automaticTemplates: [],
		});
		expect(requiredStreams(result)).toHaveLength(3);
		expect(result.derivation?.constraints?.calibration).toMatchObject({
			low: 1_000_000,
			high: 2_400_000,
			rowIds: ["small", "medium", "large"],
		});
		expect(result.applicable).toBe(true);
		expect(result.status).toBe("candidate");
		expect(result.derivation?.targetSatisfied).toBe(false);
		expect(result.derivation?.constraints?.status).toBe("unknown");
		expect(result.countGuarantee).toBe(false);
		expect(result.derivation?.minimumStepRange).toBeUndefined();
		expect(
			result.scenarios.every((scenario) => scenario.modelCountRange === null),
		).toBe(true);
	});

	it("keeps an exact mixed count and equal-resolution order unproven", () => {
		const result = recommendPerTitleSettings({
			...mixed,
			countPolicy: { kind: "exact", count: 5 },
			rows: mixed.rows?.map((row) =>
				row.id === "small" ? { ...row, height: 480 } : row,
			),
		});
		for (const stream of requiredStreams(result))
			expect(stream.perTitleSettings?.bitrateSelectionMode).toBe(
				"COMPLEXITY_RANGE",
			);
		expectUnproven(result);
		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({ code: "row-order-unknown" }),
		);
	});

	it("preserves explicit complexity boundaries instead of recalibrating them", () => {
		const result = recommendPerTitleSettings({
			...mixed,
			rows: mixed.rows?.map((row) =>
				row.id === "small"
					? {
							...row,
							bitrateSelectionMode: "COMPLEXITY_RANGE",
							lowComplexityBoundaryForMaxBitrate: 600_000,
							highComplexityBoundaryForMaxBitrate: 4_000_000,
						}
					: row,
			),
		});
		expect(requiredStreams(result)[0]?.perTitleSettings).toMatchObject({
			bitrateSelectionMode: "COMPLEXITY_RANGE",
			lowComplexityBoundaryForMaxBitrate: 600_000,
			highComplexityBoundaryForMaxBitrate: 4_000_000,
		});
		expect(result.derivation?.constraints?.calibration?.rowIds).toEqual([
			"medium",
			"large",
		]);
		expectUnproven(result);
	});

	it("does not replace an explicit optimized selection when preparation is unavailable", () => {
		const result = recommendPerTitleSettings({
			...mixed,
			rows: mixed.rows?.map((row) => ({
				...row,
				bitrateSelectionMode: "OPTIMIZED",
			})),
		});
		for (const stream of requiredStreams(result)) {
			expect(stream.perTitleSettings?.bitrateSelectionMode).toBe("OPTIMIZED");
			expect(
				stream.perTitleSettings?.lowComplexityBoundaryForMaxBitrate,
			).toBeUndefined();
			expect(
				stream.perTitleSettings?.highComplexityBoundaryForMaxBitrate,
			).toBeUndefined();
		}
		expect(result.derivation?.constraints?.calibration).toBeUndefined();
		expect(result.derivation?.constraints?.inputRange).toBeNull();
	});

	it("retains explicit zero-count rule metadata in the API and conditional report", () => {
		const configuration = {
			forcedRenditionAboveHighestFixedRepresentation: 0,
			forcedRenditionAboveHighestFixedRepresentationFactor: 1.25,
			forcedRenditionAboveHighestFixedRepresentationCalculationMode:
				"MINIMUM" as const,
		};
		const result = recommendPerTitleSettings({
			...mixed,
			fixedResolutionAndBitrateConfiguration: configuration,
		});
		expect(result.api.global.fixedResolutionAndBitrateConfiguration).toEqual(
			configuration,
		);
		expect(result.derivation?.constraints?.forced).toMatchObject({
			count: 0,
			factor: 1.25,
			calculationMode: "MINIMUM",
			conditional: true,
			ranges: [],
		});
		expectUnproven(result);
	});

	it("withholds trial arithmetic when the returned interval settings use different steps", () => {
		const result = recommendPerTitleSettings({
			...mixed,
			countPolicy: { kind: "exact", count: 5 },
			minBitrateStepSize: 1.9,
			maxBitrateStepSize: 3,
		});
		for (const stream of requiredStreams(result))
			expect(stream.perTitleSettings?.bitrateSelectionMode).toBe(
				"COMPLEXITY_RANGE",
			);
		expectUnproven(result);
		expect(result.derivation?.constraints?.inputRange).toBeNull();
		expect(result.derivation?.constraints?.floorRange).toBeNull();
		expect(result.derivation?.constraints?.calibration).toBeUndefined();
		expect(result.derivation?.constraints?.spacing).toBeUndefined();
		expect(result.derivation?.constraints?.changes).toEqual([]);
		expect(result.derivation?.constraints?.checkpoints).toEqual([]);
	});
});
