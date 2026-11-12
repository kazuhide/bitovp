import {
	MAX_VOD_TIMELINE_CLIPS,
	MAX_VOD_TIMELINE_DURATION_MS,
	MAX_VOD_TIMELINE_SOURCES,
	type VodInputTimelinePlacedClip,
	type VodInputTimelineTrack,
	type VodInputTimelineV2Document,
	vodInputTimelineV2DocumentSchema,
} from "./contracts";
import {
	isVodInputTimelineGapSupported,
	resolveVodInputTimeline,
} from "./model";

export type VodInputTimelineEditErrorCode =
	| "CLIP_NOT_FOUND"
	| "LINKED_PARTNER_MISSING"
	| "SOURCE_NOT_READY"
	| "SOURCE_RANGE_INVALID"
	| "SOURCE_TOO_SHORT"
	| "SOURCE_VIDEO_MISSING"
	| "SOURCE_AUDIO_MISSING"
	| "TIMELINE_RANGE_INVALID"
	| "TIMELINE_LIMIT_EXCEEDED"
	| "TIMELINE_ID_CONFLICT"
	| "TIMELINE_GAP_TOO_LONG";
export class VodInputTimelineEditError extends Error {
	constructor(public readonly code: VodInputTimelineEditErrorCode) {
		super(code);
		this.name = "VodInputTimelineEditError";
	}
}
export type VodInputTimelineNextId = () => string;
export type VodInputTimelineSelection = {
	track: VodInputTimelineTrack;
	id: string;
	linked?: boolean;
};
export const trackKey = (track: VodInputTimelineTrack) =>
	track === "video" ? "videoClips" : "audioClips";
export const clipEnd = (clip: VodInputTimelinePlacedClip) =>
	clip.startMs + clip.outMs - clip.inMs;
export const fail = (code: VodInputTimelineEditErrorCode): never => {
	throw new VodInputTimelineEditError(code);
};

export function finish(
	document: VodInputTimelineV2Document,
): VodInputTimelineV2Document {
	if (
		document.durationMs > MAX_VOD_TIMELINE_DURATION_MS ||
		document.videoClips.length > MAX_VOD_TIMELINE_CLIPS ||
		document.audioClips.length > MAX_VOD_TIMELINE_CLIPS
	)
		fail("TIMELINE_LIMIT_EXCEEDED");
	if (
		new Set(
			[...document.videoClips, ...document.audioClips].map(
				(clip) => clip.sourceKey,
			),
		).size > MAX_VOD_TIMELINE_SOURCES
	)
		fail("TIMELINE_LIMIT_EXCEEDED");
	for (const clips of [document.videoClips, document.audioClips])
		if (new Set(clips.map((clip) => clip.id)).size !== clips.length)
			fail("TIMELINE_ID_CONFLICT");
	if (!vodInputTimelineV2DocumentSchema.safeParse(document).success)
		fail("TIMELINE_RANGE_INVALID");
	const resolved = resolveVodInputTimeline(document);
	for (const [clips, segments] of [
		[document.videoClips, resolved.videoSegments],
		[document.audioEnabled ? document.audioClips : [], resolved.audioSegments],
	] as const) {
		if (
			clips.length &&
			segments.some(
				(segment) =>
					segment.kind === "gap" &&
					!isVodInputTimelineGapSupported(segment, document.durationMs),
			)
		)
			fail("TIMELINE_GAP_TOO_LONG");
	}
	return document;
}

/** Clear a time interval; retain each surviving piece's original source clock. */
export function overwriteClips(
	clips: VodInputTimelinePlacedClip[],
	startMs: number,
	endMs: number,
	inserted: VodInputTimelinePlacedClip | null,
	nextId: VodInputTimelineNextId,
) {
	const result: VodInputTimelinePlacedClip[] = [];
	for (const clip of clips) {
		const end = clipEnd(clip);
		if (end <= startMs || clip.startMs >= endMs) {
			result.push(clip);
			continue;
		}
		const left = clip.startMs < startMs;
		if (left)
			result.push({ ...clip, outMs: clip.inMs + startMs - clip.startMs });
		if (end > endMs)
			result.push({
				...clip,
				id: left ? nextId() : clip.id,
				startMs: endMs,
				inMs: clip.inMs + endMs - clip.startMs,
			});
	}
	if (inserted) result.push(inserted);
	return result.sort((a, b) => a.startMs - b.startMs);
}

/** Share split IDs only for identical original AV clips and source fragments. */
export function splitIds(nextId: VodInputTimelineNextId) {
	const assigned = new Map<string, string>();
	return (clip: VodInputTimelinePlacedClip, start: number, end: number) => {
		const key = [
			clip.id,
			clip.sourceKey,
			clip.startMs,
			clip.inMs,
			clip.outMs,
			start,
			end,
		].join(":");
		const existing = assigned.get(key);
		if (existing) return existing;
		const id = nextId();
		assigned.set(key, id);
		return id;
	};
}

export type TimePiece = { startMs: number; endMs: number; offsetMs: number };
export function permuteClips(
	clips: VodInputTimelinePlacedClip[],
	pieces: TimePiece[],
	allocate: ReturnType<typeof splitIds>,
) {
	return clips
		.flatMap((clip) => {
			let first = true;
			return pieces.flatMap((piece) => {
				const start = Math.max(clip.startMs, piece.startMs),
					end = Math.min(clipEnd(clip), piece.endMs);
				if (end <= start) return [];
				const id = first ? clip.id : allocate(clip, start, end);
				first = false;
				return [
					{
						...clip,
						id,
						startMs: start + piece.offsetMs,
						inMs: clip.inMs + start - clip.startMs,
						outMs: clip.inMs + end - clip.startMs,
					},
				];
			});
		})
		.sort((a, b) => a.startMs - b.startMs);
}
