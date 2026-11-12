import type {
	VodInputTimelineDocument,
	VodInputTimelinePlacedClip,
	VodInputTimelineSourceFacts,
	VodInputTimelineTrack,
	VodInputTimelineV2Document,
} from "./contracts";
import {
	clipEnd,
	fail,
	finish,
	overwriteClips,
	permuteClips,
	splitIds,
	type TimePiece,
	trackKey,
	type VodInputTimelineNextId,
	type VodInputTimelineSelection,
} from "./edit-support";
import {
	getVodInputTimelineSourceDurationMs,
	getVodInputTimelineTrack,
	locateVodInputTimelineTime,
	normalizeVodInputTimelineDocument,
} from "./model";

export {
	VodInputTimelineEditError,
	type VodInputTimelineEditErrorCode,
	type VodInputTimelineNextId,
	type VodInputTimelineSelection,
} from "./edit-support";

function selected(
	document: VodInputTimelineV2Document,
	selection: VodInputTimelineSelection,
) {
	const clip = getVodInputTimelineTrack(document, selection.track).find(
		(item) => item.id === selection.id,
	);
	return clip ?? fail("CLIP_NOT_FOUND");
}
export function getVodInputTimelineLinkedPartner(
	input: VodInputTimelineDocument,
	selection: { track: VodInputTimelineTrack; id: string },
): VodInputTimelinePlacedClip | null {
	const document = normalizeVodInputTimelineDocument(input),
		clip = getVodInputTimelineTrack(document, selection.track).find(
			(item) => item.id === selection.id,
		);
	if (!clip) return null;
	return (
		getVodInputTimelineTrack(
			document,
			selection.track === "video" ? "audio" : "video",
		).find(
			(other) =>
				other.id === clip.id &&
				other.sourceKey === clip.sourceKey &&
				other.startMs === clip.startMs &&
				other.inMs === clip.inMs &&
				other.outMs === clip.outMs,
		) ?? null
	);
}
function affected(
	document: VodInputTimelineV2Document,
	selection: VodInputTimelineSelection,
): VodInputTimelineTrack[] {
	if (!selection.linked) return [selection.track];
	if (!getVodInputTimelineLinkedPartner(document, selection))
		fail("LINKED_PARTNER_MISSING");
	return ["video", "audio"];
}
function sourceRange(
	facts: readonly VodInputTimelineSourceFacts[],
	track: VodInputTimelineTrack,
	sourceKey: string,
	inMs: number,
	outMs: number,
) {
	if (![inMs, outMs].every(Number.isSafeInteger) || inMs < 0 || outMs <= inMs)
		fail("SOURCE_RANGE_INVALID");
	const source =
		facts.find((item) => item.key === sourceKey) ?? fail("SOURCE_NOT_READY");
	if (!source[track])
		fail(track === "video" ? "SOURCE_VIDEO_MISSING" : "SOURCE_AUDIO_MISSING");
	if (outMs > getVodInputTimelineSourceDurationMs(source, track))
		fail("SOURCE_TOO_SHORT");
}
export function overwriteVodInputTimelineTrack(
	input: VodInputTimelineDocument,
	edit: {
		track: VodInputTimelineTrack;
		atMs: number;
		sourceKey: string;
		inMs: number;
		outMs: number;
		id: string;
		splitId: string;
	},
	facts: readonly VodInputTimelineSourceFacts[],
): VodInputTimelineV2Document {
	const document = normalizeVodInputTimelineDocument(input);
	sourceRange(facts, edit.track, edit.sourceKey, edit.inMs, edit.outMs);
	const endMs = edit.atMs + edit.outMs - edit.inMs;
	if (
		!Number.isSafeInteger(edit.atMs) ||
		edit.atMs < 0 ||
		endMs > document.durationMs
	)
		fail("TIMELINE_RANGE_INVALID");
	const clip = {
		id: edit.id,
		sourceKey: edit.sourceKey,
		startMs: edit.atMs,
		inMs: edit.inMs,
		outMs: edit.outMs,
	};
	return finish({
		...document,
		[trackKey(edit.track)]: overwriteClips(
			getVodInputTimelineTrack(document, edit.track),
			edit.atMs,
			endMs,
			clip,
			() => edit.splitId,
		),
	});
}
export function appendVodInputTimelineSource(
	input: VodInputTimelineDocument,
	edit: {
		target: "both" | VodInputTimelineTrack;
		sourceKey: string;
		inMs: number;
		outMs: number;
		id: string;
	},
	facts: readonly VodInputTimelineSourceFacts[],
): VodInputTimelineV2Document {
	const document = normalizeVodInputTimelineDocument(input);
	const tracks: VodInputTimelineTrack[] =
		edit.target === "both" ? ["video", "audio"] : [edit.target];
	for (const track of tracks)
		if (track !== "audio" || document.audioEnabled || edit.target === "audio")
			sourceRange(facts, track, edit.sourceKey, edit.inMs, edit.outMs);
	const clips =
		edit.target === "both"
			? []
			: getVodInputTimelineTrack(document, edit.target);
	const lastClip = clips.at(-1);
	const startMs =
		edit.target === "both"
			? document.durationMs
			: lastClip
				? clipEnd(lastClip)
				: 0;
	const result = {
		...document,
		durationMs: Math.max(document.durationMs, startMs + edit.outMs - edit.inMs),
	};
	for (const track of tracks)
		result[trackKey(track)] = [
			...getVodInputTimelineTrack(document, track),
			{
				id: edit.id,
				sourceKey: edit.sourceKey,
				startMs,
				inMs: edit.inMs,
				outMs: edit.outMs,
			},
		];
	return finish(result);
}
export function splitVodInputTimelineAt(
	input: VodInputTimelineDocument,
	edit: {
		track: VodInputTimelineTrack;
		positionMs: number;
		id: string;
		linked?: boolean;
	},
): VodInputTimelineV2Document {
	const document = normalizeVodInputTimelineDocument(input);
	if (
		!Number.isSafeInteger(edit.positionMs) ||
		edit.positionMs < 0 ||
		edit.positionMs > document.durationMs
	)
		fail("TIMELINE_RANGE_INVALID");
	const point = locateVodInputTimelineTime(
		document,
		edit.positionMs,
		edit.track,
	);
	if (!point || edit.positionMs === point.clip.startMs) return document;
	const selection = {
		track: edit.track,
		id: point.clip.id,
		linked: edit.linked,
	};
	const result = { ...document };
	for (const track of affected(document, selection))
		result[trackKey(track)] = getVodInputTimelineTrack(document, track).flatMap(
			(clip) =>
				clip.id === point.clip.id
					? [
							{ ...clip, outMs: point.sourceMs },
							{
								...clip,
								id: edit.id,
								startMs: edit.positionMs,
								inMs: point.sourceMs,
							},
						]
					: [clip],
		);
	return finish(result);
}
export function trimVodInputTimelineClip(
	input: VodInputTimelineDocument,
	edit: VodInputTimelineSelection & { inMs: number; outMs: number },
	facts: readonly VodInputTimelineSourceFacts[],
	nextId: VodInputTimelineNextId,
): VodInputTimelineV2Document {
	const document = normalizeVodInputTimelineDocument(input),
		clip = selected(document, edit),
		tracks = affected(document, edit);
	for (const track of tracks)
		if (track !== "audio" || document.audioEnabled || !edit.linked)
			sourceRange(facts, track, clip.sourceKey, edit.inMs, edit.outMs);
	if (edit.linked) {
		const delta = edit.outMs - edit.inMs - (clip.outMs - clip.inMs),
			oldEnd = clipEnd(clip);
		const result = { ...document, durationMs: document.durationMs + delta };
		for (const track of tracks)
			result[trackKey(track)] = getVodInputTimelineTrack(document, track).map(
				(item) =>
					item.id === clip.id
						? { ...item, inMs: edit.inMs, outMs: edit.outMs }
						: item.startMs >= oldEnd
							? { ...item, startMs: item.startMs + delta }
							: item,
			);
		return finish(result);
	}
	const startMs = clip.startMs + edit.inMs - clip.inMs;
	if (startMs < 0 || startMs + edit.outMs - edit.inMs > document.durationMs)
		fail("TIMELINE_RANGE_INVALID");
	const remaining = getVodInputTimelineTrack(document, edit.track).filter(
		(item) => item.id !== clip.id,
	);
	return finish({
		...document,
		[trackKey(edit.track)]: overwriteClips(
			remaining,
			startMs,
			startMs + edit.outMs - edit.inMs,
			{ ...clip, startMs, inMs: edit.inMs, outMs: edit.outMs },
			nextId,
		),
	});
}
export function deleteVodInputTimelineClip(
	input: VodInputTimelineDocument,
	edit: VodInputTimelineSelection,
	nextId: VodInputTimelineNextId,
): VodInputTimelineV2Document {
	const document = normalizeVodInputTimelineDocument(input),
		clip = selected(document, edit),
		tracks = affected(document, edit);
	const result = { ...document };
	if (!edit.linked)
		result[trackKey(edit.track)] = getVodInputTimelineTrack(
			document,
			edit.track,
		).filter((item) => item.id !== clip.id);
	else {
		const endMs = clipEnd(clip),
			length = clip.outMs - clip.inMs;
		const pieces: TimePiece[] = [
			{ startMs: 0, endMs: clip.startMs, offsetMs: 0 },
			{ startMs: endMs, endMs: document.durationMs, offsetMs: -length },
		];
		const allocate = splitIds(nextId);
		for (const track of tracks)
			result[trackKey(track)] = permuteClips(
				getVodInputTimelineTrack(document, track),
				pieces,
				allocate,
			);
		result.durationMs -= length;
	}
	return finish(result);
}
export function moveVodInputTimelineClip(
	input: VodInputTimelineDocument,
	edit: VodInputTimelineSelection & { toIndex: number },
	nextId: VodInputTimelineNextId,
): VodInputTimelineV2Document {
	const document = normalizeVodInputTimelineDocument(input),
		clip = selected(document, edit);
	if (!Number.isSafeInteger(edit.toIndex)) fail("TIMELINE_RANGE_INVALID");
	const tracks = affected(document, edit),
		clips = getVodInputTimelineTrack(document, edit.track);
	const from = clips.findIndex((item) => item.id === edit.id),
		to = Math.max(0, Math.min(clips.length - 1, edit.toIndex));
	if (from === to) return document;
	const target = clips[to] ?? fail("CLIP_NOT_FOUND"),
		startMs = clip.startMs,
		endMs = clipEnd(clip),
		length = clip.outMs - clip.inMs;
	const boundary = from < to ? clipEnd(target) : target.startMs;
	const pieces: TimePiece[] =
		from < to
			? [
					{ startMs: 0, endMs: startMs, offsetMs: 0 },
					{ startMs, endMs, offsetMs: boundary - length - startMs },
					{ startMs: endMs, endMs: boundary, offsetMs: -length },
					{ startMs: boundary, endMs: document.durationMs, offsetMs: 0 },
				]
			: [
					{ startMs: 0, endMs: boundary, offsetMs: 0 },
					{ startMs: boundary, endMs: startMs, offsetMs: length },
					{ startMs, endMs, offsetMs: boundary - startMs },
					{ startMs: endMs, endMs: document.durationMs, offsetMs: 0 },
				];
	const result = { ...document },
		allocate = splitIds(nextId);
	for (const track of tracks)
		result[trackKey(track)] = permuteClips(
			getVodInputTimelineTrack(document, track),
			pieces,
			allocate,
		);
	return finish(result);
}
