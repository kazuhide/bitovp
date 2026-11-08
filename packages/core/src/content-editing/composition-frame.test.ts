import { expect, it } from "vitest";
import {
	compileComposition,
	evaluateCompositionFrame,
	evaluateCompositionVideoLayers,
} from "./composition-frame";
import {
	compositionFixture,
	compositionIds as ids,
} from "./composition-test-fixtures";

it("shares exact video geometry with full preview samples without changing captions or the document", () => {
	const { document, source } = compositionFixture();
	document.captions = [
		{
			id: ids.item,
			fromFrame: 0,
			toFrame: 90,
			text: "Caption layout is independent of video geometry",
		},
	];
	document.presentation = {
		version: "portrait-layout-v1",
		videoFit: "AUTO",
		captionPlacement: "BANDS",
	};
	const before = structuredClone(document);
	const plan = compileComposition(document, [source]);
	for (const canvas of [document.canvas, { width: 360, height: 640 }]) {
		for (const frame of [0, 1, 29, 45, 89]) {
			expect(evaluateCompositionVideoLayers(plan, frame, canvas)).toEqual(
				evaluateCompositionFrame(plan, frame, canvas).layers,
			);
		}
	}
	expect(() => evaluateCompositionVideoLayers(plan, 90)).toThrow(
		"INVALID_FRAME",
	);
	expect(() =>
		evaluateCompositionVideoLayers(plan, 0, { width: 640, height: 360 }),
	).toThrow("Output canvas must retain");
	expect(document).toEqual(before);
});

it("fits the displayed caption language only and preserves original timing, words and evidence", () => {
	const f = compositionFixture();
	const text = "Hello",
		translationText =
			"トム、シリア、我々は情熱に従わなきゃ。お前はロボティクス、私は宇宙で最高になりたいんだ";
	f.document.captionLayout = { x: 0.05, y: 0.8, w: 0.9, h: 0.17 };
	f.document.captionStyle = { fontSize: 0.045 };
	f.document.captions = [
		{
			id: ids.item,
			fromFrame: 0,
			toFrame: 30,
			text,
			words: [{ text, startChar: 0, endChar: 5, fromFrame: 0, toFrame: 15 }],
			translation: {
				targetLanguage: "ja",
				text: translationText,
				sourceText: text,
				sourceTextHash: "a".repeat(64),
				origin: "LOCAL_LLM",
				evidenceHash: "b".repeat(64),
			},
		},
	];
	const original = structuredClone(f.document);
	f.document.captionDisplayLanguage = "ja";
	const japanese = evaluateCompositionFrame(
		compileComposition(f.document, [f.source]),
		5,
	).captions[0];
	expect(japanese?.style.fontSize).toBeLessThan(0.045);
	expect(japanese?.text).toBe(translationText);
	expect(japanese?.activeWords).toEqual([]);
	f.document.captionDisplayLanguage = "ORIGINAL";
	const english = evaluateCompositionFrame(
		compileComposition(f.document, [f.source]),
		5,
	).captions[0];
	expect(english?.style.fontSize).toBe(0.045);
	expect(english?.activeWords).toEqual(original.captions?.[0]?.words);
	expect(f.document.captions).toEqual(original.captions);
	expect(f.document.captionStyle).toEqual(original.captionStyle);
});

it("previews a Japanese text layer without remapping measured original word emphasis", () => {
	const f = compositionFixture();
	f.document.captionDisplayLanguage = "ja";
	f.document.captions = [
		{
			id: ids.item,
			fromFrame: 0,
			toFrame: 30,
			text: "Hello",
			words: [
				{ text: "Hello", startChar: 0, endChar: 5, fromFrame: 0, toFrame: 15 },
			],
			translation: {
				targetLanguage: "ja",
				text: "こんにちは",
				sourceText: "Hello",
				sourceTextHash: "a".repeat(64),
				origin: "LOCAL_LLM",
				evidenceHash: "b".repeat(64),
			},
		},
	];
	const frame = evaluateCompositionFrame(
		compileComposition(f.document, [f.source]),
		5,
	);
	expect(frame.captions[0]?.text).toBe("こんにちは");
	expect(frame.captions[0]?.activeWords).toEqual([]);
	expect(f.document.captions[0]?.text).toBe("Hello");
});

it("resolves original source and editing frame offsets into the same preview/render frame", () => {
	const f = compositionFixture();
	const plan = compileComposition(f.document, [f.source]);
	expect(plan.compilerVersion).toBe("content-composition-v2");
	expect(plan.durationFrames).toBe(90);
	const frame = evaluateCompositionFrame(plan, 2);
	expect(frame).toMatchObject({
		frame: 2,
		timeUs: 66_666,
		canvas: { width: 1080, height: 1920 },
	});
	expect(frame.layers[0]).toMatchObject({
		clipId: ids.clip,
		sourceFrame: 93,
		sourceTimeUs: 1_100_000,
		sourceSeconds: 3.1,
		sourceRect: { x: 0, y: 0, w: 1920, h: 1080 },
		drawRect: { x: 0, y: 656, w: 1080, h: 608 },
		opacity: 1,
	});
	expect(frame.audio[0]).toMatchObject({ sourceSample: 93 * 1600, gain: 1 });
	for (const invalid of [-1, 90, 1.5, NaN])
		expect(() => evaluateCompositionFrame(plan, invalid)).toThrow();
});
it("layers an additional material using its own pinned map and output layout", () => {
	const f = compositionFixture();
	f.document.sources = [{ mediaVersionId: ids.other, timeMapId: ids.otherMap }];
	f.document.videoTracks?.push({ id: "broll", name: "B-roll", order: 1 });
	const first = f.document.clips[0];
	if (!first) throw new Error("fixture");
	f.document.clips.push({
		...structuredClone(first),
		id: ids.item,
		mediaVersionId: ids.other,
		trackId: "broll",
		sourceInUs: 0,
		timelineStartFrame: 15,
		durationFrames: 30,
		framing: [{ fromFrame: 0, toFrame: 30, mode: "FIT", origin: "MANUAL" }],
		audio: { mode: "MUTE" },
		layout: { x: 0.6, y: 0.1, w: 0.3, h: 0.3 },
		opacity: 0.75,
	});
	const other = {
		...f.source,
		mediaVersionId: ids.other,
		timeMap: {
			...f.source.timeMap,
			id: ids.otherMap,
			mediaVersionId: ids.other,
			sourceStartUs: 0,
			sourceEndUs: 10_000_000,
			editingStartFrame: 0,
			editingEndFrame: 300,
		},
	};
	const plan = compileComposition(f.document, [other, f.source]);
	const frame = evaluateCompositionFrame(plan, 20);
	expect(frame.layers.map((l) => l.sourceFrame)).toEqual([111, 5]);
	expect(frame.layers[1]).toMatchObject({
		trackId: "broll",
		trackOrder: 1,
		opacity: 0.75,
		layoutRect: { x: 648, y: 192, w: 324, h: 576 },
	});
	expect(frame.audio).toHaveLength(1);
});
it("shares exact crossfade weights with source audio and one-frame cuts", () => {
	const f = compositionFixture();
	const first = f.document.clips[0];
	if (!first) throw new Error("fixture");
	f.document.clips.push({
		...structuredClone(first),
		id: ids.other,
		sourceInUs: 4_000_000,
		timelineStartFrame: 85,
		durationFrames: 30,
		framing: [{ fromFrame: 0, toFrame: 30, mode: "FIT", origin: "MANUAL" }],
		transitionIn: { type: "CROSSFADE", durationFrames: 5 },
	});
	const plan = compileComposition(f.document, [f.source]);
	const middle = evaluateCompositionFrame(plan, 87);
	expect(middle.layers.map((l) => l.opacity)).toEqual([0.5, 0.5]);
	expect(middle.audio.map((a) => a.gain)).toEqual([0.5, 0.5]);
	expect(
		evaluateCompositionFrame(plan, 90).layers.map((l) => l.clipId),
	).toEqual([ids.other]);
});
it("crossfades full overlapping clips even when the incoming ID sorts before the outgoing ID", () => {
	const f = compositionFixture();
	const first = f.document.clips[0];
	if (!first) throw new Error("fixture");
	first.durationFrames = 3;
	first.framing = [{ fromFrame: 0, toFrame: 3, mode: "FIT", origin: "MANUAL" }];
	f.document.clips.push({
		...structuredClone(first),
		id: ids.media,
		sourceInUs: 4_000_000,
		transitionIn: { type: "CROSSFADE", durationFrames: 3 },
	});
	const frame = evaluateCompositionFrame(
		compileComposition(f.document, [f.source]),
		1,
	);
	expect(frame.layers.map((l) => l.opacity)).toEqual([0.5, 0.5]);
	expect(frame.audio.map((a) => a.gain)).toEqual([0.5, 0.5]);
});
it("interpolates crop keys only through a CROP span and computes preview-resolution padding", () => {
	const f = compositionFixture();
	const first = f.document.clips[0];
	if (!first) throw new Error("fixture");
	first.framing = [
		{ fromFrame: 0, toFrame: 10, mode: "FIT", origin: "MANUAL" },
		{
			fromFrame: 10,
			toFrame: 90,
			mode: "CROP",
			origin: "MANUAL",
			rect: { x: 0, y: 0, w: 0.3, h: 1 },
		},
	];
	first.cropKeyframes = [
		{ frame: 0, rect: { x: 0.1, y: 0, w: 0.3, h: 1 }, easing: "LINEAR" },
		{ frame: 20, rect: { x: 0.5, y: 0, w: 0.3, h: 1 }, easing: "SMOOTH" },
	];
	const plan = compileComposition(f.document, [f.source]);
	expect(evaluateCompositionFrame(plan, 0).layers[0]?.mode).toBe("FIT");
	expect(evaluateCompositionFrame(plan, 10).layers[0]?.sourceRect).toEqual({
		x: 576,
		y: 0,
		w: 576,
		h: 1080,
	});
	expect(
		evaluateCompositionFrame(plan, 0, { width: 360, height: 640 }).layers[0]
			?.drawRect,
	).toEqual({ x: 0, y: 218, w: 360, h: 202 });
});
it("uses actual caption word visibility, plain overlay order and no fabricated alignment", () => {
	const f = compositionFixture();
	f.document.captions = [
		{
			id: ids.other,
			fromFrame: 0,
			toFrame: 30,
			text: "猫と犬",
			words: [
				{ text: "猫", startChar: 0, endChar: 1, fromFrame: 0, toFrame: 10 },
				{ text: "犬", startChar: 2, endChar: 3, fromFrame: 20, toFrame: 30 },
			],
		},
	];
	f.document.imageAssets = [{ id: ids.item }];
	f.document.overlays = [
		{
			id: ids.item,
			kind: "IMAGE",
			assetId: ids.item,
			fromFrame: 0,
			toFrame: 30,
			rect: { x: 0, y: 0, w: 0.1, h: 0.1 },
			opacity: 1,
			zIndex: 2,
		},
		{
			id: ids.other,
			kind: "TEXT",
			text: "Literal {text} \\ %",
			fromFrame: 0,
			toFrame: 30,
			rect: { x: 0.1, y: 0.1, w: 0.5, h: 0.1 },
			opacity: 1,
			zIndex: 1,
		},
	];
	const plan = compileComposition(f.document, [f.source]);
	expect(
		evaluateCompositionFrame(plan, 9).captions[0]?.activeWords.map(
			(w) => w.text,
		),
	).toEqual(["猫"]);
	expect(evaluateCompositionFrame(plan, 10).captions[0]?.activeWords).toEqual(
		[],
	);
	expect(
		evaluateCompositionFrame(plan, 20).captions[0]?.activeWords.map(
			(w) => w.text,
		),
	).toEqual(["犬"]);
	expect(evaluateCompositionFrame(plan, 30).captions).toEqual([]);
	expect(evaluateCompositionFrame(plan, 0).overlays.map((o) => o.kind)).toEqual(
		["TEXT", "IMAGE"],
	);
});
it("mixes declared background gain/fades/ducking without changing source audio policy", () => {
	const f = compositionFixture();
	f.document.audioTracks = [
		{
			id: ids.item,
			mediaVersionId: ids.media,
			sourceInUs: 2_000_000,
			timelineStartFrame: 0,
			durationFrames: 90,
			gainDb: -6,
			fadeInFrames: 10,
			fadeOutFrames: 10,
			ducking: {
				gainDb: -12,
				attackFrames: 0,
				releaseFrames: 0,
				intervals: [{ fromFrame: 20, toFrame: 40 }],
			},
		},
	];
	const plan = compileComposition(f.document, [f.source]);
	expect(evaluateCompositionFrame(plan, 20).audio[1]?.gain).toBeCloseTo(
		10 ** (-18 / 20),
		12,
	);
	expect(evaluateCompositionFrame(plan, 20).audio[1]?.sourceSample).toBe(
		(120 + 20) * 1600,
	);
});
it("rejects source tuple/bounds and silent background tracks before media rendering", () => {
	const f = compositionFixture();
	expect(() =>
		compileComposition(f.document, [
			{ ...f.source, timeMap: { ...f.source.timeMap, id: ids.otherMap } },
		]),
	).toThrow();
	const first = f.document.clips[0];
	if (!first) throw new Error("fixture");
	first.sourceInUs = 10_000_000;
	expect(() => compileComposition(f.document, [f.source])).toThrow();
	first.sourceInUs = 1_033_334;
	f.document.audioTracks = [
		{
			id: ids.item,
			mediaVersionId: ids.media,
			sourceInUs: 2_000_000,
			timelineStartFrame: 0,
			durationFrames: 30,
			gainDb: 0,
			fadeInFrames: 0,
			fadeOutFrames: 0,
		},
	];
	expect(() =>
		compileComposition(f.document, [{ ...f.source, hasAudio: false }]),
	).toThrow();
});
it("permits unconfirmed AISA only for an explicit draft preview", () => {
	const f = compositionFixture();
	const first = f.document.clips[0];
	if (!first) throw new Error("fixture");
	const framing = first.framing[0];
	if (!framing) throw new Error("fixture");
	framing.origin = "AISA_PROPOSAL";
	expect(() => compileComposition(f.document, [f.source])).toThrow();
	expect(() =>
		compileComposition(f.document, [f.source], { allowUnconfirmed: true }),
	).not.toThrow();
});
