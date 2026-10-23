import { describe, expect, it } from "vitest";
import { previewPerTitleOutput } from "./per-title-output-preview.js";
import {
	type PerTitleGoal,
	type PerTitleProposal,
	recommendPerTitleSettings,
} from "./per-title-simulator.js";

const automatic: PerTitleGoal = {
	strategy: "automatic",
	codec: "H264",
	minBitrate: 128_000,
	maxBitrate: 4_000_000,
	minBitrateStepSize: 1.5,
	maxBitrateStepSize: 6,
	countPolicy: { kind: "unrestricted" },
	rows: [],
	autoRepresentations: {},
};

function band(): PerTitleProposal {
	return {
		id: "baseline",
		codec: "H264",
		status: "unknown",
		applicable: false,
		evidence: "model-only",
		countGuarantee: false,
		api: {
			global: {
				minBitrate: 100_000,
				maxBitrate: 4_000_000,
				minBitrateStepSize: 1.5,
				maxBitrateStepSize: 1.9,
			},
			streams: [
				{
					rowId: "fixed",
					height: 720,
					mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
					perTitleSettings: {
						minBitrate: 200_000,
						maxBitrate: 1_200_000,
						bitrateSelectionMode: "COMPLEXITY_RANGE",
						lowComplexityBoundaryForMaxBitrate: 400_000,
						highComplexityBoundaryForMaxBitrate: 2_400_000,
					},
				},
			],
		},
		scenarios: [],
		diagnostics: [],
	};
}

function firstStream(proposal: PerTitleProposal) {
	const stream = proposal.api.streams[0];
	if (!stream) throw new Error("Expected a template stream.");
	return stream;
}

function fixedSettings(proposal: PerTitleProposal) {
	const settings = firstStream(proposal).perTitleSettings;
	if (!settings) throw new Error("Expected fixed-range settings.");
	return settings;
}

describe("Per-Title output evidence boundaries", () => {
	it("shows an assumed automatic range instead of minimum-step packing as outputs", () => {
		const proposal = recommendPerTitleSettings(automatic);
		const before = structuredClone(proposal);
		const preview = previewPerTitleOutput(proposal);
		expect(preview.rows.filter((row) => row.kind === "unassigned")).toEqual([]);
		expect(preview.rows).toContainEqual(
			expect.objectContaining({
				kind: "automatic-group",
				status: "conditional",
				minimumBitrate: 128_000,
				maximumBitrate: 4_000_000,
			}),
		);
		expect(preview.rows.every((row) => row.bitrate !== 3_280_500)).toBe(true);
		expect(preview.unresolvedAdditional).toBe(true);
		expect(
			previewPerTitleOutput(proposal, { analysisInput: 2_000_000 }).rows,
		).toContainEqual(
			expect.objectContaining({
				kind: "automatic-group",
				maximumBitrate: 2_000_000,
			}),
		);
		expect(proposal).toEqual(before);
	});

	it("does not turn a non-point complexity interval into its upper target", () => {
		const proposal = band();
		const settings = fixedSettings(proposal);
		settings.lowComplexityBoundaryForMaxBitrate = 200_000;
		settings.highComplexityBoundaryForMaxBitrate = 1_200_000;
		const row = previewPerTitleOutput(proposal, { analysisInput: 600_000 })
			.rows[0];
		expect(row).toMatchObject({
			status: "conditional",
			minimumBitrate: 400_000,
			maximumBitrate: 600_000,
		});
		expect(row?.bitrate).toBeUndefined();
	});

	it.each([
		undefined,
		0,
	])("keeps automatic expansion unresolved without a positive forced rule (%s)", (count) => {
		const proposal = band();
		proposal.api.global.autoRepresentations = {};
		proposal.api.streams.push({
			rowId: "ordinary",
			height: 1080,
			mode: "PER_TITLE_TEMPLATE",
		});
		if (count !== undefined)
			proposal.api.global.fixedResolutionAndBitrateConfiguration = {
				forcedRenditionAboveHighestFixedRepresentation: count,
			};
		const preview = previewPerTitleOutput(proposal);
		expect(preview.unresolvedAdditional).toBe(true);
		expect(preview.rows).toContainEqual(
			expect.objectContaining({ kind: "automatic-group" }),
		);
		expect(preview.rows.every((row) => row.status !== "example")).toBe(true);
	});
	it("does not invent automatic candidates without an ordinary template", () => {
		const proposal = band();
		proposal.api.global.autoRepresentations = {};
		const preview = previewPerTitleOutput(proposal);
		expect(preview.unresolvedAdditional).toBe(true);
		expect(preview.rows.some((row) => row.kind === "automatic-group")).toBe(
			false,
		);
	});

	it.each([
		"fixed",
		"ordinary",
	])("rejects an explicitly invalid height even with a valid width (%s)", (mode) => {
		const proposal =
			mode === "fixed" ? band() : recommendPerTitleSettings(automatic);
		Object.assign(firstStream(proposal), { height: 0, width: 1280 });
		if (mode === "fixed")
			Object.assign(fixedSettings(proposal), {
				maxBitrate: 200_000,
				bitrateSelectionMode: "OPTIMIZED",
			});
		const result = previewPerTitleOutput(proposal);
		expect(result.rows.every((row) => row.bitrate === undefined)).toBe(true);
		expect(result.rows.some((row) => row.kind === "automatic-group")).toBe(
			false,
		);
	});

	it("does not certify a single output from a point near the step tolerance", () => {
		const proposal = band();
		proposal.api.global.minBitrateStepSize = 1.005;
		fixedSettings(proposal).maxBitrate = 200_000;
		const preview = previewPerTitleOutput(proposal);
		expect(preview.rows[0]).toMatchObject({ bitrate: 200_000 });
		expect(preview.unresolvedAdditional).toBe(true);
	});

	it.each([
		[300_000, 200_000],
		[1_600_000, 800_000],
		[3_000_000, 1_200_000],
	])("keeps a content-dependent point conditional at input %s", (input, expected) => {
		const row = previewPerTitleOutput(band(), { analysisInput: input }).rows[0];
		expect(row).toMatchObject({
			status: "conditional",
			bitrate: expected,
			minimumBitrate: expected,
			maximumBitrate: expected,
		});
	});

	it("does not use a spacing witness as the selected value of a narrow closed interval", () => {
		const proposal = recommendPerTitleSettings({
			strategy: "fixed-ranges",
			codec: "H264",
			minBitrate: 100_000,
			maxBitrate: 1_200_000,
			minBitrateStepSize: 1.5,
			maxBitrateStepSize: 1.9,
			countPolicy: { kind: "exact", count: 1 },
			rows: [
				{
					id: "only",
					height: 720,
					minBitrate: 200_000,
					maxBitrate: 1_200_000,
					bitrateSelectionMode: "COMPLEXITY_RANGE",
					lowComplexityBoundaryForMaxBitrate: 250_000,
					highComplexityBoundaryForMaxBitrate: 1_500_000,
				},
			],
			autoRepresentations: false,
		});
		// A spacing witness is not evidence for subsequently emitted step settings.
		proposal.api.global.minBitrateStepSize = 1.5;
		proposal.api.global.maxBitrateStepSize = 1.9;
		const row = previewPerTitleOutput(proposal).rows[0];
		expect(row).toMatchObject({
			status: "conditional",
			minimumBitrate: 800_000,
			maximumBitrate: 960_000,
			bitrate: 800_000,
		});
	});
});
