import { describe, expect, it } from "vitest";
import { previewPerTitleOutput } from "./per-title-output-preview.js";
import {
	type PerTitleGoal,
	type PerTitleProposal,
	recommendPerTitleSettings,
} from "./per-title-simulator.js";

function required<T>(value: T | undefined): T {
	if (value === undefined) throw new Error("Expected a fixture value");
	return value;
}

const fixed: PerTitleGoal = {
	strategy: "fixed-ranges",
	codec: "H264",
	minBitrate: 100_000,
	maxBitrate: 2_400_000,
	countPolicy: { kind: "exact", count: 3 },
	rows: [
		{ id: "a", height: 240, minBitrate: 160_000, maxBitrate: 200_000 },
		{ id: "b", height: 480, minBitrate: 400_000, maxBitrate: 480_000 },
		{ id: "c", height: 720, minBitrate: 1_000_000, maxBitrate: 1_200_000 },
	],
};

function conditional(): PerTitleProposal {
	return {
		id: "baseline",
		codec: "H264",
		status: "unknown",
		applicable: false,
		evidence: "model-only",
		countGuarantee: false,
		api: {
			global: {
				minBitrate: 100,
				maxBitrate: 1000,
				minBitrateStepSize: 1.2,
				maxBitrateStepSize: 4,
			},
			streams: [
				{
					rowId: "fixed",
					height: 360,
					width: 640,
					mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
					perTitleSettings: {
						minBitrate: 200,
						maxBitrate: 400,
						bitrateSelectionMode: "COMPLEXITY_RANGE",
						lowComplexityBoundaryForMaxBitrate: 100,
						highComplexityBoundaryForMaxBitrate: 2000,
					},
				},
			],
		},
		scenarios: [],
		diagnostics: [],
	};
}

function mixed(): PerTitleProposal {
	const proposal = conditional();
	required(proposal.api.streams[0]).width = undefined;
	proposal.api.streams.push(
		{ rowId: "small", height: 180, mode: "PER_TITLE_TEMPLATE" },
		{ rowId: "large", height: 900, mode: "PER_TITLE_TEMPLATE" },
		{ rowId: "largest", height: 1080, mode: "PER_TITLE_TEMPLATE" },
	);
	proposal.api.global.fixedResolutionAndBitrateConfiguration = {
		forcedRenditionAboveHighestFixedRepresentation: 1,
		forcedRenditionAboveHighestFixedRepresentationFactor: 1.25,
		forcedRenditionAboveHighestFixedRepresentationCalculationMode:
			"LAST_CALCULATED_BITRATE",
	};
	return proposal;
}

describe("Per-Title output previews", () => {
	it("starts the unique smaller explicit template at the global minimum", () => {
		const proposal = mixed();
		const before = structuredClone(proposal);
		expect(previewPerTitleOutput(proposal).rows).toContainEqual(
			expect.objectContaining({
				rowId: "small",
				kind: "automatic",
				basis: "minimum",
				status: "conditional",
				bitrate: 100,
			}),
		);
		expect(proposal).toEqual(before);
	});

	it("shows a conditional LAST_CALCULATED_BITRATE addition on the highest explicit template", () => {
		const result = previewPerTitleOutput(mixed());
		expect(result.rows).toContainEqual(
			expect.objectContaining({
				rowId: "largest",
				basis: "forced",
				status: "conditional",
				bitrate: 368,
			}),
		);
		expect(result.rows.find((row) => row.rowId === "large")).toMatchObject({
			status: "unknown",
		});
		expect(result.status).toBe("partial");
	});

	it("rounds each conditional additional step and does not clip it to the global maximum", () => {
		const proposal = mixed();
		const rule = required(
			proposal.api.global.fixedResolutionAndBitrateConfiguration,
		);
		rule.forcedRenditionAboveHighestFixedRepresentation = 2;
		rule.forcedRenditionAboveHighestFixedRepresentationFactor = 2.1;
		expect(
			previewPerTitleOutput(proposal)
				.rows.filter((row) => row.basis === "forced")
				.map((row) => row.bitrate),
		).toEqual([617, 1296]);
	});

	it("does not bind arithmetic examples to templates expanded by autoRepresentations", () => {
		const proposal = mixed();
		proposal.api.global.autoRepresentations = {};
		const result = previewPerTitleOutput(proposal);
		expect(
			result.rows
				.filter((row) => row.kind === "automatic")
				.every((row) => row.status === "unknown" && row.bitrate === undefined),
		).toBe(true);
		expect(result.unresolvedAdditional).toBe(true);
	});

	it("does not choose among several lower candidates or bind an unresolved dimension order", () => {
		const proposal = mixed();
		proposal.api.streams.push({
			rowId: "another-small",
			height: 240,
			mode: "PER_TITLE_TEMPLATE",
		});
		expect(
			previewPerTitleOutput(proposal).rows.every(
				(row) => row.basis !== "minimum",
			),
		).toBe(true);
		required(proposal.api.streams[0]).width = 640;
		expect(
			previewPerTitleOutput(proposal).rows.every(
				(row) => row.basis === undefined,
			),
		).toBe(true);
	});

	it("requires room below the first fixed bound for a minimum example", () => {
		const proposal = mixed();
		const settings = required(proposal.api.streams[0]?.perTitleSettings);
		settings.minBitrate = 100;
		settings.maxBitrate = 110;
		settings.bitrateSelectionMode = "OPTIMIZED";
		expect(
			previewPerTitleOutput(proposal).rows.every(
				(row) => row.basis !== "minimum",
			),
		).toBe(true);
	});

	it("does not turn a range outside the global limits into a simulated ladder", () => {
		const proposal = mixed();
		required(proposal.api.streams[0]?.perTitleSettings).maxBitrate = 40_000_000;
		expect(
			previewPerTitleOutput(proposal).rows.every(
				(row) => row.bitrate === undefined,
			),
		).toBe(true);
	});

	it("exposes a checked upper arithmetic example without changing the proposal", () => {
		const proposal = recommendPerTitleSettings(fixed);
		const before = structuredClone(proposal);
		const upper = proposal.scenarios.find(
			(scenario) => scenario.fraction === 1,
		);
		expect(upper?.status).toBe("modelled");
		const result = previewPerTitleOutput(proposal);
		expect(result).toMatchObject({
			analysisInput: fixed.maxBitrate,
			status: "example",
			unresolvedAdditional: false,
		});
		expect(result.rows.map((row) => row.bitrate)).toEqual(
			upper?.modelRungs.map((rung) => rung.bitrate),
		);
		expect(
			result.rows.every(
				(row) => row.kind === "fixed" && row.status === "example",
			),
		).toBe(true);
		expect(proposal).toEqual(before);
	});

	it("uses additional numeric rows only from a checked closed-model branch", () => {
		const proposal = recommendPerTitleSettings({
			...fixed,
			countPolicy: { kind: "exact", count: 5 },
		});
		const result = previewPerTitleOutput(proposal);
		expect(result.status).toBe("example");
		expect(result.rows).toHaveLength(5);
		expect(result.rows.filter((row) => row.kind === "additional")).toHaveLength(
			2,
		);
		expect(result.unresolvedAdditional).toBe(false);
		expect(result.rows.at(-1)?.bitrate).toBeLessThanOrEqual(fixed.maxBitrate);
		required(proposal.derivation?.constraints).status = "unknown";
		const unresolved = previewPerTitleOutput(proposal);
		expect(unresolved.rows.every((row) => row.kind !== "additional")).toBe(
			true,
		);
		expect(unresolved.unresolvedAdditional).toBe(true);
		expect(unresolved.status).toBe("partial");
	});

	it("keeps equal-height mixed templates as conditional fixed rows and unresolved automatic candidates", () => {
		const proposal = recommendPerTitleSettings({
			...fixed,
			rows: fixed.rows?.map((row, index) => ({
				...row,
				height: index < 2 ? 360 : 720,
			})),
			automaticTemplates: [
				{ id: "small-candidate", height: 180 },
				{ id: "large-candidate", height: 1080 },
			],
			fixedResolutionAndBitrateConfiguration: {
				forcedRenditionAboveHighestFixedRepresentation: 1,
				forcedRenditionAboveHighestFixedRepresentationFactor: 1.3,
				forcedRenditionAboveHighestFixedRepresentationCalculationMode:
					"LAST_CALCULATED_BITRATE",
			},
		});
		const before = structuredClone(proposal);
		expect(
			proposal.api.streams[0]?.perTitleSettings?.bitrateSelectionMode,
		).toBe("COMPLEXITY_RANGE");
		const result = previewPerTitleOutput(proposal);
		expect(result.status).toBe("partial");
		expect(result.rows.filter((row) => row.kind === "fixed")).toHaveLength(3);
		expect(result.rows.filter((row) => row.kind === "automatic")).toEqual([
			expect.objectContaining({
				rowId: "small-candidate",
				height: 180,
				status: "unknown",
				mode: "PER_TITLE_TEMPLATE",
			}),
			expect.objectContaining({
				rowId: "large-candidate",
				height: 1080,
				status: "unknown",
				mode: "PER_TITLE_TEMPLATE",
			}),
		]);
		expect(
			result.rows
				.filter((row) => row.kind === "automatic")
				.every(
					(row) =>
						row.bitrate === undefined && row.minimumBitrate === undefined,
				),
		).toBe(true);
		expect(result.unresolvedAdditional).toBe(true);
		expect(proposal).toEqual(before);
	});

	it("evaluates only actual emitted settings at the global maximum, not stale scenario fields", () => {
		const proposal = conditional();
		proposal.scenarios = [
			{
				id: "untrusted",
				fraction: 1,
				assumedMaxBitrate: 9000,
				status: "conflict",
				modelCountRange: null,
				rowModels: [
					{
						rowId: "fixed",
						minimumBitrate: 9000,
						maximumBitrate: 9000,
						linearTargetBitrate: 9000,
						boundaryFraction: 1,
					},
				],
				modelRungs: [
					{ rowId: "fixed", height: 360, bitrate: 9000, kind: "required" },
				],
				diagnostics: [],
			},
		];
		expect(previewPerTitleOutput(proposal)).toMatchObject({
			analysisInput: 1000,
			status: "partial",
			rows: [
				{
					kind: "fixed",
					status: "conditional",
					minimumBitrate: 294,
					maximumBitrate: 294,
					bitrate: 294,
				},
			],
		});
	});

	it.each([
		{ lowComplexityBoundaryForMaxBitrate: undefined },
		{ highComplexityBoundaryForMaxBitrate: Number.NaN },
		{
			lowComplexityBoundaryForMaxBitrate: 2000,
			highComplexityBoundaryForMaxBitrate: 100,
		},
		{ minBitrate: 99 },
	])("does not fabricate numbers from invalid fixed settings %j", (change) => {
		const proposal = conditional();
		Object.assign(required(proposal.api.streams[0]?.perTitleSettings), change);
		const result = previewPerTitleOutput(proposal);
		expect(result.status).toBe("unavailable");
		expect(result.rows[0]).toMatchObject({ kind: "fixed", status: "unknown" });
		expect(result.rows[0]?.bitrate).toBeUndefined();
		expect(result.rows[0]?.minimumBitrate).toBeUndefined();
	});

	it("shows automatic candidates separately from anonymous spacing examples", () => {
		const proposal = recommendPerTitleSettings({
			strategy: "automatic",
			codec: "H264",
			minBitrate: 100_000,
			maxBitrate: 2_000_000,
			countPolicy: { kind: "unrestricted" },
			automaticTemplates: [{ id: "candidate", height: 720 }],
		});
		const result = previewPerTitleOutput(proposal);
		expect(result.status).toBe("partial");
		expect(result.rows.filter((row) => row.kind === "automatic")).toEqual([
			expect.objectContaining({
				rowId: "candidate",
				height: 720,
				status: "unknown",
			}),
		]);
		const anonymous = result.rows.filter((row) => row.kind === "unassigned");
		expect(anonymous.length).toBeGreaterThan(0);
		expect(
			anonymous.every(
				(row) =>
					row.height === undefined &&
					row.rowId === undefined &&
					row.status === "example",
			),
		).toBe(true);
	});

	it("rejects a stale upper example after emitted row settings change", () => {
		const proposal = recommendPerTitleSettings(fixed);
		required(proposal.api.streams[0]?.perTitleSettings).maxBitrate = 180_000;
		const result = previewPerTitleOutput(proposal);
		expect(result.status).toBe("partial");
		expect(result.rows[0]).toMatchObject({
			status: "conditional",
			bitrate: 180_000,
		});
		expect(result.rows.every((row) => row.status !== "example")).toBe(true);
	});

	it("does not pick one of several contradictory upper examples", () => {
		const proposal = recommendPerTitleSettings(fixed);
		proposal.scenarios.push(
			structuredClone(
				required(
					proposal.scenarios.find((scenario) => scenario.fraction === 1),
				),
			),
		);
		expect(previewPerTitleOutput(proposal).status).toBe("partial");
	});

	it("does not accept mismatched dimensions or missing required coverage", () => {
		const proposal = recommendPerTitleSettings(fixed);
		const upper = required(
			proposal.scenarios.find((scenario) => scenario.fraction === 1),
		);
		required(upper.modelRungs[0]).height = 999;
		expect(
			previewPerTitleOutput(proposal).rows.every(
				(row) => row.status !== "example",
			),
		).toBe(true);
		upper.modelRungs.shift();
		expect(previewPerTitleOutput(proposal).status).toBe("partial");
	});

	it("does not show a joint example that violates the emitted ordinary steps", () => {
		const proposal = recommendPerTitleSettings(fixed);
		proposal.api.global.minBitrateStepSize = 3;
		proposal.api.global.maxBitrateStepSize = 4;
		const result = previewPerTitleOutput(proposal);
		expect(result.status).toBe("partial");
		expect(result.rows.every((row) => row.status !== "example")).toBe(true);
	});

	it("does not reuse additional points after their emitted rule changes", () => {
		const proposal = recommendPerTitleSettings({
			...fixed,
			countPolicy: { kind: "exact", count: 5 },
		});
		required(
			proposal.api.global.fixedResolutionAndBitrateConfiguration,
		).forcedRenditionAboveHighestFixedRepresentationFactor = 1.01;
		const result = previewPerTitleOutput(proposal);
		expect(result.unresolvedAdditional).toBe(true);
		expect(result.rows.every((row) => row.kind !== "additional")).toBe(true);
	});

	it("keeps malformed duplicate identifiers unique in the view without using them for numeric proof", () => {
		const proposal = conditional();
		proposal.api.streams.push(
			structuredClone(required(proposal.api.streams[0])),
		);
		proposal.api.streams.push({
			rowId: "fixed",
			height: 180,
			mode: "PER_TITLE_TEMPLATE",
		});
		const result = previewPerTitleOutput(proposal);
		expect(new Set(result.rows.map((row) => row.id)).size).toBe(3);
		expect(
			result.rows.every(
				(row) => row.status === "unknown" && row.bitrate === undefined,
			),
		).toBe(true);
	});

	it("keeps resolution-only and optimized rows unknown without a justified example", () => {
		const proposal = conditional();
		required(proposal.api.streams[0]?.perTitleSettings).bitrateSelectionMode =
			"OPTIMIZED";
		proposal.api.streams.push({
			rowId: "resolution",
			height: 720,
			mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION",
		});
		const result = previewPerTitleOutput(proposal);
		expect(result.status).toBe("unavailable");
		expect(
			result.rows.every(
				(row) => row.status === "unknown" && row.bitrate === undefined,
			),
		).toBe(true);
		expect(result.rows[0]?.width).toBe(640);
	});

	it("keeps candidates visible with unavailable global inputs and incomplete additional settings", () => {
		const proposal = conditional();
		proposal.api.global.maxBitrate = Number.NaN;
		proposal.api.global.fixedResolutionAndBitrateConfiguration = {};
		proposal.api.streams.push({
			rowId: "candidate",
			mode: "PER_TITLE_TEMPLATE",
		});
		const result = previewPerTitleOutput(proposal);
		expect(result.analysisInput).toBeNull();
		expect(result.status).toBe("unavailable");
		expect(result.rows).toHaveLength(2);
		expect(result.rows.every((row) => row.bitrate === undefined)).toBe(true);
		expect(result.unresolvedAdditional).toBe(true);
	});
});
