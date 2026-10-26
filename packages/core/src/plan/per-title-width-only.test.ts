import { describe, expect, it } from "vitest";
import { resolvePerTitleAnalysis } from "./per-title-output-analysis";
import { previewPerTitleOutput } from "./per-title-output-preview";
import {
	type PerTitleGoal,
	recommendPerTitleSettings,
} from "./per-title-simulator";

function closed(axis: "height" | "width"): PerTitleGoal {
	return {
		strategy: "fixed-ranges",
		codec: "H264",
		minBitrate: 100_000,
		maxBitrate: 2_400_000,
		countPolicy: { kind: "exact", count: 3 },
		autoRepresentations: false,
		rows: [320, 640, 1280].map((size, index) => ({
			id: `fixed-${index}`,
			...(axis === "width" ? { width: size } : { height: size }),
			minBitrate: [160_000, 400_000, 1_000_000][index],
			maxBitrate: [200_000, 480_000, 1_200_000][index],
		})),
	};
}

describe("width-only Per-Title goals", () => {
	it("keeps a width-only global source extent on the emitted ordinary template", () => {
		const proposal = recommendPerTitleSettings({
			strategy: "automatic",
			codec: "H264",
			minBitrate: 100_000,
			maxBitrate: 2_400_000,
			inputWidth: 1920,
			countPolicy: { kind: "unrestricted" },
		});
		expect(proposal.applicable).toBe(true);
		expect(proposal.api.streams).toEqual([
			{
				rowId: "automatic-template",
				width: 1920,
				mode: "PER_TITLE_TEMPLATE",
			},
		]);
		expect(proposal.countGuarantee).toBe(false);
	});

	it.each([
		3, 4,
	])("emits fixed widths without materializing a height and keeps the height-only arithmetic for %i outputs", (count) => {
		const goal = closed("width");
		goal.countPolicy = { kind: "exact", count };
		const before = structuredClone(goal);
		const proposal = recommendPerTitleSettings(goal);
		const heightOnly = recommendPerTitleSettings({
			...closed("height"),
			countPolicy: { kind: "exact", count },
		});
		expect(heightOnly.applicable).toBe(true);
		expect(proposal.applicable).toBe(true);
		expect(proposal.countGuarantee).toBe(false);
		expect(proposal.api.streams.map(({ width }) => width)).toEqual([
			320, 640, 1280,
		]);
		for (const stream of proposal.api.streams)
			expect(Object.hasOwn(stream, "height")).toBe(false);
		expect(proposal.api.global).toEqual(heightOnly.api.global);
		expect(
			proposal.scenarios.every((scenario) =>
				scenario.modelRungs.every(
					(rung) => rung.width !== undefined && !Object.hasOwn(rung, "height"),
				),
			),
		).toBe(true);
		expect(
			proposal.scenarios.map((scenario) =>
				scenario.modelRungs.map(({ rowId, bitrate }) => ({ rowId, bitrate })),
			),
		).toEqual(
			heightOnly.scenarios.map((scenario) =>
				scenario.modelRungs.map(({ rowId, bitrate }) => ({ rowId, bitrate })),
			),
		);
		expect(goal).toEqual(before);
	});

	it("keeps fixed-resolution and fixed-range roles distinct in one width-only goal", () => {
		const goal: PerTitleGoal = {
			...closed("width"),
			minBitrateStepSize: 1.5,
			maxBitrateStepSize: 4,
			countPolicy: { kind: "unrestricted" },
			inputWidth: 2560,
			rows: [
				{
					id: "resolution",
					width: 1920,
					mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION",
					minBitrate: 1,
					maxBitrate: 2,
				},
				{
					id: "range",
					width: 640,
					mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
					minBitrate: 200_000,
					maxBitrate: 300_000,
				},
			],
			automaticTemplates: [
				{ id: "lower", width: 320 },
				{ id: "upper", width: 2560 },
			],
		};
		const before = structuredClone(goal);
		const proposal = recommendPerTitleSettings(goal);
		expect(proposal.applicable).toBe(true);
		expect(proposal.api.streams.map(({ rowId }) => rowId)).toEqual([
			"range",
			"resolution",
			"lower",
			"upper",
		]);
		expect(proposal.api.streams[1]?.perTitleSettings).toBeUndefined();
		expect(resolvePerTitleAnalysis(proposal.api, 100_000)).toMatchObject({
			floor: 300_000,
			usesAspectRatioAssumption: false,
		});
		expect(goal).toEqual(before);
	});

	it.each([
		"PER_TITLE_TEMPLATE_FIXED_RESOLUTION",
		"PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
	] as const)("preserves an explicit %s with ordinary width-only candidates", (mode) => {
		const goal: PerTitleGoal = {
			...closed("width"),
			minBitrateStepSize: 1.5,
			maxBitrateStepSize: 4,
			countPolicy: { kind: "unrestricted" },
			rows: [
				{
					id: "fixed",
					width: 640,
					mode,
					minBitrate: 200_000,
					maxBitrate: 200_000,
				},
			],
			automaticTemplates: [
				{ id: "lower", width: 320 },
				{ id: "upper", width: 1280 },
			],
		};
		const proposal = recommendPerTitleSettings(goal);
		expect(proposal.applicable).toBe(true);
		expect(
			proposal.api.streams.map((stream) => [
				stream.rowId,
				stream.width,
				stream.mode,
			]),
		).toEqual([
			["fixed", 640, mode],
			["lower", 320, "PER_TITLE_TEMPLATE"],
			["upper", 1280, "PER_TITLE_TEMPLATE"],
		]);
		for (const stream of proposal.api.streams)
			expect(Object.hasOwn(stream, "height")).toBe(false);
		expect(proposal.countGuarantee).toBe(false);
		if (mode === "PER_TITLE_TEMPLATE_FIXED_RESOLUTION")
			expect(proposal.api.streams[0]?.perTitleSettings).toBeUndefined();
		else {
			expect(resolvePerTitleAnalysis(proposal.api, 100_000)).toMatchObject({
				floor: 200_000,
				usesAspectRatioAssumption: false,
			});
			expect(
				previewPerTitleOutput(proposal).rows.some(
					(row) => row.basis === "minimum",
				),
			).toBe(true);
		}
	});

	it("uses common heights when only some rows also declare widths", () => {
		const goal = closed("height");
		goal.rows = goal.rows?.map((row, index) =>
			index === 0 ? { ...row, width: 640 } : row,
		);
		const proposal = recommendPerTitleSettings(goal);
		expect(proposal.applicable).toBe(true);
		expect(resolvePerTitleAnalysis(proposal.api, 100_000)).toMatchObject({
			floor: 1_000_000,
			complexityInput: 1_000_000,
			usesAspectRatioAssumption: true,
		});
	});

	it("withholds applicability for incomparable fixed widths and heights without changing raw dimensions", () => {
		const goal = closed("width");
		goal.rows = [
			{ id: "height", height: 320, minBitrate: 100_000, maxBitrate: 100_000 },
			{ id: "width", width: 1280, minBitrate: 400_000, maxBitrate: 400_000 },
		];
		goal.countPolicy = { kind: "unrestricted" };
		const before = structuredClone(goal);
		const proposal = recommendPerTitleSettings(goal);
		expect(proposal.applicable).toBe(false);
		expect(proposal.status).toBe("unknown");
		expect(
			proposal.diagnostics.some(({ code }) => code === "row-order-unknown"),
		).toBe(true);
		expect(
			proposal.diagnostics.some(({ code }) => code === "invalid-row"),
		).toBe(false);
		expect(proposal.api.streams).toEqual([
			expect.objectContaining({ rowId: "height", height: 320 }),
			expect.objectContaining({ rowId: "width", width: 1280 }),
		]);
		expect(Object.hasOwn(proposal.api.streams[0] ?? {}, "width")).toBe(false);
		expect(Object.hasOwn(proposal.api.streams[1] ?? {}, "height")).toBe(false);
		expect(goal).toEqual(before);
	});

	it("withholds applicability when fixed and ordinary dimensions have no shared axis", () => {
		const proposal = recommendPerTitleSettings({
			...closed("width"),
			countPolicy: { kind: "unrestricted" },
			automaticTemplates: [{ id: "height-only", height: 1600 }],
		});
		expect(proposal.applicable).toBe(false);
		expect(proposal.status).toBe("unknown");
		expect(proposal.derivation?.targetSatisfied).toBe(false);
		expect(
			previewPerTitleOutput(proposal).rows.every(
				(row) => row.basis === undefined,
			),
		).toBe(true);
	});

	it("retains an invalid explicit height even when a width could otherwise be used", () => {
		const goal = closed("width");
		goal.rows = goal.rows?.map((row, index) =>
			index === 0 ? { ...row, height: Number.NaN } : row,
		);
		const before = structuredClone(goal);
		const proposal = recommendPerTitleSettings(goal);
		expect(proposal.applicable).toBe(false);
		expect(
			proposal.diagnostics.some(({ code }) => code === "invalid-row"),
		).toBe(true);
		expect(goal).toEqual(before);
	});
});
