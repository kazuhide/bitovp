import { describe, expect, it } from "vitest";
import {
	type CompositionSourceSegment,
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
import {
	measuredSubtitleCues,
	unmeasuredSubtitleWindows,
} from "./subtitle-cues";
import { hashEditingEvidence } from "./verify-automatic-binding";

function measured(
	text: string,
	words: { text: string; startUs: number; endUs: number }[],
	endUs = 5_000_000,
): CompositionSourceSegment {
	let cursor = 0;
	return {
		startUs: 1_000_000,
		endUs,
		text,
		words: words.map((word) => {
			const startChar = text.indexOf(word.text, cursor);
			if (startChar < 0) throw new Error("Invalid test word");
			cursor = startChar + word.text.length;
			return { ...word, startChar, endChar: cursor, confidence: 0.85 };
		}),
	};
}
const idFor = (clipId: string, index: number) =>
	`aaaaaaaa-aaaa-4aaa-8aaa-${clipId === compositionIds.clip ? "1" : "2"}${index.toString().padStart(11, "0")}`;

describe("verified VAD support for measured display pauses", () => {
	it.each([
		{ origin: 0, editing: 0 },
		{ origin: 12_000_007, editing: 90 },
	])("preserves conservative VAD boundaries with independent source clocks (%j)", ({
		origin,
		editing,
	}) => {
		const { document, source } = boundaryFixture(origin, editing);
		const clip = document.clips[0];
		if (!clip) throw new Error("Missing clip");
		Object.assign(clip, {
			sourceInUs: origin + 1_000_000,
			timelineStartFrame: 0,
			durationFrames: 120,
			framing: [{ fromFrame: 0, toFrame: 120, mode: "FIT", origin: "MANUAL" }],
		});
		const segment = measured(
			"First second",
			[
				{
					text: "First",
					startUs: origin + 1_500_000,
					endUs: origin + 2_000_000,
				},
				{
					text: "second",
					startUs: origin + 2_600_000,
					endUs: origin + 3_000_000,
				},
			],
			origin + 4_000_000,
		);
		segment.startUs = origin + 1_000_000;
		const build = (intervals?: readonly { startUs: number; endUs: number }[]) =>
			captionsFromSourceSegments({
				document,
				sources: [source],
				mediaVersionId: source.mediaVersionId,
				idFor,
				requireAlignedText: true,
				segments: [segment],
				speechIntervals: intervals?.map(({ startUs, endUs }) => ({
					startUs: origin + startUs,
					endUs: origin + endUs,
				})),
			});
		const cases = [
			{ intervals: undefined, count: 2 },
			{ intervals: [], count: 2 },
			{ intervals: [{ startUs: 2_000_000, endUs: 2_600_000 }], count: 1 },
			{ intervals: [{ startUs: 1_999_999, endUs: 2_600_001 }], count: 1 },
			{ intervals: [{ startUs: 2_000_001, endUs: 3_000_000 }], count: 2 },
			{ intervals: [{ startUs: 1_500_000, endUs: 2_599_999 }], count: 2 },
			{
				intervals: [
					{ startUs: 1_500_000, endUs: 2_100_000 },
					{ startUs: 2_500_000, endUs: 3_000_000 },
				],
				count: 2,
			},
			{
				intervals: [
					{ startUs: 1_500_000, endUs: 2_300_000 },
					{ startUs: 2_300_000, endUs: 3_000_000 },
				],
				count: 2,
			},
		];
		for (const { intervals, count } of cases) {
			const result = build(intervals);
			expect(result.captions, JSON.stringify(intervals)).toHaveLength(count);
			expect(
				result.captions?.flatMap(
					(caption) =>
						caption.words?.map(({ text, fromFrame, toFrame }) => ({
							text,
							fromFrame,
							toFrame,
						})) ?? [],
				),
			).toEqual([
				{ text: "First", fromFrame: 15, toFrame: 30 },
				{ text: "second", fromFrame: 48, toFrame: 60 },
			]);
		}
	});

	it.each([
		{
			name: "word count",
			text: "a b c d e f g h i",
			tokens: "a b c d e f g h i".split(" "),
			frames: [0, 2, 4, 6, 8, 10, 12, 14, 40],
		},
		{
			name: "reading units",
			text: `${"あ".repeat(20)} い`,
			tokens: ["あ".repeat(20), "い"],
			frames: [0, 21],
		},
		{
			name: "duration",
			text: "One two",
			tokens: ["One", "two"],
			frames: [0, 121],
		},
		{
			name: "sentence punctuation",
			text: "One. Two",
			tokens: ["One", "Two"],
			frames: [0, 21],
		},
		{
			name: "unaligned lexical gap",
			text: "One missing Two",
			tokens: ["One", "Two"],
			frames: [0, 21],
		},
	])("retains the $name split despite continuous VAD", ({
		text,
		tokens,
		frames,
	}) => {
		let cursor = 0;
		const words = tokens.map((token, index) => {
			const startChar = text.indexOf(token, cursor);
			cursor = startChar + token.length;
			const fromFrame = frames[index] ?? 0;
			return {
				text: token,
				startChar,
				endChar: cursor,
				fromFrame,
				toFrame: fromFrame + 1,
			};
		});
		const result = measuredSubtitleCues({
			text,
			words,
			fromFrame: 0,
			toFrame: 150,
			requireAlignedText: true,
			speechIntervals: [{ fromFrame: 0, toFrame: 150 }],
		});
		expect(result).toHaveLength(2);
		expect(
			result.flatMap((cue) => cue.words?.map((word) => word.text) ?? []),
		).toEqual(tokens);
		expect(result.some((cue) => cue.text.includes("missing"))).toBe(false);
	});

	it.each([
		"SOURCE_GAP",
		"OUTPUT_GAP",
	] as const)("does not join measured cues across a %s even inside one VAD island", (kind) => {
		const { document, source } = longFixture();
		const clip = document.clips[0];
		if (!clip) throw new Error("Missing clip");
		Object.assign(clip, {
			durationFrames: 30,
			framing: [{ fromFrame: 0, toFrame: 30, mode: "FIT", origin: "MANUAL" }],
		});
		const secondStartUs = kind === "SOURCE_GAP" ? 3_000_000 : 2_000_000;
		document.clips.push({
			...structuredClone(clip),
			id: compositionIds.other,
			sourceInUs: secondStartUs,
			timelineStartFrame: kind === "OUTPUT_GAP" ? 31 : 30,
		});
		const result = captionsFromSourceSegments({
			document,
			sources: [source],
			mediaVersionId: source.mediaVersionId,
			idFor,
			requireAlignedText: true,
			segments: [
				measured("First second", [
					{ text: "First", startUs: 1_100_000, endUs: 1_400_000 },
					{
						text: "second",
						startUs: secondStartUs + 100_000,
						endUs: secondStartUs + 400_000,
					},
				]),
			],
			speechIntervals: [{ startUs: 1_000_000, endUs: 5_000_000 }],
		});
		expect(result.captions?.map((caption) => caption.text)).toEqual([
			"First",
			" second",
		]);
		expect(result.captions?.map((caption) => caption.anchorClipId)).toEqual([
			compositionIds.clip,
			compositionIds.other,
		]);
	});
});

function longFixture() {
	const fixture = compositionFixture();
	const clip = fixture.document.clips[0];
	if (!clip) throw new Error("Missing clip");
	clip.sourceInUs = 1_000_000;
	clip.durationFrames = 900;
	clip.framing = [
		{ fromFrame: 0, toFrame: 900, mode: "FIT", origin: "MANUAL" },
	];
	fixture.source.timeMap.sourceEndUs = 31_000_000;
	fixture.source.timeMap.editingEndFrame = 990;
	return fixture;
}

function boundaryFixture(sourceStartUs = 0, editingStartFrame = 0) {
	const fixture = compositionFixture();
	const clip = fixture.document.clips[0];
	if (!clip) throw new Error("Missing clip");
	Object.assign(fixture.source.timeMap, {
		sourceStartUs,
		sourceEndUs: sourceStartUs + 734_000_000,
		editingStartFrame,
		editingEndFrame: editingStartFrame + 22020,
	});
	Object.assign(clip, {
		sourceInUs: sourceStartUs + 300_666_667,
		timelineStartFrame: 329,
		durationFrames: 7,
		framing: [{ fromFrame: 0, toFrame: 7, mode: "FIT", origin: "MANUAL" }],
	});
	return fixture;
}

describe("measured subtitles for selected source ranges", () => {
	it("keeps the observed 人玉と共に現れ display continuous inside one verified VAD island", () => {
		const { document, source } = boundaryFixture();
		const clip = document.clips[0];
		if (!clip) throw new Error("Missing clip");
		Object.assign(clip, {
			sourceInUs: 618_533_334,
			timelineStartFrame: 448,
			durationFrames: 91,
			framing: [{ fromFrame: 0, toFrame: 91, mode: "FIT", origin: "MANUAL" }],
		});
		// Original measured times from the R1 native-generation receipt; VAD
		// supports continuous display without filling the measured word gap.
		const segment = measured(
			"人玉と共に現れ",
			[
				{ text: "人玉と", startUs: 619_000_000, endUs: 619_400_000 },
				{ text: "共", startUs: 619_400_000, endUs: 619_480_000 },
				{ text: "に現れ", startUs: 620_110_000, endUs: 620_760_000 },
			],
			620_760_000,
		);
		segment.startUs = 619_000_000;
		const input = {
			document,
			sources: [source],
			mediaVersionId: source.mediaVersionId,
			idFor,
			requireAlignedText: true,
			segments: [segment],
			speechIntervals: [{ startUs: 618_980_000, endUs: 620_990_000 }],
		};
		const before = structuredClone({ ...input, idFor: undefined });
		const result = captionsFromSourceSegments(input);
		expect(result.captions).toHaveLength(1);
		expect(result.captions?.[0]).toMatchObject({
			text: segment.text,
			fromFrame: 462,
			toFrame: 515,
			words: [
				{ text: "人玉と", fromFrame: 462, toFrame: 474 },
				{ text: "共", fromFrame: 474, toFrame: 477 },
				{ text: "に現れ", fromFrame: 496, toFrame: 515 },
			],
		});
		const plan = compileComposition(result, [source]);
		for (let frame = 477; frame < 496; frame++) {
			const captions = evaluateCompositionFrame(plan, frame).captions;
			expect(captions.map((caption) => caption.text)).toEqual([segment.text]);
			expect(captions[0]?.activeWords).toEqual([]);
		}
		expect({ ...input, idFor: undefined }).toEqual(before);
	});

	it.each([
		["−5℃", "5"],
		["$5", "5"],
		["+5%", "5"],
		["「5℃」", "5"],
	])("retains the original nonlexical signs and units of aligned %s", (text, word) => {
		const { document, source } = longFixture();
		const segment = measured(text, [
			{ text: word, startUs: 2_000_000, endUs: 3_000_000 },
		]);
		const result = captionsFromSourceSegments({
			document,
			sources: [source],
			mediaVersionId: source.mediaVersionId,
			idFor,
			requireAlignedText: true,
			segments: [segment],
		});
		expect(result.captions?.map((caption) => caption.text)).toEqual([text]);
		expect(result.captions?.[0]?.words?.[0]?.text).toBe(word);
	});

	it("keeps a negative sign with its following number when a pause divides reading cues", () => {
		const { document, source } = longFixture();
		const segment = measured(
			"温度は−5℃",
			[
				{ text: "温度は", startUs: 2_000_000, endUs: 3_000_000 },
				{ text: "5", startUs: 4_000_000, endUs: 5_000_000 },
			],
			6_000_000,
		);
		const result = captionsFromSourceSegments({
			document,
			sources: [source],
			mediaVersionId: source.mediaVersionId,
			idFor,
			requireAlignedText: true,
			segments: [segment],
		});
		expect(result.captions?.map((caption) => caption.text)).toEqual([
			"温度は",
			"−5℃",
		]);
	});
	it.each([
		"− ",
		"$ ",
	])("keeps separated %s with its number at a pause and source jump", (prefix) => {
		const { document, source } = longFixture();
		const text = `価格は${prefix}5℃`;
		const segment = measured(
			text,
			[
				{ text: "価格は", startUs: 2_000_000, endUs: 3_000_000 },
				{ text: "5", startUs: 4_000_000, endUs: 5_000_000 },
			],
			6_000_000,
		);
		const input = {
			document,
			sources: [source],
			mediaVersionId: source.mediaVersionId,
			idFor,
			requireAlignedText: true,
			segments: [segment],
		};
		expect(
			captionsFromSourceSegments(input).captions?.map((c) => c.text),
		).toEqual(["価格は", `${prefix}5℃`]);
		const clip = document.clips[0];
		if (!clip) throw new Error("Missing authored clip");
		clip.sourceInUs = 3_500_000;
		clip.durationFrames = 300;
		clip.framing = [
			{ fromFrame: 0, toFrame: 300, mode: "FIT", origin: "MANUAL" },
		];
		expect(
			captionsFromSourceSegments(input).captions?.map((c) => c.text),
		).toEqual([`${prefix}5℃`]);
	});

	it.each([
		{ origin: 0, editing: 0 },
		{ origin: 12_000_007, editing: 90 },
	])("rejects an original-time word tail even when CFR ceiling hides its earlier onset (%j)", ({
		origin,
		editing,
	}) => {
		const { document, source } = boundaryFixture(origin, editing);
		const clip = document.clips[0];
		if (!clip) throw new Error("Missing authored clip");
		clip.sourceInUs = origin + 1_000_000;
		const segment = {
			startUs: origin + 500_000,
			endUs: origin + 1_400_000,
			text: "前の言葉",
			words: [
				{
					text: "前の言葉",
					startUs: origin + 980_000,
					endUs: origin + 1_010_000,
					startChar: 0,
					endChar: 4,
					confidence: 0.9,
				},
			],
		};
		const input = {
			document,
			sources: [source],
			mediaVersionId: source.mediaVersionId,
			idFor,
			segments: [segment],
			speechIntervals: [
				{ startUs: origin + 500_000, endUs: origin + 1_400_000 },
			],
		};
		expect(captionsFromSourceSegments(input).captions).toHaveLength(1);
		expect(
			captionsFromSourceSegments({ ...input, requireAlignedText: true })
				.captions,
		).toEqual([]);
	});
	it("never broadcasts a following unaligned sentence into the preceding VAD island in aligned mode", () => {
		const { document, source } = longFixture();
		const original = structuredClone(document);
		const result = captionsFromSourceSegments({
			document,
			sources: [source],
			mediaVersionId: source.mediaVersionId,
			idFor,
			requireAlignedText: true,
			segments: [{ startUs: 2_000_000, endUs: 10_000_000, text: "次のセリフ" }],
			speechIntervals: [
				{ startUs: 1_000_000, endUs: 2_320_000 },
				{ startUs: 8_000_000, endUs: 10_000_000 },
			],
		});
		expect(result.captions).toEqual([]);
		expect(document).toEqual(original);
	});

	it("does not smuggle unaligned lexical text between aligned words into a reading cue", () => {
		const { document, source } = longFixture();
		const segment = measured("前の言葉未測定の次のセリフ最後", [
			{ text: "前の言葉", startUs: 2_000_000, endUs: 3_000_000 },
			{ text: "最後", startUs: 3_100_000, endUs: 4_000_000 },
		]);
		const result = captionsFromSourceSegments({
			document,
			sources: [source],
			mediaVersionId: source.mediaVersionId,
			idFor,
			requireAlignedText: true,
			segments: [segment],
		});
		expect(result.captions?.map((caption) => caption.text)).toEqual([
			"前の言葉",
			"最後",
		]);
	});

	it("shows the following measured sentence only at its aligned onset, independently of preceding VAD", () => {
		const { document, source } = longFixture();
		const segment = measured(
			"どこ行ったんや",
			[{ text: "どこ行ったんや", startUs: 8_000_000, endUs: 9_000_000 }],
			10_000_000,
		);
		const result = captionsFromSourceSegments({
			document,
			sources: [source],
			mediaVersionId: source.mediaVersionId,
			idFor,
			requireAlignedText: true,
			segments: [segment],
			speechIntervals: [
				{ startUs: 1_000_000, endUs: 2_320_000 },
				{ startUs: 8_000_000, endUs: 10_000_000 },
			],
		});
		expect(
			result.captions?.map(({ text, fromFrame, toFrame }) => ({
				text,
				fromFrame,
				toFrame,
			})),
		).toEqual([{ text: "どこ行ったんや", fromFrame: 210, toFrame: 240 }]);
	});

	it("does not turn the clipped tail of a measured word at a source jump into a new full-word caption", () => {
		const { document, source } = boundaryFixture();
		const clip = document.clips[0];
		if (!clip) throw new Error("Missing authored clip");
		clip.sourceInUs = 1_000_000;
		const segment = {
			startUs: 500_000,
			endUs: 1_400_000,
			text: "前の言葉",
			words: [
				{
					text: "前の言葉",
					startUs: 900_000,
					endUs: 1_100_000,
					startChar: 0,
					endChar: 4,
					confidence: 0.9,
				},
			],
		};
		const result = captionsFromSourceSegments({
			document,
			sources: [source],
			mediaVersionId: source.mediaVersionId,
			idFor,
			requireAlignedText: true,
			segments: [segment],
		});
		expect(result.captions).toEqual([]);
	});

	it.each([
		{ sourceStartUs: 0, editingStartFrame: 0 },
		{ sourceStartUs: 12_000_007, editingStartFrame: 90 },
	])("does not expand a long utterance's source-boundary tail into a one-frame full-text cue: %j", ({
		sourceStartUs,
		editingStartFrame,
	}) => {
		const { document, source } = boundaryFixture(
			sourceStartUs,
			editingStartFrame,
		);
		const segments = [
			{
				startUs: sourceStartUs + 298_280_000,
				endUs: sourceStartUs + 300_670_000,
				text: "Make sure the entire utterance is not displayed from its tail.",
			},
		];
		const original = structuredClone({ document, segments });
		const result = captionsFromSourceSegments({
			document,
			sources: [source],
			mediaVersionId: source.mediaVersionId,
			idFor,
			segments,
		});
		expect(result.captions).toEqual([]);
		expect({ document, segments }).toEqual(original);
	});

	it("omits an unmeasured long utterance's one-frame head at the selected run's end", () => {
		const { document, source } = boundaryFixture();
		const clip = document.clips[0];
		if (!clip) throw new Error("Missing clip");
		clip.sourceInUs = 1_000_000;
		const result = captionsFromSourceSegments({
			document,
			sources: [source],
			mediaVersionId: source.mediaVersionId,
			idFor,
			segments: [
				{ startUs: 1_200_000, endUs: 3_590_000, text: "A long utterance." },
			],
		});
		expect(result.captions).toEqual([]);
	});

	it("keeps a complete short utterance and a partial utterance with more than one source frame even when its cue is one frame", () => {
		const { document, source } = boundaryFixture();
		const clip = document.clips[0];
		if (!clip) throw new Error("Missing clip");
		clip.sourceInUs = 1_000_000;
		const result = captionsFromSourceSegments({
			document,
			sources: [source],
			mediaVersionId: source.mediaVersionId,
			idFor,
			segments: [
				{ startUs: 1_100_000, endUs: 1_120_000, text: "Yes!" },
				{
					startUs: 1_190_000,
					endUs: 3_590_000,
					text: "More than a frame is selected.",
				},
			],
		});
		expect(
			result.captions?.map(({ text, fromFrame, toFrame }) => ({
				text,
				fromFrame,
				toFrame,
			})),
		).toEqual([
			{ text: "Yes!", fromFrame: 332, toFrame: 333 },
			{ text: "More than a frame is selected.", fromFrame: 335, toFrame: 336 },
		]);
	});

	it("retains measured words at a source-boundary tail and existing manual one-frame captions", () => {
		const { document, source } = boundaryFixture();
		const manual = {
			id: compositionIds.item,
			text: "Manual",
			fromFrame: 329,
			toFrame: 330,
		};
		document.captions = [manual];
		const result = captionsFromSourceSegments({
			document,
			sources: [source],
			mediaVersionId: source.mediaVersionId,
			idFor,
			segments: [
				{
					startUs: 298_280_000,
					endUs: 300_670_000,
					text: "Make sure",
					words: [
						{
							text: "sure",
							startChar: 5,
							endChar: 9,
							confidence: 0.95,
							startUs: 300_660_000,
							endUs: 300_670_000,
						},
					],
				},
			],
		});
		expect(result.captions?.[0]).toEqual(manual);
		expect(result.captions?.[1]).toMatchObject({
			text: "sure",
			fromFrame: 329,
			toFrame: 330,
			words: [
				{
					text: "sure",
					startChar: 0,
					endChar: 4,
					fromFrame: 329,
					toFrame: 330,
				},
			],
		});
		const withoutMeasuredWords = captionsFromSourceSegments({
			document,
			sources: [source],
			mediaVersionId: source.mediaVersionId,
			idFor,
			segments: [
				{
					startUs: 298_280_000,
					endUs: 300_670_000,
					text: "An unmeasured long utterance.",
				},
			],
		});
		expect(withoutMeasuredWords.captions).toEqual([manual]);
	});

	it.each([
		false,
		true,
	])("joins a measured word across contiguous camera cuts without a duplicate (aligned mode %s)", (requireAlignedText) => {
		const { document, source } = compositionFixture();
		const clip = document.clips[0];
		if (!clip) throw new Error("Missing clip");
		source.timeMap.sourceStartUs = 0;
		source.timeMap.sourceEndUs = 734_000_000;
		source.timeMap.editingStartFrame = 0;
		source.timeMap.editingEndFrame = 22020;
		Object.assign(clip, {
			sourceInUs: 40_266_667,
			timelineStartFrame: 458,
			durationFrames: 55,
			framing: [{ fromFrame: 0, toFrame: 55, mode: "FIT", origin: "MANUAL" }],
		});
		document.clips.push({
			...structuredClone(clip),
			id: compositionIds.other,
			sourceInUs: 42_100_000,
			timelineStartFrame: 513,
			durationFrames: 106,
			framing: [{ fromFrame: 0, toFrame: 106, mode: "FIT", origin: "MANUAL" }],
		});
		// Minimal source-clock fixture matching the observed ToS word's CFR
		// interval 492..515. This is not a claim to recover its raw ASR bytes.
		const segment: CompositionSourceSegment = {
			startUs: 40_266_667,
			endUs: 42_170_000,
			text: "robotic",
			words: [
				{
					text: "robotic",
					startChar: 0,
					endChar: 7,
					startUs: 41_400_000,
					endUs: 42_160_000,
					confidence: 0.741453,
				},
			],
		};
		const input = {
			document,
			sources: [source],
			mediaVersionId: source.mediaVersionId,
			idFor,
			segments: [segment],
			requireAlignedText,
		};
		const result = captionsFromSourceSegments(input);
		expect(result.captions).toHaveLength(1);
		expect(result.captions?.[0]).toMatchObject({
			text: "robotic",
			fromFrame: 492,
			toFrame: 515,
			words: [{ text: "robotic", fromFrame: 492, toFrame: 515 }],
			sourceEvidence: {
				transcriptSegmentsHash: hashEditingEvidence(input.segments),
				segmentIndex: 0,
				segmentStartUs: segment.startUs,
				segmentEndUs: segment.endUs,
				spans: [
					{
						clipId: compositionIds.clip,
						outputFromFrame: 492,
						outputToFrame: 513,
					},
					{
						clipId: compositionIds.other,
						outputFromFrame: 513,
						outputToFrame: 515,
					},
				],
			},
		});
		expect(result.captions?.[0]?.anchorClipId).toBeUndefined();
		expect(captionsFromSourceSegments({ ...input, document: result })).toEqual(
			result,
		);
		expect(input.segments[0]).toEqual(segment);
	});

	it.each([
		"SOURCE_GAP",
		"OUTPUT_GAP",
		"REUSED_SOURCE",
	] as const)("does not join repeated text through a noncontinuous mapping: %s", (kind) => {
		const { document, source } = compositionFixture();
		const clip = document.clips[0];
		if (!clip) throw new Error("Missing clip");
		clip.sourceInUs = 1_000_000;
		clip.durationFrames = 30;
		clip.framing = [
			{ fromFrame: 0, toFrame: 30, mode: "FIT", origin: "MANUAL" },
		];
		document.clips.push({
			...structuredClone(clip),
			id: compositionIds.other,
			sourceInUs:
				kind === "REUSED_SOURCE"
					? 1_000_000
					: kind === "SOURCE_GAP"
						? 2_033_334
						: 2_000_000,
			timelineStartFrame: kind === "OUTPUT_GAP" ? 31 : 30,
		});
		const result = captionsFromSourceSegments({
			document,
			sources: [source],
			mediaVersionId: source.mediaVersionId,
			idFor,
			segments: [
				{
					startUs: 1_000_000,
					endUs: 3_000_000,
					text: "Same actual source segment",
				},
			],
		});
		expect(result.captions).toHaveLength(2);
		expect(result.captions?.map((caption) => caption.anchorClipId)).toEqual([
			compositionIds.clip,
			compositionIds.other,
		]);
	});

	it("keeps real repeated utterances as distinct segment references even when their text and output touch", () => {
		const { document, source } = compositionFixture();
		const result = captionsFromSourceSegments({
			document,
			sources: [source],
			mediaVersionId: source.mediaVersionId,
			idFor,
			segments: [
				{ startUs: 1_100_000, endUs: 1_500_000, text: "Go!" },
				{ startUs: 1_500_000, endUs: 1_900_000, text: "Go!" },
			],
		});
		expect(result.captions).toHaveLength(2);
		expect(
			result.captions?.map((caption) => caption.sourceEvidence?.segmentIndex),
		).toEqual([0, 1]);
	});
	it("omits unselected dialogue while retaining actual Japanese punctuation, offsets and word gaps", () => {
		const { document, source } = compositionFixture();
		const result = captionsFromSourceSegments({
			document,
			sources: [source],
			mediaVersionId: source.mediaVersionId,
			idFor,
			segments: [
				measured("Before, 「猫、犬！」 After.", [
					{ text: "Before", startUs: 1_000_000, endUs: 1_020_000 },
					{ text: "猫", startUs: 1_100_000, endUs: 1_200_000 },
					{ text: "犬", startUs: 1_500_000, endUs: 1_600_000 },
					{ text: "After", startUs: 4_500_000, endUs: 4_800_000 },
				]),
			],
		});
		expect(result.captions).toHaveLength(1);
		expect(result.captions?.[0]).toMatchObject({
			text: "「猫、犬！」",
			fromFrame: 2,
			toFrame: 17,
			words: [
				{
					text: "猫",
					startChar: 1,
					endChar: 2,
					fromFrame: 2,
					toFrame: 5,
					confidence: 0.85,
				},
				{
					text: "犬",
					startChar: 3,
					endChar: 4,
					fromFrame: 14,
					toFrame: 17,
					confidence: 0.85,
				},
			],
		});
		const plan = compileComposition(result, [source]);
		expect(evaluateCompositionFrame(plan, 6).captions[0]?.activeWords).toEqual(
			[],
		);
		expect(evaluateCompositionFrame(plan, 1).captions).toEqual([]);
	});

	it("does not substitute whole-segment dialogue when all measured words are outside the selected clip", () => {
		const { document, source } = compositionFixture();
		const result = captionsFromSourceSegments({
			document,
			sources: [source],
			mediaVersionId: source.mediaVersionId,
			idFor,
			segments: [
				measured("Before. After.", [
					{ text: "Before", startUs: 1_000_000, endUs: 1_020_000 },
					{ text: "After", startUs: 4_500_000, endUs: 4_800_000 },
				]),
			],
		});
		expect(result.captions).toEqual([]);
	});

	it("splits long measured speech at real word boundaries and preserves every selected word", () => {
		const { document, source } = longFixture();
		const tokens =
			"alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma".split(
				" ",
			);
		const segment = measured(
			`${tokens.join(" ")}.`,
			tokens.map((text, index) => ({
				text,
				startUs: 1_100_000 + index * 250_000,
				endUs: 1_300_000 + index * 250_000,
			})),
			6_000_000,
		);
		const result = captionsFromSourceSegments({
			document,
			sources: [source],
			mediaVersionId: source.mediaVersionId,
			idFor,
			segments: [segment],
		});
		expect(result.captions?.length).toBeGreaterThan(1);
		expect(result.captions?.map((caption) => caption.text).join(" ")).toBe(
			segment.text,
		);
		expect(
			result.captions?.flatMap(
				(caption) => caption.words?.map((word) => word.text) ?? [],
			),
		).toEqual(tokens);
		for (const caption of result.captions ?? []) {
			expect(caption.text.length).toBeLessThanOrEqual(42);
			expect(caption.toFrame - caption.fromFrame).toBeLessThanOrEqual(120);
			for (const word of caption.words ?? []) {
				expect(caption.text.slice(word.startChar, word.endChar)).toBe(
					word.text,
				);
				expect(word.fromFrame).toBeGreaterThanOrEqual(caption.fromFrame);
				expect(word.toFrame).toBeLessThanOrEqual(caption.toFrame);
			}
		}
		expect(result.captions?.[0]?.fromFrame).toBe(3);
	});

	it("keeps measured pauses empty and assigns quotation punctuation to the correct sentence", () => {
		const { document, source } = compositionFixture();
		const result = captionsFromSourceSegments({
			document,
			sources: [source],
			mediaVersionId: source.mediaVersionId,
			idFor,
			segments: [
				measured('"Keep it!" "Wait."', [
					{ text: "Keep", startUs: 1_100_000, endUs: 1_300_000 },
					{ text: "it", startUs: 1_300_000, endUs: 1_500_000 },
					{ text: "Wait", startUs: 2_500_000, endUs: 2_800_000 },
				]),
			],
		});
		expect(result.captions?.map((caption) => caption.text)).toEqual([
			'"Keep it!"',
			'"Wait."',
		]);
		const plan = compileComposition(result, [source]);
		expect(evaluateCompositionFrame(plan, 30).captions).toEqual([]);
	});

	it("retains a long measured segment without guessing word timing when alignment is unavailable", () => {
		const { document, source } = longFixture();
		const text =
			"This entire passage has segment timing only. It must remain verbatim rather than receive evenly divided invented word times.";
		const result = captionsFromSourceSegments({
			document,
			sources: [source],
			mediaVersionId: source.mediaVersionId,
			idFor,
			segments: [{ startUs: 1_000_000, endUs: 25_000_000, text }],
		});
		expect(result.captions).toHaveLength(1);
		expect(result.captions?.[0]).toMatchObject({
			text,
			fromFrame: 0,
			toFrame: 720,
		});
		expect(result.captions?.[0]?.words).toBeUndefined();
	});

	it("keeps manual captions and gives split cues distinct stable IDs on reused source clips", () => {
		const { document, source } = longFixture();
		const clip = document.clips[0];
		if (!clip) throw new Error("Missing clip");
		document.clips.push({
			...structuredClone(clip),
			id: compositionIds.other,
			timelineStartFrame: 900,
		});
		const manual = {
			id: compositionIds.item,
			text: "User correction",
			fromFrame: 1,
			toFrame: 10,
		};
		document.captions = [manual];
		const segment = measured("First. Second.", [
			{ text: "First", startUs: 1_100_000, endUs: 1_300_000 },
			{ text: "Second", startUs: 2_500_000, endUs: 2_800_000 },
		]);
		const input = {
			document,
			sources: [source],
			mediaVersionId: source.mediaVersionId,
			idFor,
			segments: [segment],
		};
		const result = captionsFromSourceSegments(input);
		expect(result.captions?.[0]).toEqual(manual);
		expect(result.captions).toHaveLength(5);
		expect(new Set(result.captions?.map((caption) => caption.id)).size).toBe(5);
		expect(captionsFromSourceSegments(input)).toEqual(result);
		expect(document.captions).toEqual([manual]);
	});
	it("does not duplicate or overwrite an edited cue when the same evidence is applied again", () => {
		const { document, source } = compositionFixture();
		const input = {
			sources: [source],
			mediaVersionId: source.mediaVersionId,
			idFor,
			segments: [
				measured("First. Second.", [
					{ text: "First", startUs: 1_100_000, endUs: 1_300_000 },
					{ text: "Second", startUs: 2_500_000, endUs: 2_800_000 },
				]),
			],
		};
		const edited = captionsFromSourceSegments({ ...input, document });
		const first = edited.captions?.[0];
		if (!first) throw new Error("Missing first cue");
		first.text = "User's corrected subtitle.";
		delete first.words;
		expect(captionsFromSourceSegments({ ...input, document: edited })).toEqual(
			edited,
		);
	});
	it("rejects new cue ID collisions instead of silently dropping subtitle text", () => {
		const { document, source } = compositionFixture();
		const segment = measured("First. Second.", [
			{ text: "First", startUs: 1_100_000, endUs: 1_300_000 },
			{ text: "Second", startUs: 2_500_000, endUs: 2_800_000 },
		]);
		expect(() =>
			captionsFromSourceSegments({
				document,
				sources: [source],
				mediaVersionId: source.mediaVersionId,
				idFor: () => compositionIds.item,
				segments: [segment],
			}),
		).toThrow("Duplicate caption ID");
	});
});

describe("VAD-supported display windows for unmeasured captions", () => {
	function fixture(originUs = 0, editingStartFrame = 0) {
		const f = longFixture();
		Object.assign(f.source.timeMap, {
			sourceStartUs: originUs,
			sourceEndUs: originUs + 31_000_000,
			editingStartFrame,
			editingEndFrame: editingStartFrame + 930,
		});
		const clip = f.document.clips[0];
		if (!clip) throw new Error("Missing VAD fixture clip");
		clip.sourceInUs = originUs + 1_000_000;
		return f;
	}
	function build(
		f: ReturnType<typeof fixture>,
		segments: CompositionSourceSegment[],
		speechIntervals?: readonly { startUs: number; endUs: number }[],
	) {
		return captionsFromSourceSegments({
			document: f.document,
			sources: [f.source],
			mediaVersionId: f.source.mediaVersionId,
			idFor,
			segments,
			speechIntervals,
		});
	}
	const bounds = (document: ReturnType<typeof build>) =>
		document.captions?.map(({ fromFrame, toFrame }) => [fromFrame, toFrame]);

	it.each([
		{ originUs: 0, editingStartFrame: 0 },
		{ originUs: 12_000_007, editingStartFrame: 90 },
	])("removes tiny carry-in support before a long silent lead without changing source clocks: %j", ({
		originUs,
		editingStartFrame,
	}) => {
		const f = fixture(originUs, editingStartFrame);
		const segment = {
			startUs: originUs + 1_000_000,
			endUs: originUs + 8_750_000,
			text: "同じ発話の原文を維持します",
		};
		const intervals = [
			[470_000, 1_110_000],
			[5_270_000, 5_680_000],
			[6_070_000, 6_610_000],
			[7_410_000, 9_070_000],
		].map(([startUs = 0, endUs = 0]) => ({
			startUs: startUs + originUs,
			endUs: endUs + originUs,
		}));
		const original = structuredClone({
			segment,
			intervals,
			document: f.document,
		});
		const result = build(f, [segment], intervals);
		expect(bounds(result)).toEqual([
			[129, 172],
			[193, 233],
		]);
		expect(
			result.captions?.every(
				(caption) =>
					caption.text === segment.text && caption.words === undefined,
			),
		).toBe(true);
		expect(
			result.captions?.map((caption) => [
				caption.sourceEvidence?.segmentStartUs,
				caption.sourceEvidence?.segmentEndUs,
				caption.sourceEvidence?.segmentTextHash,
			]),
		).toEqual(
			Array.from({ length: 2 }, () => [
				segment.startUs,
				segment.endUs,
				hashEditingEvidence(segment.text),
			]),
		);
		const plan = compileComposition(result, [f.source]);
		expect(evaluateCompositionFrame(plan, 1).captions).toEqual([]);
		expect(evaluateCompositionFrame(plan, 90).captions).toEqual([]);
		expect(evaluateCompositionFrame(plan, 180).captions).toEqual([]);
		expect(evaluateCompositionFrame(plan, 130).captions).toHaveLength(1);
		expect({ segment, intervals, document: f.document }).toEqual(original);
	});

	it("keeps complete meaningful short speech, including a single carry-in island", () => {
		const f = fixture();
		const short = { startUs: 1_100_000, endUs: 1_210_000, text: "はい" };
		expect(
			bounds(
				build(
					f,
					[short],
					[
						{
							startUs: short.startUs,
							endUs: short.endUs,
						},
					],
				),
			),
		).toEqual([[3, 7]]);
		expect(
			bounds(
				build(
					f,
					[short],
					[
						{
							startUs: 900_000,
							endUs: short.endUs,
						},
					],
				),
			),
		).toEqual([[3, 7]]);
	});

	it("separates long internal silence and keeps the same text without invented word alignment", () => {
		const f = fixture();
		const text = "原文を推測で二つに分割しません";
		const result = build(
			f,
			[{ startUs: 1_000_000, endUs: 8_000_000, text }],
			[
				{ startUs: 2_000_000, endUs: 3_000_000 },
				{ startUs: 5_000_000, endUs: 6_000_000 },
			],
		);
		expect(bounds(result)).toEqual([
			[30, 63],
			[120, 153],
		]);
		expect(result.captions?.map((caption) => caption.text)).toEqual([
			text,
			text,
		]);
		expect(result.captions?.map((caption) => caption.words)).toEqual([
			undefined,
			undefined,
		]);
		expect(
			evaluateCompositionFrame(compileComposition(result, [f.source]), 90)
				.captions,
		).toEqual([]);
	});

	it.each([
		{ gapUs: 599_999, expected: [[15, 63]] },
		{
			gapUs: 600_000,
			expected: [
				[15, 33],
				[48, 63],
			],
		},
	])("merges only pauses below 600 ms: $gapUs", ({ gapUs, expected }) => {
		const f = fixture();
		const result = build(
			f,
			[{ startUs: 1_000_000, endUs: 5_000_000, text: "同じ原文" }],
			[
				{ startUs: 1_500_000, endUs: 2_000_000 },
				{ startUs: 2_000_000 + gapUs, endUs: 3_000_000 },
			],
		);
		expect(bounds(result)).toEqual(expected);
	});

	it("keeps measured word cues identical even when the optional VAD projection is empty", () => {
		const f = fixture();
		const segment = measured("First. Second.", [
			{ text: "First", startUs: 1_100_000, endUs: 1_500_000 },
			{ text: "Second", startUs: 2_500_000, endUs: 2_800_000 },
		]);
		expect(build(f, [segment], [])).toEqual(build(f, [segment]));
	});

	it("preserves the legacy undefined-VAD result and treats present empty VAD as no unmeasured speech", () => {
		const f = fixture();
		const segments = [
			{ startUs: 1_000_000, endUs: 5_000_000, text: "未整列の原文" },
		];
		const legacy = captionsFromSourceSegments({
			document: f.document,
			sources: [f.source],
			mediaVersionId: f.source.mediaVersionId,
			idFor,
			segments,
		});
		expect(build(f, segments, undefined)).toEqual(legacy);
		expect(build(f, segments, []).captions).toEqual([]);
	});

	it("maps independent source runs separately and clamps padding to the selected clip", () => {
		const f = fixture();
		const first = f.document.clips[0];
		if (!first) throw new Error("Missing VAD clip");
		first.durationFrames = 30;
		first.framing = [
			{ fromFrame: 0, toFrame: 30, mode: "FIT", origin: "MANUAL" },
		];
		f.document.clips.push({
			...structuredClone(first),
			id: compositionIds.other,
			sourceInUs: 5_000_000,
			timelineStartFrame: 30,
		});
		const result = build(
			f,
			[{ startUs: 1_000_000, endUs: 7_000_000, text: "原文" }],
			[
				{ startUs: 1_800_000, endUs: 2_200_000 },
				{ startUs: 5_200_000, endUs: 5_600_000 },
			],
		);
		expect(bounds(result)).toEqual([
			[24, 30],
			[36, 51],
		]);
		expect(
			result.captions?.map((caption) =>
				caption.sourceEvidence?.spans.map((span) => span.clipId),
			),
		).toEqual([[compositionIds.clip], [compositionIds.other]]);
	});

	it.each([
		{
			name: "gap below threshold",
			segmentEnd: 5_000_000,
			prefixStart: 900_000,
			prefixEnd: 1_100_000,
			laterStart: 1_680_000,
			laterEnd: 4_000_000,
		},
		{
			name: "prefix longer than 200ms",
			segmentEnd: 5_000_000,
			prefixStart: 900_000,
			prefixEnd: 1_200_001,
			laterStart: 2_000_000,
			laterEnd: 5_000_000,
		},
		{
			name: "later support below 500ms",
			segmentEnd: 4_000_000,
			prefixStart: 900_000,
			prefixEnd: 1_010_000,
			laterStart: 3_000_000,
			laterEnd: 3_499_999,
		},
		{
			name: "prefix exceeds ten percent",
			segmentEnd: 4_000_000,
			prefixStart: 900_000,
			prefixEnd: 1_200_000,
			laterStart: 3_000_000,
			laterEnd: 3_600_000,
		},
		{
			name: "segment shorter than two seconds",
			segmentEnd: 2_999_999,
			prefixStart: 900_000,
			prefixEnd: 1_010_000,
			laterStart: 1_700_000,
			laterEnd: 2_800_000,
		},
		{
			name: "island starts at segment boundary",
			segmentEnd: 5_000_000,
			prefixStart: 1_000_000,
			prefixEnd: 1_100_000,
			laterStart: 2_000_000,
			laterEnd: 5_000_000,
		},
	])("does not remove short support when a carry-in guard is missing: $name", ({
		segmentEnd,
		prefixStart,
		prefixEnd,
		laterStart,
		laterEnd,
	}) => {
		const f = fixture();
		const result = build(
			f,
			[{ startUs: 1_000_000, endUs: segmentEnd, text: "短い発話も残す" }],
			[
				{ startUs: prefixStart, endUs: prefixEnd },
				{ startUs: laterStart, endUs: laterEnd },
			],
		);
		expect(result.captions?.[0]?.fromFrame).toBe(0);
	});

	it.each(
		[
			[{ startUs: 2_000_000, endUs: 1_000_000 }],
			[{ startUs: -1, endUs: 1_000_000 }],
			[
				{ startUs: 2_000_000, endUs: 3_000_000 },
				{ startUs: 1_000_000, endUs: 2_000_000 },
			],
			[
				{ startUs: 1_000_000, endUs: 3_000_000 },
				{ startUs: 2_000_000, endUs: 4_000_000 },
			],
			[{ startUs: 30_000_000, endUs: 32_000_000 }],
		].map((intervals) => ({ intervals })),
	)("rejects malformed or out-of-source optional evidence", ({ intervals }) => {
		expect(() =>
			build(
				fixture(),
				[{ startUs: 1_000_000, endUs: 8_000_000, text: "原文" }],
				intervals,
			),
		).toThrow();
	});
});

it("visits only the intersecting VAD range in a large sorted source", () => {
	const intervals = Array.from({ length: 10_000 }, (_, index) => ({
		startUs: index * 300_000,
		endUs: index * 300_000 + 100_000,
	}));
	let reads = 0;
	const observed = new Proxy(intervals, {
		get(target, key, receiver) {
			if (typeof key === "string" && /^[0-9]+$/.test(key)) reads++;
			return Reflect.get(target, key, receiver);
		},
	});
	const segment = intervals[9998];
	if (!segment) throw new Error("Missing large VAD fixture");
	expect(unmeasuredSubtitleWindows(segment, observed)).toEqual([segment]);
	expect(reads).toBeLessThan(32);
});

it("enforces the existing caption budget before accumulating another derived cue", () => {
	const f = longFixture();
	f.document.captions = Array.from({ length: 300 }, (_, index) => ({
		id: `bbbbbbbb-bbbb-4bbb-8bbb-${String(index).padStart(12, "0")}`,
		text: "Manual",
		fromFrame: 0,
		toFrame: 1,
	}));
	const before = structuredClone(f.document);
	expect(() =>
		captionsFromSourceSegments({
			document: f.document,
			sources: [f.source],
			mediaVersionId: f.source.mediaVersionId,
			idFor,
			segments: [{ startUs: 1_000_000, endUs: 5_000_000, text: "原文" }],
			speechIntervals: [{ startUs: 2_000_000, endUs: 3_000_000 }],
		}),
	).toThrow("Caption budget exceeded");
	expect(f.document).toEqual(before);
});
