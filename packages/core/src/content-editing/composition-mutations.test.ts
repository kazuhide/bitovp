import { describe, expect, it } from "vitest";
import {
	compileComposition,
	evaluateCompositionFrame,
} from "./composition-frame";
import {
	moveCompositionClip,
	removeCompositionClip,
	splitCompositionClip,
	trimCompositionClip,
} from "./composition-mutations";
import {
	compositionFixture,
	compositionIds as ids,
} from "./composition-test-fixtures";

const setup = () => {
	const f = compositionFixture();
	const clip = f.document.clips[0];
	if (!clip) throw new Error("Missing clip");
	clip.framing = [
		{
			fromFrame: 0,
			toFrame: 90,
			mode: "CROP",
			origin: "MANUAL",
			rect: { x: 0.2, y: 0, w: 0.31640625, h: 1 },
		},
	];
	clip.cropKeyframes = [
		{ frame: 0, rect: { x: 0.2, y: 0, w: 0.31640625, h: 1 }, easing: "LINEAR" },
		{
			frame: 89,
			rect: { x: 0.6, y: 0, w: 0.31640625, h: 1 },
			easing: "LINEAR",
		},
	];
	f.document.captions = [
		{
			id: ids.item,
			anchorClipId: ids.clip,
			fromFrame: 10,
			toFrame: 40,
			text: "cat",
			words: [
				{ text: "cat", startChar: 0, endChar: 3, fromFrame: 15, toFrame: 30 },
			],
		},
	];
	return f;
};
describe("non-ripple composition editing", () => {
	it("trims in source frames, retains sampled motion and remaps anchored caption times", () => {
		const { document, source } = setup();
		const before = compileComposition(document, [source]);
		const result = trimCompositionClip(
			document,
			ids.clip,
			{ sourceInUs: 1_366_667, durationFrames: 70 },
			[source],
		);
		const after = compileComposition(result, [source]);
		expect(evaluateCompositionFrame(after, 0).layers[0]?.sourceFrame).toBe(101);
		expect(
			evaluateCompositionFrame(after, 0).layers[0]?.cropRect?.x,
		).toBeCloseTo(
			evaluateCompositionFrame(before, 10).layers[0]?.cropRect?.x ?? 0,
		);
		expect(result.captions?.[0]).toMatchObject({
			fromFrame: 0,
			toFrame: 30,
			words: [{ fromFrame: 5, toFrame: 20 }],
		});
		expect(document.clips[0]?.durationFrames).toBe(90);
	});
	it("uses FIT for newly exposed source instead of inventing observed crop keys", () => {
		const { document, source } = setup();
		const result = trimCompositionClip(
			document,
			ids.clip,
			{ sourceInUs: 1_000_000, durationFrames: 92 },
			[source],
		);
		expect(result.clips[0]?.framing[0]).toMatchObject({
			fromFrame: 0,
			toFrame: 1,
			mode: "FIT",
			origin: "MANUAL",
		});
		expect(result.clips[0]?.framing.at(-1)).toMatchObject({
			fromFrame: 91,
			toFrame: 92,
			mode: "FIT",
		});
	});
	it("splits without changing any rendered crop/source frame and preserves spanning global evidence", () => {
		const { document, source } = setup();
		const before = compileComposition(document, [source]);
		const split = splitCompositionClip(document, ids.clip, 25, ids.other, [
			source,
		]);
		const after = compileComposition(split, [source]);
		for (const frame of [0, 24, 25, 26, 89])
			expect(
				evaluateCompositionFrame(after, frame).layers[0]?.cropRect?.x,
			).toBeCloseTo(
				evaluateCompositionFrame(before, frame).layers[0]?.cropRect?.x ?? 0,
			);
		expect(split.captions?.[0]?.anchorClipId).toBeUndefined();
		expect(split.captions?.[0]?.words).toEqual(document.captions?.[0]?.words);
		expect(split.clips[1]?.sourceInUs).toBe(1_866_667);
	});
	it("retains smooth easing and audio envelopes exactly across a split", () => {
		const { document, source } = setup();
		const clip = document.clips[0];
		if (!clip) throw new Error("Missing clip");
		if (clip.cropKeyframes?.[0]) clip.cropKeyframes[0].easing = "SMOOTH";
		clip.audio = { mode: "SOURCE", fadeInFrames: 50, fadeOutFrames: 50 };
		const before = compileComposition(document, [source]);
		const split = splitCompositionClip(document, ids.clip, 37, ids.other, [
			source,
		]);
		const after = compileComposition(split, [source]);
		for (const frame of [1, 20, 36, 37, 38, 60, 88]) {
			expect(
				evaluateCompositionFrame(after, frame).layers[0]?.cropRect?.x,
			).toBeCloseTo(
				evaluateCompositionFrame(before, frame).layers[0]?.cropRect?.x ?? 0,
				12,
			);
			expect(evaluateCompositionFrame(after, frame).audio[0]?.gain).toBeCloseTo(
				evaluateCompositionFrame(before, frame).audio[0]?.gain ?? 0,
				12,
			);
		}
	});
	it("moves anchored items only, preserving independently timed content and sources", () => {
		const { document } = setup();
		document.captions?.push({
			id: ids.other,
			fromFrame: 50,
			toFrame: 60,
			text: "global",
		});
		const moved = moveCompositionClip(document, ids.clip, {
			timelineStartFrame: 20,
		});
		expect(moved.captions?.map((c) => [c.fromFrame, c.toFrame])).toEqual([
			[30, 60],
			[50, 60],
		]);
		expect(moved.clips[0]?.cropKeyframes).toEqual(
			document.clips[0]?.cropKeyframes,
		);
	});
	it("removes dependent anchored items without removing other tracks or source declarations", () => {
		const { document } = setup();
		const first = document.clips[0];
		if (!first) throw new Error("Missing clip");
		document.clips.push({
			...structuredClone(first),
			id: ids.other,
			timelineStartFrame: 90,
		});
		const result = removeCompositionClip(document, ids.clip);
		expect(result.clips.map((c) => c.id)).toEqual([ids.other]);
		expect(result.clips[0]?.timelineStartFrame).toBe(90);
		expect(result.captions).toEqual([]);
		expect(() => removeCompositionClip(result, ids.other)).toThrow();
	});
	it("rejects ambiguous new overlaps and out of bounds source edits", () => {
		const { document, source } = setup();
		const first = document.clips[0];
		if (!first) throw new Error("Missing clip");
		document.clips.push({
			...structuredClone(first),
			id: ids.other,
			timelineStartFrame: 90,
		});
		expect(() =>
			moveCompositionClip(document, ids.other, { timelineStartFrame: 80 }),
		).toThrow();
		expect(() =>
			trimCompositionClip(
				document,
				ids.clip,
				{ sourceInUs: 10_000_000, durationFrames: 90 },
				[source],
			),
		).toThrow("SOURCE_OUT_OF_BOUNDS");
	});
});
