import { describe, expect, it } from "vitest";
import {
	applyTrackedCompositionFraming,
	captionsFromSourceSegments,
} from "./composition-evidence";
import {
	compileComposition,
	evaluateCompositionFrame,
} from "./composition-frame";
import {
	compositionFixture,
	compositionIds,
} from "./composition-test-fixtures";

describe("real source evidence mapped into composition", () => {
	it("recovers canonical CEIL-microsecond tracking frame stamps without a one-frame delay", () => {
		const { document, source } = compositionFixture();
		const clip = document.clips[0];
		if (!clip) throw new Error("Missing clip");
		document.analysisRevisionId = compositionIds.other;
		clip.evidence = { sceneId: compositionIds.item, shotIndex: 0 };
		const observations = [1_033_334, 1_366_667].map((sourceTimeUs) => ({
			sceneId: compositionIds.item,
			shotIndex: 0,
			sourceTimeUs,
			box: { x: 0.3, y: 0.3, w: 0.1, h: 0.2 },
			confidence: 1,
		}));
		const result = applyTrackedCompositionFraming({
			document,
			sources: [source],
			mediaVersionId: source.mediaVersionId,
			observations,
			fallbacks: [
				{
					sceneId: compositionIds.item,
					shotIndex: 0,
					fromUs: 1_000_000,
					toUs: 1_033_334,
					reason: "BEFORE_SEED",
				},
			],
		});
		expect(result.clips[0]?.cropKeyframes?.map((key) => key.frame)).toEqual([
			0, 10,
		]);
		expect(
			evaluateCompositionFrame(compileComposition(result, [source]), 0)
				.layers[0]?.mode,
		).toBe("CROP");
	});
	it("maps absolute original times using both map offsets and retains actual word gaps", () => {
		const { document, source } = compositionFixture();
		const result = captionsFromSourceSegments({
			document,
			sources: [source],
			mediaVersionId: source.mediaVersionId,
			idFor: () => compositionIds.item,
			segments: [
				{
					startUs: 1_000_000,
					endUs: 2_000_000,
					text: "猫 と犬",
					words: [
						{
							text: "猫",
							startChar: 0,
							endChar: 1,
							startUs: 1_100_000,
							endUs: 1_200_000,
							confidence: 0.9,
						},
						{
							text: "犬",
							startChar: 3,
							endChar: 4,
							startUs: 1_500_000,
							endUs: 1_600_000,
							confidence: 0.8,
						},
					],
				},
			],
		});
		expect(result.captions?.[0]).toMatchObject({
			fromFrame: 2,
			toFrame: 17,
			anchorClipId: compositionIds.clip,
			words: [
				{ fromFrame: 2, toFrame: 5 },
				{ fromFrame: 14, toFrame: 17 },
			],
		});
		const plan = compileComposition(result, [source]);
		expect(evaluateCompositionFrame(plan, 6).captions[0]?.activeWords).toEqual(
			[],
		);
		expect(
			evaluateCompositionFrame(plan, 14).captions[0]?.activeWords.map(
				(word) => word.text,
			),
		).toEqual(["犬"]);
	});
	it("duplicates actual segment-only captions for reused clips without inventing words", () => {
		const { document, source } = compositionFixture();
		const first = document.clips[0];
		if (!first) throw new Error("Missing clip");
		document.clips.push({
			...structuredClone(first),
			id: compositionIds.other,
			timelineStartFrame: 90,
		});
		const result = captionsFromSourceSegments({
			document,
			sources: [source],
			mediaVersionId: source.mediaVersionId,
			idFor: (id) =>
				id === compositionIds.clip
					? compositionIds.item
					: compositionIds.otherMap,
			segments: [
				{ startUs: 1_500_000, endUs: 2_000_000, text: "実測した日本語" },
			],
		});
		expect(
			result.captions?.map((caption) => [
				caption.fromFrame,
				caption.toFrame,
				caption.words,
			]),
		).toEqual([
			[14, 29, undefined],
			[104, 119, undefined],
		]);
	});
	it("rejects fabricated word offsets or invalid source timing instead of subdividing text", () => {
		const { document, source } = compositionFixture();
		expect(() =>
			captionsFromSourceSegments({
				document,
				sources: [source],
				mediaVersionId: source.mediaVersionId,
				idFor: () => compositionIds.item,
				segments: [{ startUs: 2, endUs: 1, text: "bad" }],
			}),
		).toThrow();
		expect(() =>
			captionsFromSourceSegments({
				document,
				sources: [source],
				mediaVersionId: source.mediaVersionId,
				idFor: () => compositionIds.item,
				segments: [
					{
						startUs: 1_000_000,
						endUs: 2_000_000,
						text: "cat",
						words: [
							{
								text: "dog",
								startChar: 0,
								endChar: 3,
								startUs: 1_100_000,
								endUs: 1_200_000,
								confidence: 1,
							},
						],
					},
				],
			}),
		).toThrow();
	});
	it("uses two measured tracking positions only inside their supported span, with FIT after loss", () => {
		const { document, source } = compositionFixture();
		const clip = document.clips[0];
		if (!clip) throw new Error("Missing clip");
		document.analysisRevisionId = compositionIds.other;
		clip.evidence = { sceneId: compositionIds.item, shotIndex: 2 };
		const result = applyTrackedCompositionFraming({
			document,
			sources: [source],
			mediaVersionId: source.mediaVersionId,
			observations: [
				{
					sceneId: compositionIds.item,
					shotIndex: 2,
					sourceTimeUs: 1_100_000,
					box: { x: 0.2, y: 0.3, w: 0.1, h: 0.2 },
					confidence: 1,
				},
				{
					sceneId: compositionIds.item,
					shotIndex: 2,
					sourceTimeUs: 1_433_334,
					box: { x: 0.6, y: 0.3, w: 0.1, h: 0.2 },
					confidence: 0.9,
				},
			],
			fallbacks: [
				{
					sceneId: compositionIds.item,
					shotIndex: 2,
					fromUs: 1_433_334,
					toUs: 4_000_000,
					reason: "LOST",
				},
			],
		});
		const plan = compileComposition(result, [source]);
		expect(evaluateCompositionFrame(plan, 0).layers[0]?.mode).toBe("FIT");
		expect(evaluateCompositionFrame(plan, 3).layers[0]?.mode).toBe("CROP");
		expect(evaluateCompositionFrame(plan, 13).layers[0]?.mode).toBe("FIT");
		expect(result.clips[0]?.cropKeyframes?.map((key) => key.frame)).toEqual([
			2, 12,
		]);
	});
	it("refuses to turn one seed or an oversized subject into a continuous crop", () => {
		const { document, source } = compositionFixture();
		const clip = document.clips[0];
		if (!clip) throw new Error("Missing clip");
		document.analysisRevisionId = compositionIds.other;
		clip.evidence = { sceneId: compositionIds.item, shotIndex: 0 };
		const observation = {
			sceneId: compositionIds.item,
			shotIndex: 0,
			sourceTimeUs: 1_100_000,
			box: { x: 0, y: 0, w: 1, h: 1 },
			confidence: 1,
		};
		const result = applyTrackedCompositionFraming({
			document,
			sources: [source],
			mediaVersionId: source.mediaVersionId,
			observations: [observation],
			fallbacks: [],
		});
		expect(result.clips[0]?.framing.every((part) => part.mode === "FIT")).toBe(
			true,
		);
		expect(result.clips[0]?.cropKeyframes).toBeUndefined();
		const two = applyTrackedCompositionFraming({
			document,
			sources: [source],
			mediaVersionId: source.mediaVersionId,
			observations: [observation, { ...observation, sourceTimeUs: 1_433_334 }],
			fallbacks: [],
		});
		expect(two.clips[0]?.framing.every((part) => part.mode === "FIT")).toBe(
			true,
		);
	});
	it("bounds long tracking to a deterministic subset of actual observed frames", () => {
		const { document, source } = compositionFixture();
		const clip = document.clips[0];
		if (!clip) throw new Error("Missing clip");
		document.analysisRevisionId = compositionIds.other;
		clip.evidence = { sceneId: compositionIds.item, shotIndex: 0 };
		clip.durationFrames = 300;
		clip.sourceInUs = 1_000_000;
		clip.framing = [
			{ fromFrame: 0, toFrame: 300, mode: "FIT", origin: "MANUAL" },
		];
		const observations = Array.from({ length: 300 }, (_, frame) => ({
			sceneId: compositionIds.item,
			shotIndex: 0,
			sourceTimeUs: 1_000_000 + Math.ceil((frame * 1_000_000) / 30),
			box: { x: 0.3, y: 0.3, w: 0.1, h: 0.2 },
			confidence: 1,
		}));
		const result = applyTrackedCompositionFraming({
			document,
			sources: [source],
			mediaVersionId: source.mediaVersionId,
			observations,
			fallbacks: [],
		});
		const keys = result.clips[0]?.cropKeyframes ?? [];
		expect(keys).toHaveLength(128);
		expect(keys[0]?.frame).toBe(0);
		expect(keys.at(-1)?.frame).toBe(299);
		expect(
			keys.every((key) =>
				observations.some(
					(observation) =>
						observation.sourceTimeUs ===
						1_000_000 + Math.ceil((key.frame * 1_000_000) / 30),
				),
			),
		).toBe(true);
		document.clips.push(
			{
				...structuredClone(clip),
				id: compositionIds.other,
				timelineStartFrame: 300,
			},
			{
				...structuredClone(clip),
				id: compositionIds.otherMap,
				timelineStartFrame: 600,
			},
		);
		const multi = applyTrackedCompositionFraming({
			document,
			sources: [source],
			mediaVersionId: source.mediaVersionId,
			observations,
			fallbacks: [],
		});
		expect(
			multi.clips.reduce(
				(count, item) => count + (item.cropKeyframes?.length ?? 0),
				0,
			),
		).toBeLessThanOrEqual(128);
		expect(
			multi.clips.every(
				(item) =>
					(item.cropKeyframes?.length ?? 0) >= 2 &&
					item.cropKeyframes?.[0]?.frame === 0 &&
					item.cropKeyframes.at(-1)?.frame === 299,
			),
		).toBe(true);
	});
});
