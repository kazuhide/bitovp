import { describe, expect, it } from "vitest";
import { normalizeSceneAnalysis } from "../content-library/analysis";
import { authoredNormalizationReceipt } from "../testing/normalization-clock";
import { createPortraitSelectionSearchBudget } from "./auto-portrait";
import {
	buildPreparedShotPartition,
	selectPreparedPortraitClips,
} from "./prepared-shot-partition";

const id = (n: number) =>
	`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function material(sourceFrameCount = 48) {
	const normalization = authoredNormalizationReceipt({
		organizationId: id(1),
		sourceId: id(2),
		mediaVersionId: id(3),
		sourceFrameCount,
	});
	const timeMap = {
		id: id(3),
		mediaVersionId: id(3),
		kind: "CFR",
		sourceStartUs: 0,
		sourceEndUs: normalization.sourceEndUs,
		editingStartFrame: 0,
		editingEndFrame: normalization.output.frameCount,
		fps: { num: 30, den: 1 },
	};
	return { normalization, timeMap };
}
function gapFixture(duplicateRawBounds = false) {
	const facts = material(),
		cutA = 1 / 24,
		cutB = 0.041667;
	const analysis = normalizeSceneAnalysis({
		metadata: { version: "authored-distinct-raw-gap-regression" },
		duration: 2,
		scenes: [
			{
				id: id(4),
				type: "MAIN_CONTENT",
				title: "keep main",
				startInSeconds: 0,
				endInSeconds: 2,
				shots: [
					{
						startInSeconds: 0,
						endInSeconds: cutA,
						detailedDescription: "keep",
					},
					...(duplicateRawBounds
						? [
								{
									startInSeconds: 0,
									endInSeconds: cutB,
									detailedDescription: "keep",
								},
							]
						: []),
					{
						startInSeconds: cutB,
						endInSeconds: 2,
						detailedDescription: "keep",
					},
				],
			},
			{
				id: id(5),
				type: "MAIN_CONTENT",
				title: "auxiliary",
				startInSeconds: 0,
				endInSeconds: 2,
				shots: [
					{
						startInSeconds: 0,
						endInSeconds: cutB,
						detailedDescription: "drop",
					},
					{
						startInSeconds: cutA,
						endInSeconds: 1,
						detailedDescription: "drop",
					},
				],
			},
		],
	});
	return buildPreparedShotPartition({ ...facts, analysis });
}
function budgetFixture() {
	const facts = material(8000);
	const analysis = normalizeSceneAnalysis({
		metadata: { version: "authored-default-v3-budget-regression" },
		duration: facts.normalization.sourceEndUs / 1e6,
		scenes: Array.from({ length: 80 }, (_, scene) => ({
			id: id(scene + 10),
			type: "MAIN_CONTENT",
			title: "budget",
			startInSeconds: (scene * 125) / 30,
			endInSeconds: ((scene + 1) * 125) / 30,
			shots: Array.from({ length: 125 }, (_, shot) => ({
				startInSeconds: (scene * 125 + shot) / 30,
				endInSeconds: (scene * 125 + shot + 1) / 30,
			})),
		})),
	});
	return buildPreparedShotPartition({ ...facts, analysis });
}

describe("V3 owns one bounded budget across every delegated search", () => {
	it("rejects at 200000 expansions even when the caller omits the optional budget", () => {
		const partition = budgetFixture();
		let checks = 0;
		expect(() =>
			selectPreparedPortraitClips({
				partition,
				targetDurationFrames: 5400,
				policy: "COHESION",
				acceptWindow: () => {
					checks++;
					return true;
				},
			}),
		).toThrow("200000");
		expect(checks).toBe(200000);
	});
	it("continues using a supplied budget instead of resetting it for another policy", () => {
		const partition = budgetFixture(),
			searchBudget = createPortraitSelectionSearchBudget();
		selectPreparedPortraitClips({
			partition,
			targetDurationFrames: 5400,
			policy: "DURATION",
			searchBudget,
		});
		expect(searchBudget.usedExpansions).toBe(199810);
		expect(() =>
			selectPreparedPortraitClips({
				partition,
				targetDurationFrames: 5400,
				policy: "COHESION",
				searchBudget,
			}),
		).toThrow("200000");
		expect(searchBudget.usedExpansions).toBe(200000);
	});
});
describe("V3 keeps original raw adjacency after prepared-frame quantization", () => {
	it("does not bridge a positive raw gap using auxiliary shared cuts removed by query", () => {
		const partition = gapFixture();
		// Preserve measured prepared ownership; raw-continuity checking must not move these frames.
		expect(
			partition.entries
				.filter((e) => e.sceneId === id(4))
				.map((e) => [e.fromFrame, e.toFrame]),
		).toEqual([
			[0, 2],
			[2, 60],
		]);
		const selection = selectPreparedPortraitClips({
			partition,
			targetDurationFrames: 60,
			policy: "COHESION",
			query: "keep",
		});
		expect(selection.actualDurationFrames).toBe(58);
		expect(selection.clips).toEqual([
			{ sourceInUs: 66667, durationFrames: 58, sceneId: id(4), shotIndex: 1 },
		]);
	});
	it("retains distinct raw-end frontier states so a genuinely contiguous alternative still wins", () => {
		const selection = selectPreparedPortraitClips({
			partition: gapFixture(),
			targetDurationFrames: 60,
			policy: "DURATION",
		});
		expect(selection.actualDurationFrames).toBe(60);
		expect(
			selection.clips.map((c) => [c.sceneId, c.shotIndex, c.durationFrames]),
		).toEqual([
			[id(5), 0, 2],
			[id(4), 1, 58],
		]);
	});
	it.each([
		"DURATION",
		"COHESION",
	] as const)("retains frame-identical alternatives with different raw bounds in %s", (policy) => {
		const selection = selectPreparedPortraitClips({
			partition: gapFixture(true),
			targetDurationFrames: 60,
			policy,
			...(policy === "COHESION" ? { query: "keep" } : {}),
		});
		expect(selection.actualDurationFrames).toBe(60);
		expect(selection.clips.map((c) => [c.sceneId, c.shotIndex])).toEqual([
			[id(4), 1],
			[id(4), 2],
		]);
	});
});
