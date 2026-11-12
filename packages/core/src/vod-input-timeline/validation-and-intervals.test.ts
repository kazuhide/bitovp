import { expect, it } from "vitest";
import { finish } from "./edit-support";
import {
	getVodInputTimelineLinkedPartner,
	locateVodInputTimelineTime,
	moveVodInputTimelineClip,
	normalizeVodInputTimelineDocument,
	overwriteVodInputTimelineTrack,
	resolveVodInputTimeline,
	type VodInputTimelineSourceFacts,
	validateVodInputPreview,
	validateVodInputTimeline,
	vodInputTimelineDocumentSchema,
	vodInputTimelineSourceFactsSchema,
} from "./index";

const id = (n: number) =>
	`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const clip = (
	n: number,
	sourceKey: string,
	startMs: number,
	inMs: number,
	outMs: number,
) => ({ id: id(n), sourceKey, startMs, inMs, outMs });
const facts: VodInputTimelineSourceFacts[] = ["a", "b", "sound"].map((key) => ({
	key,
	durationMs: 20_000,
	video: key === "sound" ? null : { streamIndex: 0, width: 1280, height: 720 },
	audio: { streamIndex: 1, sampleRate: 48000, channels: 2 },
	identity: { size: 100 },
}));
const program = {
	schemaVersion: 2 as const,
	id: id(1),
	audioEnabled: true,
	durationMs: 6000,
	videoClips: [
		clip(2, "a", 0, 0, 2000),
		clip(3, "b", 2000, 0, 2000),
		clip(4, "a", 4000, 4000, 6000),
	],
	audioClips: [clip(2, "a", 0, 0, 2000), clip(5, "sound", 2000, 0, 4000)],
};

it("splits an unpaired opposite clip at a linked reorder boundary without changing its source clock", () => {
	let n = 100;
	const result = moveVodInputTimelineClip(
		program,
		{ track: "video", id: id(2), toIndex: 1, linked: true },
		() => id(n++),
	);
	expect(
		result.videoClips.map((item) => [
			item.sourceKey,
			item.startMs,
			item.inMs,
			item.outMs,
		]),
	).toEqual([
		["b", 0, 0, 2000],
		["a", 2000, 0, 2000],
		["a", 4000, 4000, 6000],
	]);
	expect(
		result.audioClips.map((item) => [
			item.sourceKey,
			item.startMs,
			item.inMs,
			item.outMs,
		]),
	).toEqual([
		["sound", 0, 0, 2000],
		["a", 2000, 0, 2000],
		["sound", 4000, 2000, 4000],
	]);
	expect(locateVodInputTimelineTime(result, 5000, "audio")?.sourceMs).toBe(
		3000,
	);
	expect(
		getVodInputTimelineLinkedPartner(result, { track: "video", id: id(2) }),
	).toEqual(result.audioClips[1]);
	expect(new Set(result.audioClips.map((item) => item.id)).size).toBe(
		result.audioClips.length,
	);
});

it("does not mistake the same index or partial remnants for a linked partner", () => {
	const base = normalizeVodInputTimelineDocument({
		schemaVersion: 1,
		id: id(1),
		audioEnabled: true,
		clips: [{ id: id(2), sourceKey: "a", inMs: 0, outMs: 6000 }],
	});
	const edited = overwriteVodInputTimelineTrack(
		base,
		{
			track: "audio",
			atMs: 2000,
			sourceKey: "sound",
			inMs: 0,
			outMs: 2000,
			id: id(20),
			splitId: id(21),
		},
		facts,
	);
	expect(
		getVodInputTimelineLinkedPartner(edited, { track: "video", id: id(2) }),
	).toBeNull();
	expect(() =>
		moveVodInputTimelineClip(
			edited,
			{ track: "video", id: id(2), toIndex: 0, linked: true },
			() => id(30),
		),
	).toThrowError(expect.objectContaining({ code: "LINKED_PARTNER_MISSING" }));
});

it.each([
	"leading",
	"internal",
	"trailing",
] as const)("enforces per-sequence native padding limits for %s gaps", (position) => {
	function fixture(gap: number, track: "video" | "audio") {
		const clips =
			position === "leading"
				? [clip(2, "a", gap, 0, 1000)]
				: position === "trailing"
					? [clip(2, "a", 0, 0, 1000)]
					: [clip(2, "a", 0, 0, 1000), clip(3, "b", 1000 + gap, 0, 1000)];
		return {
			schemaVersion: 2 as const,
			id: id(1),
			audioEnabled: track === "audio",
			durationMs: gap + (position === "internal" ? 2000 : 1000),
			videoClips: track === "video" ? clips : [],
			audioClips: track === "audio" ? clips : [],
		};
	}
	const limit = position === "internal" ? 20_000 : 10_000;
	for (const track of ["video", "audio"] as const) {
		for (const gap of position === "internal"
			? [10_000, 10_001, 11_658, 20_000]
			: [10_000]) {
			const document = fixture(gap, track);
			expect(validateVodInputTimeline(document, facts)).toEqual([]);
			expect(finish(document)).toBe(document);
			if (position === "internal")
				expect(
					validateVodInputPreview(
						{
							kind: "PREVIEW",
							probeId: id(90),
							document,
							range: { startMs: 1000, durationMs: gap },
						},
						facts,
					),
				).toEqual([]);
		}
		const invalid = fixture(limit + 1, track);
		expect(validateVodInputTimeline(invalid, facts)).toContainEqual(
			expect.objectContaining({
				code: "TIMELINE_GAP_TOO_LONG",
				track,
				durationMs: limit + 1,
			}),
		);
		expect(() => finish(invalid)).toThrowError(
			expect.objectContaining({ code: "TIMELINE_GAP_TOO_LONG" }),
		);
	}
});

it("does not impose native gap padding on a wholly empty track, and distinguishes source audition from a video-output project", () => {
	const audioOnly = {
		schemaVersion: 2 as const,
		id: id(1),
		audioEnabled: true,
		durationMs: 20_000,
		videoClips: [],
		audioClips: [clip(2, "sound", 0, 0, 20_000)],
	};
	expect(validateVodInputTimeline(audioOnly, facts)).toEqual([]);
	expect(
		validateVodInputTimeline(audioOnly, facts, { requireVideo: true }),
	).toEqual([{ code: "TIMELINE_VIDEO_MISSING" }]);
	expect(resolveVodInputTimeline(audioOnly).mainVideoSourceKey).toBeNull();
	expect(resolveVodInputTimeline(audioOnly).videoSegments).toEqual([
		{ kind: "gap", startMs: 0, durationMs: 20_000 },
	]);
	const videoOnly = {
		...audioOnly,
		videoClips: [clip(2, "a", 0, 0, 20_000)],
		audioClips: [],
	};
	expect(validateVodInputTimeline(videoOnly, facts)).toEqual([]);
	expect(resolveVodInputTimeline(videoOnly).hasAudio).toBe(false);
	const disabledAudio = {
		...videoOnly,
		audioEnabled: false,
		durationMs: 40_000,
		videoClips: [clip(2, "a", 0, 0, 20_000), clip(3, "b", 20_000, 0, 20_000)],
		audioClips: [clip(4, "a", 0, 0, 1000), clip(5, "sound", 30_000, 0, 1000)],
	};
	expect(validateVodInputTimeline(disabledAudio, facts)).toEqual([]);
	expect(finish(disabledAudio)).toBe(disabledAudio);
	expect(resolveVodInputTimeline(disabledAudio).audioSegments).toEqual([]);
});

it("uses per-stream duration to reject audio beyond its real end and rejects metadata with no real media", () => {
	const base = { ...program, audioClips: [] };
	expect(() =>
		overwriteVodInputTimelineTrack(
			base,
			{
				track: "audio",
				atMs: 0,
				sourceKey: "a",
				inMs: 0,
				outMs: 5000,
				id: id(20),
				splitId: id(21),
			},
			facts.map((fact) =>
				fact.key === "a" && fact.audio
					? { ...fact, audio: { ...fact.audio, durationMs: 4000 } }
					: fact,
			),
		),
	).toThrowError(expect.objectContaining({ code: "SOURCE_TOO_SHORT" }));
	expect(
		vodInputTimelineSourceFactsSchema.safeParse({
			...facts[0],
			video: null,
			audio: null,
		}).success,
	).toBe(false);
});

it("rejects duplicate split IDs and atomic overwrite overflow instead of changing the original document", () => {
	const base = normalizeVodInputTimelineDocument({
		schemaVersion: 1,
		id: id(1),
		audioEnabled: true,
		clips: [{ id: id(2), sourceKey: "a", inMs: 0, outMs: 6000 }],
	});
	expect(() =>
		overwriteVodInputTimelineTrack(
			base,
			{
				track: "audio",
				atMs: 2000,
				sourceKey: "b",
				inMs: 0,
				outMs: 2000,
				id: id(20),
				splitId: id(20),
			},
			facts,
		),
	).toThrowError(expect.objectContaining({ code: "TIMELINE_ID_CONFLICT" }));
	const many = {
		...base,
		durationMs: 6400,
		videoClips: Array.from({ length: 64 }, (_, index) =>
			clip(index + 10, "a", index * 100, 0, 100),
		),
		audioClips: [],
	};
	const snapshot = structuredClone(many);
	expect(() =>
		overwriteVodInputTimelineTrack(
			many,
			{
				track: "video",
				atMs: 20,
				sourceKey: "b",
				inMs: 0,
				outMs: 60,
				id: id(90),
				splitId: id(91),
			},
			facts,
		),
	).toThrowError(expect.objectContaining({ code: "TIMELINE_LIMIT_EXCEEDED" }));
	expect(many).toEqual(snapshot);
});

it("limits unique source references to the sixteen-source admission bound", () => {
	const document = {
		...program,
		durationMs: 1700,
		audioClips: [],
		videoClips: Array.from({ length: 17 }, (_, index) =>
			clip(index + 10, `source_${index}`, index * 100, 0, 100),
		),
	};
	expect(vodInputTimelineDocumentSchema.safeParse(document).success).toBe(
		false,
	);
});
