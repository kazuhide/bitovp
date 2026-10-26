import { describe, expect, it } from "vitest";
import {
	type PerTitleGoal,
	recommendPerTitleSettings,
} from "./per-title-simulator";

const resolution = "PER_TITLE_TEMPLATE_FIXED_RESOLUTION" as const;
const range = "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE" as const;
function mixed(): PerTitleGoal {
	return {
		strategy: "fixed-ranges",
		codec: "H264",
		targetQualityCrf: 17,
		minBitrate: 128_000,
		maxBitrate: 5_000_000,
		minBitrateStepSize: 1.5,
		maxBitrateStepSize: 4,
		countPolicy: { kind: "unrestricted" },
		autoRepresentations: false,
		rows: [
			{ id: "resolution", mode: resolution, height: 320 },
			{
				id: "range",
				mode: range,
				height: 640,
				minBitrate: 1_000_000,
				maxBitrate: 2_000_000,
				bitrateSelectionMode: "COMPLEXITY_RANGE",
				lowComplexityBoundaryForMaxBitrate: 2_000_000,
				highComplexityBoundaryForMaxBitrate: 5_000_000,
			},
		],
		automaticTemplates: [
			{ id: "ordinary" },
			{ id: "dimensioned", height: 160 },
		],
	};
}

describe("explicit Per-Title fixed stream modes", () => {
	it.each([
		"H264",
		"H265",
		"VP9",
		"AV1",
	] as const)("emits every %s stream's declared mode without inventing bitrate bounds", (codec) => {
		const goal = { ...mixed(), codec };
		const snapshot = structuredClone(goal);
		const proposal = recommendPerTitleSettings(goal);
		expect(proposal.applicable).toBe(true);
		expect(proposal.api.global.targetQualityCrf).toBe(17);
		expect(
			proposal.api.streams.find(({ rowId }) => rowId === "resolution"),
		).toEqual({
			rowId: "resolution",
			height: 320,
			mode: resolution,
		});
		expect(
			proposal.api.streams.find(({ rowId }) => rowId === "range"),
		).toMatchObject({
			mode: range,
			perTitleSettings: { minBitrate: 1_000_000, maxBitrate: 2_000_000 },
		});
		expect(
			proposal.api.streams.find(({ rowId }) => rowId === "ordinary"),
		).toEqual({
			rowId: "ordinary",
			mode: "PER_TITLE_TEMPLATE",
		});
		expect(
			proposal.api.streams.find(({ rowId }) => rowId === "dimensioned"),
		).toEqual({
			rowId: "dimensioned",
			mode: "PER_TITLE_TEMPLATE",
			height: 160,
		});
		expect(proposal.countGuarantee).toBe(false);
		expect(goal).toEqual(snapshot);
	});

	it("uses explicit ranged mode even when the strategy supplies resolution-only defaults", () => {
		const goal = mixed();
		goal.strategy = "fixed-resolutions";
		const proposal = recommendPerTitleSettings(goal);
		expect(
			proposal.api.streams.find(({ rowId }) => rowId === "range"),
		).toMatchObject({
			mode: range,
			perTitleSettings: { minBitrate: 1_000_000, maxBitrate: 2_000_000 },
		});
	});

	it("keeps parked bitrate fields inactive on a resolution-only stream", () => {
		const goal = mixed();
		goal.rows = goal.rows?.map((row) =>
			row.id === "resolution"
				? {
						...row,
						minBitrate: 100_000,
						maxBitrate: 9_000_000,
						bitrateSelectionMode: "COMPLEXITY_RANGE" as const,
					}
				: row,
		);
		const proposal = recommendPerTitleSettings(goal);
		expect(proposal.applicable).toBe(true);
		expect(
			proposal.api.streams.find(({ rowId }) => rowId === "resolution")
				?.perTitleSettings,
		).toBeUndefined();
	});

	it("validates explicit fixed-bitrate bounds independently of the strategy", () => {
		const goal = mixed();
		goal.strategy = "fixed-resolutions";
		goal.rows = goal.rows?.map((row) =>
			row.id === "range" ? { ...row, maxBitrate: 8_000_000 } : row,
		);
		const proposal = recommendPerTitleSettings(goal);
		expect(proposal.applicable).toBe(false);
		expect(
			proposal.diagnostics.some(
				({ code }) => code === "row-outside-global-range",
			),
		).toBe(true);
	});
});
