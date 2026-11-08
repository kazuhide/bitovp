import { expect, it } from "vitest";
import {
	anyEditingDocumentSchema,
	compositionDocumentSchema,
	toCompositionDocument,
} from "./composition-schema";
import { editingDocumentSchema } from "./schema";

const media = "11111111-1111-4111-8111-111111111111";
const map = "22222222-2222-4222-8222-222222222222";
const clip = "33333333-3333-4333-8333-333333333333";
const caption = "44444444-4444-4444-8444-444444444444";
function v1() {
	return editingDocumentSchema.parse({
		schemaVersion: 1,
		mediaVersionId: media,
		timeMapId: map,
		analysisRevisionId: null,
		locale: "ja",
		sourceTimeDomain: "ORIGINAL_PRESENTATION_US",
		canvas: { width: 1080, height: 1920 },
		fps: { num: 30, den: 1 },
		clips: [
			{
				id: clip,
				sourceInUs: 0,
				durationFrames: 90,
				timelineStartFrame: 0,
				framing: [{ fromFrame: 0, toFrame: 90, mode: "FIT", origin: "MANUAL" }],
				audio: { mode: "SOURCE" },
			},
		],
	});
}

it("keeps the original v1 contract and produces independently editable v2 defaults", () => {
	const original = v1();
	const before = JSON.stringify(original);
	const upgraded = toCompositionDocument(original);
	expect(upgraded.schemaVersion).toBe(2);
	expect(upgraded.clips).toEqual(original.clips);
	expect(upgraded.videoTracks).toEqual([
		{ id: "main", name: "Main", order: 0 },
	]);
	expect(anyEditingDocumentSchema.parse(original)).toEqual(original);
	expect(anyEditingDocumentSchema.parse(upgraded)).toEqual(upgraded);
	expect(() => editingDocumentSchema.parse(upgraded)).toThrow();
	required(upgraded.clips[0]).audio.mode = "MUTE";
	expect(JSON.stringify(original)).toBe(before);
});

it("accepts explicit additional media, layered video, mixed audio and bounded plain overlays", () => {
	const d = toCompositionDocument(v1());
	d.sources = [{ mediaVersionId: caption, timeMapId: clip }];
	d.videoTracks?.push({ id: "broll", name: "B-roll", order: 1 });
	d.clips.push({
		...structuredClone(required(d.clips[0])),
		id: map,
		mediaVersionId: caption,
		trackId: "broll",
		layout: { x: 0.6, y: 0.05, w: 0.3, h: 0.3 },
		opacity: 0.75,
	});
	d.audioTracks = [
		{
			id: media,
			mediaVersionId: caption,
			sourceInUs: 0,
			timelineStartFrame: 0,
			durationFrames: 90,
			gainDb: -12,
			fadeInFrames: 3,
			fadeOutFrames: 3,
			ducking: {
				gainDb: -6,
				attackFrames: 2,
				releaseFrames: 4,
				intervals: [{ fromFrame: 20, toFrame: 40 }],
			},
		},
	];
	d.imageAssets = [{ id: clip }];
	d.overlays = [
		{
			id: media,
			kind: "IMAGE",
			assetId: clip,
			fromFrame: 0,
			toFrame: 90,
			rect: { x: 0, y: 0, w: 0.1, h: 0.1 },
			opacity: 1,
			zIndex: 2,
		},
	];
	expect(compositionDocumentSchema.parse(d)).toEqual(d);
});

it("requires explicit same-track crossfade overlap and rejects a third simultaneous clip", () => {
	const d = toCompositionDocument(v1());
	d.clips.push({
		...structuredClone(required(d.clips[0])),
		id: media,
		timelineStartFrame: 80,
		transitionIn: { type: "CROSSFADE", durationFrames: 10 },
	});
	expect(() => compositionDocumentSchema.parse(d)).not.toThrow();
	delete required(d.clips[1]).transitionIn;
	expect(() => compositionDocumentSchema.parse(d)).toThrow();
	required(d.clips[1]).transitionIn = { type: "CROSSFADE", durationFrames: 10 };
	d.clips.push({
		...structuredClone(required(d.clips[0])),
		id: map,
		timelineStartFrame: 85,
		transitionIn: { type: "CROSSFADE", durationFrames: 60 },
	});
	expect(() => compositionDocumentSchema.parse(d)).toThrow();
});

it("validates ordered local crop keyframes while FIT stays separately representable", () => {
	const d = toCompositionDocument(v1());
	required(d.clips[0]).cropKeyframes = [
		{ frame: 10, rect: { x: 0.1, y: 0, w: 0.3, h: 1 }, easing: "SMOOTH" },
		{ frame: 50, rect: { x: 0.5, y: 0, w: 0.3, h: 1 }, easing: "LINEAR" },
	];
	expect(() => compositionDocumentSchema.parse(d)).not.toThrow();
	required(required(d.clips[0]).cropKeyframes?.[1]).frame = 10;
	expect(() => compositionDocumentSchema.parse(d)).toThrow();
	required(required(d.clips[0]).cropKeyframes?.[1]).frame = 90;
	expect(() => compositionDocumentSchema.parse(d)).toThrow();
});

it("keeps actual word frame intervals and Japanese UTF-16 offsets exact", () => {
	const d = toCompositionDocument(v1());
	d.captions = [
		{
			id: caption,
			fromFrame: 0,
			toFrame: 60,
			text: "日本語を話す",
			words: [
				{
					text: "日本語",
					startChar: 0,
					endChar: 3,
					fromFrame: 0,
					toFrame: 25,
					confidence: 0.9,
				},
				{ text: "話す", startChar: 4, endChar: 6, fromFrame: 30, toFrame: 60 },
			],
		},
	];
	expect(() => compositionDocumentSchema.parse(d)).not.toThrow();
	required(required(required(d.captions[0]).words)[1]).fromFrame = 20;
	expect(() => compositionDocumentSchema.parse(d)).toThrow();
	required(d.captions[0]).words = undefined;
	expect(
		compositionDocumentSchema.parse(d).captions?.[0]?.words,
	).toBeUndefined();
});

it.each([
	{
		sources: Array.from({ length: 8 }, () => ({
			mediaVersionId: media,
			timeMapId: map,
		})),
	},
	{ clips: Array.from({ length: 21 }, () => v1().clips[0]) },
	{ captions: [{ id: caption, fromFrame: 0, toFrame: 5401, text: "x" }] },
	{
		overlays: [
			{
				id: caption,
				kind: "IMAGE",
				assetId: "https://untrusted/image.png",
				fromFrame: 0,
				toFrame: 10,
				rect: { x: 0, y: 0, w: 1, h: 1 },
				opacity: 1,
				zIndex: 0,
			},
		],
	},
	{ captionStyle: { color: "white;movie=https://untrusted" } },
	{
		videoTracks: [
			{ id: "main", name: "Main", order: 0 },
			{ id: "broll", name: "B", order: 0 },
		],
	},
])("rejects out-of-budget and undeclared executable fields %#", (invalid) => {
	expect(() =>
		compositionDocumentSchema.parse({
			...toCompositionDocument(v1()),
			...invalid,
		}),
	).toThrow();
});

it("rejects missing media and image declarations and invalid caption anchors", () => {
	const d = toCompositionDocument(v1());
	required(d.clips[0]).mediaVersionId = caption;
	expect(() => compositionDocumentSchema.parse(d)).toThrow();
	delete required(d.clips[0]).mediaVersionId;
	d.captions = [
		{
			id: caption,
			fromFrame: 0,
			toFrame: 30,
			text: "Caption",
			anchorClipId: caption,
		},
	];
	expect(() => compositionDocumentSchema.parse(d)).toThrow();
});

function required<T>(value: T | undefined): T {
	if (value === undefined) throw new Error("Missing test fixture");
	return value;
}
