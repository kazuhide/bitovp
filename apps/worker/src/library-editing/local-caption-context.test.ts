import {
	type CompositionDocument,
	compositionCaptionClipSnapshot,
	compositionCaptionSourceEvidenceSchema,
	hashEditingEvidence,
	sceneAnalysisDocumentSchema,
} from "@bitovp/core";
import { describe, expect, it } from "vitest";
import { buildLocalCaptionSceneContexts } from "./local-caption-context";

const id = (n: number) =>
	`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const required = <T>(value: T | undefined): T => {
	if (value === undefined) throw Error("missing fixture");
	return value;
};
function fixture() {
	const clips = [0, 1].map((n) => ({
		id: id(n + 1),
		sourceInUs: n * 1e6,
		durationFrames: 30,
		timelineStartFrame: n * 30,
		evidence: { sceneId: id(n + 10), shotIndex: 0 },
	})) as CompositionDocument["clips"];
	const caption = {
		id: id(30),
		text: "Hello again.",
		fromFrame: 0,
		toFrame: 60,
	};
	const document = {
		schemaVersion: 2,
		mediaVersionId: id(40),
		timeMapId: id(41),
		clips,
		captions: [
			{
				...caption,
				sourceEvidence: compositionCaptionSourceEvidenceSchema.parse({
					version: "source-caption-v1",
					mediaVersionId: id(40),
					timeMapId: id(41),
					segmentIndex: 0,
					segmentStartUs: 0,
					segmentEndUs: 2e6,
					segmentTextHash: hashEditingEvidence(caption.text),
					caption: {
						text: caption.text,
						fromFrame: caption.fromFrame,
						toFrame: caption.toFrame,
					},
					transcriptSegmentsHash: hashEditingEvidence("fixture transcript"),
					spans: clips.map((clip, n) => ({
						clipId: clip.id,
						sourceFromFrame: n * 30,
						sourceToFrame: (n + 1) * 30,
						outputFromFrame: n * 30,
						outputToFrame: (n + 1) * 30,
						clip: compositionCaptionClipSnapshot(clip),
					})),
				}),
			},
		],
	} as unknown as CompositionDocument;
	const analysis = sceneAnalysisDocumentSchema.parse({
		providerVersion: "fixture",
		duration: 2,
		scenes: [0, 1].map((n) => ({
			id: id(n + 10),
			startInSeconds: n,
			endInSeconds: n + 1,
			title: `Scene ${n}`,
			summary: `Context ${n}`,
			shots: [
				{
					startInSeconds: n,
					endInSeconds: n + 1,
					detailedDescription: `Shot ${n}`,
				},
			],
			content: { characters: [{ name: n ? "Alice" : "Bob" }] },
		})),
	});
	return { document, analysis, mediaVersionId: id(40), timeMapId: id(41) };
}
describe("source-bound subtitle scene context", () => {
	it("uses all current source spans for a cue crossing two contiguous clips", () => {
		const context = buildLocalCaptionSceneContexts(fixture()).get(id(30));
		expect(context?.fields.map((f) => f.text)).toEqual([
			"Scene 0",
			"Bob",
			"Shot 0",
			"Context 0",
			"Scene 1",
			"Alice",
			"Shot 1",
			"Context 1",
		]);
	});
	it("never uses stale source spans or another media version's AISA context", () => {
		const stale = fixture();
		required(stale.document.clips[0]).sourceInUs = 500_000;
		expect(buildLocalCaptionSceneContexts(stale).get(id(30))?.fields).toEqual(
			[],
		);
		const foreign = fixture();
		foreign.mediaVersionId = id(99);
		expect(buildLocalCaptionSceneContexts(foreign).get(id(30))?.fields).toEqual(
			[],
		);
	});
	it("binds scene text edits to both source and consistency identities", () => {
		const f = fixture(),
			before = buildLocalCaptionSceneContexts(f).get(id(30));
		required(f.analysis.scenes[0]).summary =
			"Another meaning of the same words.";
		const after = buildLocalCaptionSceneContexts(f).get(id(30));
		expect(after?.sourceHash).not.toBe(before?.sourceHash);
		expect(after?.scopeHash).not.toBe(before?.scopeHash);
	});
});
