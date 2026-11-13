import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import * as timeline from "./index";

const id = (value: number) =>
	`00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const nextIds = () => {
	let value = 100;
	return () => id(value++);
};
const legacy = {
	schemaVersion: 1 as const,
	id: id(1),
	audioEnabled: true,
	clips: [{ id: id(2), sourceKey: "a", inMs: 0, outMs: 10_000 }],
};
const facts: timeline.VodInputTimelineSourceFacts[] = ["a", "b", "sound"].map(
	(key) => ({
		key,
		durationMs: 20_000,
		video:
			key === "sound" ? null : { streamIndex: 0, width: 1920, height: 1080 },
		audio: { streamIndex: 1, sampleRate: 48000, channels: 2 },
		identity: { size: 100, etag: '"fixed"' },
	}),
);
const overwrite = (track: "video" | "audio") => ({
	track,
	atMs: 2000,
	sourceKey: "b",
	inMs: 1000,
	outMs: 4000,
	id: id(20),
	splitId: id(21),
});

describe("independent VOD input tracks", () => {
	it("keeps legacy wire serialization and its queued request hash unchanged", () => {
		const request = {
			kind: "PREVIEW",
			probeId: id(3),
			document: legacy,
			range: { startMs: 0, durationMs: 5000 },
		};
		const before = JSON.stringify(request);
		const parsed = timeline.vodInputPreviewRequestSchema.parse(request);
		expect(JSON.stringify(parsed)).toBe(before);
		expect(
			createHash("sha256").update(JSON.stringify(parsed)).digest("hex"),
		).toBe(createHash("sha256").update(before).digest("hex"));
		expect(parsed.kind === "PREVIEW" && parsed.document.schemaVersion).toBe(1);
	});
	it("normalizes muted legacy audio without discarding its re-enableable material", () => {
		const result = timeline.normalizeVodInputTimelineDocument({
			...legacy,
			audioEnabled: false,
		});
		expect(result.schemaVersion).toBe(2);
		expect(result.durationMs).toBe(10_000);
		expect(result.audioEnabled).toBe(false);
		expect(result.audioClips).toEqual(result.videoClips);
		expect(result.audioClips).not.toBe(result.videoClips);
		expect(
			timeline.validateVodInputTimeline(
				result,
				facts.map((fact) => ({ ...fact, audio: null })),
			),
		).toEqual([]);
	});
	it.each([
		"audio",
		"video",
	] as const)("overwrites the middle of only %s and preserves opposite media, outside source time and duration", (track) => {
		const base = timeline.normalizeVodInputTimelineDocument(legacy);
		const snapshot = structuredClone(base);
		const result = timeline.overwriteVodInputTimelineTrack(
			base,
			overwrite(track),
			facts,
		);
		const other = track === "video" ? "audio" : "video";
		expect(timeline.getVodInputTimelineTrack(result, other)).toEqual(
			timeline.getVodInputTimelineTrack(base, other),
		);
		expect(result.durationMs).toBe(10_000);
		expect(
			timeline
				.getVodInputTimelineTrack(result, track)
				.map((clip) => [clip.startMs, clip.sourceKey, clip.inMs, clip.outMs]),
		).toEqual([
			[0, "a", 0, 2000],
			[2000, "b", 1000, 4000],
			[5000, "a", 5000, 10_000],
		]);
		expect(base).toEqual(snapshot);
	});
	it("resolves each track separately, includes gaps, and retains the whole-program video main outside the window", () => {
		const document = {
			schemaVersion: 2 as const,
			id: id(1),
			audioEnabled: true,
			durationMs: 5000,
			videoClips: [
				{ id: id(2), sourceKey: "a", startMs: 1000, inMs: 0, outMs: 1000 },
			],
			audioClips: [
				{
					id: id(3),
					sourceKey: "sound",
					startMs: 2500,
					inMs: 500,
					outMs: 1500,
				},
			],
		};
		const result = timeline.resolveVodInputTimeline(document, {
			startMs: 2000,
			durationMs: 4000,
		});
		expect(result.durationMs).toBe(3000);
		expect(result.mainVideoSourceKey).toBe("a");
		expect(result.hasAudio).toBe(true);
		expect(result.videoSegments).toEqual([
			{ kind: "gap", startMs: 0, durationMs: 3000 },
		]);
		expect(result.audioSegments).toEqual([
			{ kind: "gap", startMs: 0, durationMs: 500 },
			{
				kind: "source",
				id: id(3),
				sourceKey: "sound",
				startMs: 500,
				inMs: 500,
				outMs: 1500,
				durationMs: 1000,
			},
			{ kind: "gap", startMs: 1500, durationMs: 1500 },
		]);
	});
	it("requires the capability of the selected medium and refuses source shortage or end overrun", () => {
		const base = timeline.normalizeVodInputTimelineDocument(legacy);
		expect(() =>
			timeline.overwriteVodInputTimelineTrack(
				base,
				{ ...overwrite("video"), sourceKey: "sound" },
				facts,
			),
		).toThrowError(expect.objectContaining({ code: "SOURCE_VIDEO_MISSING" }));
		expect(() =>
			timeline.overwriteVodInputTimelineTrack(
				base,
				{ ...overwrite("audio"), inMs: 19_000, outMs: 22_000 },
				facts,
			),
		).toThrowError(expect.objectContaining({ code: "SOURCE_TOO_SHORT" }));
		expect(() =>
			timeline.overwriteVodInputTimelineTrack(
				base,
				{ ...overwrite("audio"), atMs: 9000 },
				facts,
			),
		).toThrowError(expect.objectContaining({ code: "TIMELINE_RANGE_INVALID" }));
	});
	it("splits only the chosen track, but linked splits retain exact AV pairs", () => {
		const base = timeline.normalizeVodInputTimelineDocument(legacy);
		const independent = timeline.splitVodInputTimelineAt(base, {
			track: "audio",
			positionMs: 3000,
			id: id(20),
		});
		expect(independent.videoClips).toEqual(base.videoClips);
		expect(independent.audioClips).toHaveLength(2);
		expect(independent.audioClips[1]).toMatchObject({
			startMs: 3000,
			inMs: 3000,
			outMs: 10_000,
		});
		const linked = timeline.splitVodInputTimelineAt(base, {
			track: "video",
			positionMs: 3000,
			id: id(20),
			linked: true,
		});
		expect(linked.videoClips).toEqual(linked.audioClips);
		expect(
			timeline.getVodInputTimelineLinkedPartner(linked, {
				track: "audio",
				id: id(20),
			}),
		).toEqual(linked.videoClips[1]);
	});
	it("makes independent trim non-ripple, leaves a gap, and overwrites only same-track neighbors on extension", () => {
		const base = timeline.normalizeVodInputTimelineDocument(legacy);
		const trimmed = timeline.trimVodInputTimelineClip(
			base,
			{ track: "audio", id: id(2), inMs: 2000, outMs: 8000 },
			facts,
			nextIds(),
		);
		expect(trimmed.videoClips).toEqual(base.videoClips);
		expect(trimmed.durationMs).toBe(10_000);
		expect(trimmed.audioClips[0]).toMatchObject({
			startMs: 2000,
			inMs: 2000,
			outMs: 8000,
		});
		const overwritten = timeline.overwriteVodInputTimelineTrack(
			base,
			overwrite("audio"),
			facts,
		);
		const extended = timeline.trimVodInputTimelineClip(
			overwritten,
			{ track: "audio", id: id(20), inMs: 0, outMs: 5000 },
			facts,
			nextIds(),
		);
		expect(extended.videoClips).toEqual(base.videoClips);
		expect(
			extended.audioClips.map((clip) => [clip.startMs, clip.inMs, clip.outMs]),
		).toEqual([
			[0, 0, 1000],
			[1000, 0, 5000],
			[6000, 6000, 10_000],
		]);
	});
	it("linked trim and delete ripple both tracks while independent deletion preserves duration and opposite media", () => {
		const base = timeline.appendVodInputTimelineSource(
			legacy,
			{ target: "both", sourceKey: "b", inMs: 0, outMs: 4000, id: id(3) },
			facts,
		);
		const trimmed = timeline.trimVodInputTimelineClip(
			base,
			{ track: "video", id: id(2), inMs: 0, outMs: 8000, linked: true },
			facts,
			nextIds(),
		);
		expect(trimmed.durationMs).toBe(12_000);
		expect(trimmed.videoClips).toEqual(trimmed.audioClips);
		expect(trimmed.videoClips[1]?.startMs).toBe(8000);
		const deleted = timeline.deleteVodInputTimelineClip(
			base,
			{ track: "audio", id: id(2), linked: true },
			nextIds(),
		);
		expect(deleted.durationMs).toBe(4000);
		expect(deleted.videoClips).toEqual(deleted.audioClips);
		expect(deleted.videoClips[0]?.startMs).toBe(0);
		const independent = timeline.deleteVodInputTimelineClip(
			base,
			{ track: "audio", id: id(2) },
			nextIds(),
		);
		expect(independent.durationMs).toBe(base.durationMs);
		expect(independent.videoClips).toEqual(base.videoClips);
		expect(independent.audioClips[0]?.startMs).toBe(10_000);
	});
	it("reorders a time interval on one track without moving opposite media or losing gap duration", () => {
		const base = {
			schemaVersion: 2 as const,
			id: id(1),
			audioEnabled: true,
			durationMs: 8000,
			videoClips: [
				{ id: id(2), sourceKey: "a", startMs: 0, inMs: 0, outMs: 2000 },
				{ id: id(3), sourceKey: "b", startMs: 4000, inMs: 0, outMs: 2000 },
			],
			audioClips: [
				{ id: id(4), sourceKey: "sound", startMs: 0, inMs: 0, outMs: 8000 },
			],
		};
		const result = timeline.moveVodInputTimelineClip(
			base,
			{ track: "video", id: id(2), toIndex: 1 },
			nextIds(),
		);
		expect(
			result.videoClips.map((clip) => [clip.sourceKey, clip.startMs]),
		).toEqual([
			["b", 2000],
			["a", 4000],
		]);
		expect(result.audioClips).toEqual(base.audioClips);
		expect(result.durationMs).toBe(8000);
	});
	it("appends a single medium at its own end and both media at the program end", () => {
		const base = timeline.normalizeVodInputTimelineDocument(legacy);
		base.audioClips = base.audioClips.map((clip, index) =>
			index === 0 ? { ...clip, outMs: 4000 } : clip,
		);
		const one = timeline.appendVodInputTimelineSource(
			base,
			{ target: "audio", sourceKey: "sound", inMs: 0, outMs: 2000, id: id(3) },
			facts,
		);
		expect(one.audioClips[1]?.startMs).toBe(4000);
		expect(one.durationMs).toBe(10_000);
		expect(one.videoClips).toEqual(base.videoClips);
		const both = timeline.appendVodInputTimelineSource(
			base,
			{ target: "both", sourceKey: "b", inMs: 0, outMs: 2000, id: id(3) },
			facts,
		);
		expect(both.durationMs).toBe(12_000);
		expect(both.videoClips[1]?.startMs).toBe(10_000);
		expect(both.audioClips[1]?.startMs).toBe(10_000);
	});
	it("rejects overlapping tracks, duplicate track IDs and excess clips, while allowing the same paired ID across tracks", () => {
		const base = timeline.normalizeVodInputTimelineDocument(legacy);
		expect(
			timeline.vodInputTimelineDocumentSchema.safeParse(base).success,
		).toBe(true);
		expect(
			timeline.vodInputTimelineDocumentSchema.safeParse({
				...base,
				videoClips: [
					...base.videoClips,
					{ ...base.videoClips[0], id: id(3), startMs: 1000 },
				],
			}).success,
		).toBe(false);
		const many = {
			...base,
			videoClips: Array.from({ length: 64 }, (_, index) => ({
				id: id(index + 10),
				sourceKey: "a",
				startMs: index,
				inMs: 0,
				outMs: 1,
			})),
		};
		expect(() =>
			timeline.appendVodInputTimelineSource(
				many,
				{ target: "video", sourceKey: "a", inMs: 0, outMs: 1, id: id(90) },
				facts,
			),
		).toThrowError(
			expect.objectContaining({ code: "TIMELINE_LIMIT_EXCEEDED" }),
		);
	});
});
