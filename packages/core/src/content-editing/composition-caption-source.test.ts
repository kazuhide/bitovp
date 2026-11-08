import { describe, expect, it } from "vitest";
import {
	isCompositionCaptionSourceEvidenceCurrent,
	normalizeManualCaptionSourceEvidenceEdits,
} from "./composition-caption-source";
import { captionsFromSourceSegments } from "./composition-evidence";
import { compositionCaptionSchema } from "./composition-schema";
import {
	compositionFixture,
	compositionIds,
} from "./composition-test-fixtures";

function derived() {
	const { document, source } = compositionFixture();
	return captionsFromSourceSegments({
		document,
		sources: [source],
		mediaVersionId: source.mediaVersionId,
		idFor: () => compositionIds.item,
		segments: [
			{
				startUs: 1_100_000,
				endUs: 1_500_000,
				text: "Actual speech",
				words: [
					{
						text: "Actual",
						startChar: 0,
						endChar: 6,
						startUs: 1_100_000,
						endUs: 1_300_000,
						confidence: 0.9,
					},
					{
						text: "speech",
						startChar: 7,
						endChar: 13,
						startUs: 1_300_000,
						endUs: 1_500_000,
						confidence: 0.8,
					},
				],
			},
		],
	});
}

describe("source subtitle derivation references", () => {
	it("retains the existing named video-track ID domain in source references", () => {
		const { document, source } = compositionFixture();
		const clip = document.clips[0];
		if (!clip) throw new Error("Missing clip");
		clip.trackId = "main";
		const result = captionsFromSourceSegments({
			document,
			sources: [source],
			mediaVersionId: source.mediaVersionId,
			idFor: () => compositionIds.item,
			segments: [{ startUs: 1_100_000, endUs: 1_500_000, text: "Speech" }],
		});
		expect(result.captions?.[0]?.sourceEvidence?.spans[0]?.clip.trackId).toBe(
			"main",
		);
	});
	it("accepts an additive source-segment reference without claiming a native receipt", () => {
		const caption = {
			id: compositionIds.item,
			text: "robotic",
			fromFrame: 492,
			toFrame: 515,
			sourceEvidence: {
				version: "source-caption-v1",
				mediaVersionId: compositionIds.media,
				timeMapId: compositionIds.map,
				segmentIndex: 0,
				segmentStartUs: 40_000_000,
				segmentEndUs: 43_000_000,
				segmentTextHash: "a".repeat(64),
				transcriptSegmentsHash: "b".repeat(64),
				caption: { text: "robotic", fromFrame: 492, toFrame: 515 },
				spans: [
					{
						clipId: compositionIds.clip,
						sourceFromFrame: 1242,
						sourceToFrame: 1263,
						outputFromFrame: 492,
						outputToFrame: 513,
						clip: {
							sourceInUs: 40_266_667,
							durationFrames: 55,
							timelineStartFrame: 458,
						},
					},
					{
						clipId: compositionIds.other,
						sourceFromFrame: 1263,
						sourceToFrame: 1265,
						outputFromFrame: 513,
						outputToFrame: 515,
						clip: {
							sourceInUs: 42_100_000,
							durationFrames: 106,
							timelineStartFrame: 513,
						},
					},
				],
			},
		};
		expect(compositionCaptionSchema.parse(caption)).toEqual(caption);
	});

	it.each([
		"TEXT",
		"TIME",
		"WORDS",
		"SOURCE",
		"MOVE",
		"DELETE",
	] as const)("invalidates a derivation reference after a manual %s edit without changing historical evidence", (kind) => {
		const previous = derived();
		const next = structuredClone(previous);
		const caption = next.captions?.[0];
		const clip = next.clips[0];
		if (!caption || !clip) throw new Error("Missing fixture");
		const raw = structuredClone(previous);
		if (kind === "TEXT") {
			caption.text = "Manual correction";
			delete caption.words;
		}
		if (kind === "TIME") caption.toFrame++;
		if (kind === "WORDS") {
			const word = caption.words?.[0];
			if (word) word.confidence = 0.1;
		}
		if (kind === "SOURCE") clip.sourceInUs++;
		if (kind === "MOVE") clip.timelineStartFrame++;
		if (kind === "DELETE") next.clips = [];
		expect(isCompositionCaptionSourceEvidenceCurrent(caption, next)).toBe(
			false,
		);
		const normalized = normalizeManualCaptionSourceEvidenceEdits(
			previous,
			next,
		);
		expect(normalized.captions?.[0]?.sourceEvidence).toBeUndefined();
		expect(previous).toEqual(raw);
		expect(caption.sourceEvidence).toEqual(
			previous.captions?.[0]?.sourceEvidence,
		);
	});

	it("preserves source references for layout or translation-only edits, which do not change the utterance", () => {
		const previous = derived();
		const next = structuredClone(previous);
		next.captionStyle = { fontSize: 0.03 };
		next.captionDisplayLanguage = "ja";
		const clip = next.clips[0];
		if (!clip) throw new Error("Missing clip");
		clip.layout = { x: 0.1, y: 0, w: 0.9, h: 1 };
		expect(normalizeManualCaptionSourceEvidenceEdits(previous, next)).toEqual(
			next,
		);
	});

	it("strips new or forged client references even when their internally consistent snapshots were copied", () => {
		const next = derived();
		const previous = structuredClone(next);
		previous.captions = [];
		expect(
			normalizeManualCaptionSourceEvidenceEdits(previous, next).captions?.[0]
				?.sourceEvidence,
		).toBeUndefined();
		const trusted = derived();
		const forged = structuredClone(trusted);
		const evidence = forged.captions?.[0]?.sourceEvidence;
		if (!evidence) throw new Error("Missing reference");
		evidence.segmentTextHash = "f".repeat(64);
		expect(
			normalizeManualCaptionSourceEvidenceEdits(trusted, forged).captions?.[0]
				?.sourceEvidence,
		).toBeUndefined();
	});
});
