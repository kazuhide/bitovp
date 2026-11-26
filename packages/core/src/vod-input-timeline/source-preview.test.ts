import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import * as timeline from "./index";

const documentId = "00000000-0000-4000-8000-000000000001";
const clipId = "00000000-0000-4000-8000-000000000002";
const probeId = "00000000-0000-4000-8000-000000000003";
const source: timeline.VodInputTimelineSourceFacts = {
	key: "unequal",
	durationMs: 4000,
	video: { streamIndex: 0, width: 1280, height: 720, durationMs: 4000 },
	audio: { streamIndex: 1, sampleRate: 48000, channels: 2, durationMs: 18000 },
	identity: { size: 100 },
};
const sourceDocument: timeline.VodInputTimelineV2Document = {
	schemaVersion: 2,
	id: documentId,
	audioEnabled: true,
	durationMs: 18000,
	videoClips: [
		{ id: clipId, sourceKey: source.key, startMs: 0, inMs: 0, outMs: 4000 },
	],
	audioClips: [
		{ id: clipId, sourceKey: source.key, startMs: 0, inMs: 0, outMs: 18000 },
	],
};
const request = () => ({
	kind: "PREVIEW" as const,
	probeId,
	document: structuredClone(sourceDocument),
	range: { startMs: 0, durationMs: 18000 },
	sourcePreviewKey: source.key,
});
const sha = (value: unknown) =>
	createHash("sha256").update(JSON.stringify(value)).digest("hex");

it("builds a fresh natural source audition with full unequal video and audio ranges", () => {
	const before = structuredClone(source);
	const built = timeline.buildVodInputSourcePreviewDocument(source, {
		documentId,
		clipId,
	});
	expect(built).toEqual(sourceDocument);
	expect(built).not.toBe(sourceDocument);
	expect(built.videoClips[0]).not.toBe(built.audioClips[0]);
	expect(source).toEqual(before);
	expect(
		timeline.resolveVodInputTimeline(built, {
			startMs: 15000,
			durationMs: 3000,
		}),
	).toMatchObject({
		durationMs: 3000,
		videoSegments: [{ kind: "gap", startMs: 0, durationMs: 3000 }],
		audioSegments: [{ kind: "source", inMs: 15000, outMs: 18000 }],
	});
});

it("uses each present stream duration or the primary duration fallback, with the maximum total", () => {
	const built = timeline.buildVodInputSourcePreviewDocument(
		{
			...source,
			durationMs: 20000,
			video: { streamIndex: 0, width: 1280, height: 720 },
		},
		{ documentId, clipId },
	);
	expect(built.durationMs).toBe(20000);
	expect(built.videoClips[0]?.outMs).toBe(20000);
	expect(built.audioClips[0]?.outMs).toBe(18000);
	const audioOnly = timeline.buildVodInputSourcePreviewDocument(
		{ ...source, video: null },
		{ documentId, clipId },
	);
	expect(audioOnly.videoClips).toEqual([]);
	expect(audioOnly.audioEnabled).toBe(true);
	const videoOnly = timeline.buildVodInputSourcePreviewDocument(
		{ ...source, audio: null },
		{ documentId, clipId },
	);
	expect(videoOnly.audioClips).toEqual([]);
	expect(videoOnly.audioEnabled).toBe(false);
});

it("allows an unedited 4s-video/18s-audio source audition while keeping ordinary timeline previews strict", () => {
	expect(timeline.validateVodInputPreview(request(), [source])).toEqual([]);
	const { sourcePreviewKey: _, ...normal } = request();
	expect(timeline.validateVodInputPreview(normal, [source])).toEqual(
		timeline.validateVodInputTimeline(sourceDocument, [source]),
	);
	expect(timeline.validateVodInputPreview(normal, [source])).toContainEqual(
		expect.objectContaining({
			code: "TIMELINE_GAP_TOO_LONG",
			track: "video",
			durationMs: 14000,
		}),
	);
});

it.each([
	[
		"foreign source key",
		(value: ReturnType<typeof request>) => {
			value.sourcePreviewKey = "foreign";
		},
	],
	[
		"trimmed video in",
		(value: ReturnType<typeof request>) => {
			const clip = value.document.videoClips[0];
			if (clip) clip.inMs = 1;
		},
	],
	[
		"trimmed audio out",
		(value: ReturnType<typeof request>) => {
			const clip = value.document.audioClips[0];
			if (clip) clip.outMs = 17000;
		},
	],
	[
		"changed total duration",
		(value: ReturnType<typeof request>) => {
			value.document.durationMs = 19000;
		},
	],
	[
		"missing natural audio",
		(value: ReturnType<typeof request>) => {
			value.document.audioClips = [];
		},
	],
	[
		"muted natural audio",
		(value: ReturnType<typeof request>) => {
			value.document.audioEnabled = false;
		},
	],
	[
		"shifted video",
		(value: ReturnType<typeof request>) => {
			const clip = value.document.videoClips[0];
			if (clip) clip.startMs = 1;
		},
	],
	[
		"invalid UUID",
		(value: ReturnType<typeof request>) => {
			value.document.id = "invalid";
		},
	],
] as const)("rejects a source exemption for %s", (_, mutate) => {
	const value = request();
	mutate(value);
	expect(timeline.validateVodInputPreview(value, [source])).toContainEqual({
		code: "SOURCE_PREVIEW_INVALID",
	});
});

it("retains source-range and gap errors when a changed source request tries to claim an exemption", () => {
	const value = request();
	const clip = value.document.videoClips[0];
	if (!clip) throw new Error("Fixture requires video");
	clip.outMs = 6000;
	expect(timeline.validateVodInputPreview(value, [source])).toEqual(
		expect.arrayContaining([
			{ code: "SOURCE_PREVIEW_INVALID" },
			expect.objectContaining({ code: "SOURCE_RANGE_INVALID", track: "video" }),
			expect.objectContaining({
				code: "TIMELINE_GAP_TOO_LONG",
				track: "video",
			}),
		]),
	);
	expect(timeline.validateVodInputPreview(request(), [])).toEqual(
		expect.arrayContaining([
			{ code: "SOURCE_PREVIEW_INVALID" },
			expect.objectContaining({ code: "SOURCE_NOT_READY" }),
		]),
	);
});

it("accepts arbitrary valid UUID identities, while requiring exactly the natural selected source", () => {
	const value = request();
	value.document.id = probeId;
	value.document.videoClips = value.document.videoClips.map((clip) => ({
		...clip,
		id: documentId,
	}));
	value.document.audioClips = value.document.audioClips.map((clip) => ({
		...clip,
		id: probeId,
	}));
	expect(timeline.validateVodInputPreview(value, [source])).toEqual([]);
	const extra = structuredClone(value);
	extra.document.videoClips.push({
		id: clipId,
		sourceKey: "other",
		startMs: 4000,
		inMs: 0,
		outMs: 1000,
	});
	expect(
		timeline.validateVodInputPreview(extra, [
			source,
			{ ...source, key: "other" },
		]),
	).toContainEqual({ code: "SOURCE_PREVIEW_INVALID" });
	const legacy = {
		...value,
		document: {
			schemaVersion: 1 as const,
			id: documentId,
			audioEnabled: true,
			clips: [{ id: clipId, sourceKey: source.key, inMs: 0, outMs: 4000 }],
		},
	};
	expect(timeline.validateVodInputPreview(legacy, [source])).toContainEqual({
		code: "SOURCE_PREVIEW_INVALID",
	});
});

it("preserves absent-field v1 and v2 JSON hashes and appends the optional source key after range", () => {
	for (const document of [
		{
			schemaVersion: 1 as const,
			id: documentId,
			audioEnabled: true,
			clips: [{ id: clipId, sourceKey: source.key, inMs: 0, outMs: 4000 }],
		},
		sourceDocument,
	]) {
		const original = {
			kind: "PREVIEW" as const,
			probeId,
			document,
			range: { startMs: 0, durationMs: 3000 },
		};
		const parsed = timeline.vodInputPreviewRequestSchema.parse(original);
		expect(JSON.stringify(parsed)).toBe(JSON.stringify(original));
		expect(sha(parsed)).toBe(sha(original));
		expect(Object.hasOwn(parsed, "sourcePreviewKey")).toBe(false);
	}
	const parsed = timeline.vodInputPreviewRequestSchema.parse(request());
	expect(Object.keys(parsed)).toEqual([
		"kind",
		"probeId",
		"document",
		"range",
		"sourcePreviewKey",
	]);
	expect(
		timeline.vodInputPreviewRequestSchema.safeParse({
			...request(),
			sourcePreviewKey: "../invalid",
		}).success,
	).toBe(false);
});
