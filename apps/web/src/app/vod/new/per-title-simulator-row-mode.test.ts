import type { PerTitleGoal } from "@bitovp/core";
import { describe, expect, it } from "vitest";
import { changePerTitleStreamChoice } from "./per-title-simulator-row-mode";

const rangeGoal: PerTitleGoal = {
	strategy: "fixed-ranges",
	codec: "H264",
	minBitrate: 128_000,
	maxBitrate: 4_000_000,
	countPolicy: { kind: "unrestricted" },
	rows: [
		{
			id: "sample",
			mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
			height: 360,
			width: 640,
			minBitrate: 300_000,
			maxBitrate: 900_000,
			bitrateSelectionMode: "COMPLEXITY_RANGE",
			lowComplexityBoundaryForMaxBitrate: 1_500_000,
			highComplexityBoundaryForMaxBitrate: 4_000_000,
		},
	],
	adjustments: {
		streams: {
			sample: {
				height: { mode: "auto", method: "constraints" },
				minBitrate: { mode: "auto", method: "constraints" },
			},
		},
	},
	settingLocks: { streams: { sample: ["height", "minBitrate"] } },
};

describe("ordinary-template resolution hints", () => {
	it("retains dimensions and their policy when a fixed range becomes a template", () => {
		const before = structuredClone(rangeGoal);
		const next = changePerTitleStreamChoice(rangeGoal, "sample", "template");
		expect(next.rows).toEqual([]);
		expect(next.automaticTemplates).toEqual([
			{ id: "sample", height: 360, width: 640 },
		]);
		expect(next.adjustments?.streams?.sample).toEqual({
			height: { mode: "auto", method: "constraints" },
		});
		expect(next.settingLocks?.streams?.sample).toEqual(["height"]);
		expect(rangeGoal).toEqual(before);
	});

	it.each([
		{},
		{ height: 360 },
		{ width: 640 },
	])("preserves a template's optional dimensions without synthesizing a hint: %j", (dimensions) => {
		const goal: PerTitleGoal = {
			...rangeGoal,
			strategy: "automatic",
			rows: [],
			automaticTemplates: [{ id: "sample", ...dimensions }],
		};
		const before = structuredClone(goal);
		expect(
			changePerTitleStreamChoice(goal, "sample", "template").automaticTemplates,
		).toEqual(goal.automaticTemplates);
		expect(goal).toEqual(before);
	});

	it("still supplies an editable height when a dimensionless template becomes fixed", () => {
		const goal: PerTitleGoal = {
			...rangeGoal,
			strategy: "automatic",
			rows: [],
			automaticTemplates: [{ id: "sample" }],
		};
		const next = changePerTitleStreamChoice(goal, "sample", "fixed-resolution");
		expect(next.rows).toEqual([
			{
				id: "sample",
				height: 720,
				mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION",
			},
		]);
		expect(next.automaticTemplates).toEqual([]);
	});
});
