import {
	appendVodInputTimelineSource,
	deleteVodInputTimelineClip,
	getVodInputTimelineDurationMs,
	getVodInputTimelineLinkedPartner,
	getVodInputTimelineTrack,
	moveVodInputTimelineClip,
	normalizeVodInputTimelineDocument,
	overwriteVodInputTimelineTrack,
	positionVodInputTimelineClip,
	splitVodInputTimelineAt,
	trimVodInputTimelineClip,
	type VodInputTimelineDocument,
	type VodInputTimelinePlacedClip,
	type VodInputTimelineSourceFacts,
	type VodInputTimelineTrack,
	type VodInputTimelineV2Document,
	validateVodInputTimeline,
	vodInputTimelineDocumentSchema,
} from "@bitovp/core/vod-input-timeline";

export type TimelineSelection = { track: VodInputTimelineTrack; id: string };
export type TimelineEditOptions = {
	track?: VodInputTimelineTrack;
	linked?: boolean;
};
const newId = () => crypto.randomUUID();
export const normalizeTimeline = normalizeVodInputTimelineDocument;

export function timelineDuration(document: VodInputTimelineDocument) {
	return getVodInputTimelineDurationMs(document);
}
export function timelineItems(
	document: VodInputTimelineDocument,
	track: VodInputTimelineTrack = "video",
) {
	return getVodInputTimelineTrack(document, track).map((clip) => ({
		clip,
		startMs: clip.startMs,
		durationMs: clip.outMs - clip.inMs,
	}));
}
export function timelineAt(
	document: VodInputTimelineDocument,
	position: number,
	track: VodInputTimelineTrack = "video",
) {
	const total = timelineDuration(document);
	if (!total || !Number.isFinite(position)) return null;
	const positionMs = Math.max(0, Math.min(total - 1, Math.round(position)));
	const items = timelineItems(document, track);
	const index = items.findIndex(
		(item) =>
			positionMs >= item.startMs && positionMs < item.startMs + item.durationMs,
	);
	const item = items[index];
	return item
		? { ...item, index, sourceMs: item.clip.inMs + positionMs - item.startMs }
		: null;
}
export function changeRange(
	document: VodInputTimelineDocument,
	id: string,
	inMs: number,
	outMs: number,
	facts: VodInputTimelineSourceFacts[],
	options: TimelineEditOptions = {},
) {
	return trimVodInputTimelineClip(
		document,
		{
			track: options.track ?? "video",
			id,
			inMs,
			outMs,
			linked: options.linked ?? true,
		},
		facts,
		newId,
	);
}
export function appendSource(
	document: VodInputTimelineDocument,
	source: VodInputTimelineSourceFacts,
	id: string,
	range = { inMs: 0, outMs: source.durationMs },
	target: "both" | VodInputTimelineTrack = source.video && source.audio
		? "both"
		: source.video
			? "video"
			: "audio",
	facts: VodInputTimelineSourceFacts[] = [source],
) {
	return appendVodInputTimelineSource(
		document,
		{ target, sourceKey: source.key, ...range, id },
		facts,
	);
}
export function moveClip(
	document: VodInputTimelineDocument,
	id: string,
	toIndex: number,
	options: TimelineEditOptions = {},
) {
	return moveVodInputTimelineClip(
		document,
		{
			track: options.track ?? "video",
			id,
			toIndex,
			linked: options.linked ?? true,
		},
		newId,
	);
}
export function placeClip(
	document: VodInputTimelineV2Document,
	selection: TimelineSelection,
	startMs: number,
) {
	return positionVodInputTimelineClip(
		document,
		{ ...selection, startMs },
		newId,
	);
}
export function splitAt(
	document: VodInputTimelineDocument,
	positionMs: number,
	id: string,
	options: TimelineEditOptions = {},
) {
	return splitVodInputTimelineAt(document, {
		track: options.track ?? "video",
		positionMs,
		id,
		linked: options.linked ?? true,
	});
}
export function deleteClip(
	document: VodInputTimelineDocument,
	selection: TimelineSelection,
	linked: boolean,
) {
	return deleteVodInputTimelineClip(document, { ...selection, linked }, newId);
}
export function linkedPartner(
	document: VodInputTimelineDocument,
	selection: TimelineSelection,
) {
	return getVodInputTimelineLinkedPartner(document, selection);
}
export function replaceSource(
	document: VodInputTimelineDocument,
	selection: TimelineSelection,
	linked: boolean,
	source: VodInputTimelineSourceFacts,
	inMs: number,
	outMs: number,
	facts: VodInputTimelineSourceFacts[],
) {
	const clip = getVodInputTimelineTrack(document, selection.track).find(
		(item) => item.id === selection.id,
	);
	if (!clip) throw new RangeError("No selected interval");
	const durationMs = clip.outMs - clip.inMs;
	if (outMs - inMs < durationMs) throw new RangeError("Source range too short");
	const targets: VodInputTimelineTrack[] =
		linked && linkedPartner(document, selection)
			? ["video", "audio"]
			: [selection.track];
	let next = normalizeTimeline(document);
	for (const track of targets)
		next = overwriteVodInputTimelineTrack(
			next,
			{
				track,
				atMs: clip.startMs,
				sourceKey: source.key,
				inMs,
				outMs: inMs + durationMs,
				id: clip.id,
				splitId: newId(),
			},
			facts,
		);
	return next;
}
export function timelineProblem(
	document: VodInputTimelineDocument,
	facts: VodInputTimelineSourceFacts[],
):
	| "addClip"
	| "sourceUnavailable"
	| "invalidRange"
	| "missingAudio"
	| "missingVideo"
	| "gapTooLong"
	| null {
	if (!vodInputTimelineDocumentSchema.safeParse(document).success)
		return "invalidRange";
	const issue = validateVodInputTimeline(document, facts)[0];
	if (!issue) return null;
	const messages: Record<
		string,
		| "addClip"
		| "sourceUnavailable"
		| "invalidRange"
		| "missingAudio"
		| "missingVideo"
		| "gapTooLong"
	> = {
		TIMELINE_EMPTY: "addClip",
		SOURCE_NOT_READY: "sourceUnavailable",
		SOURCE_RANGE_INVALID: "invalidRange",
		SOURCE_AUDIO_MISSING: "missingAudio",
		SOURCE_VIDEO_MISSING: "missingVideo",
		TIMELINE_GAP_TOO_LONG: "gapTooLong",
	};
	return messages[issue.code] ?? "invalidRange";
}
export function clipEnd(clip: VodInputTimelinePlacedClip) {
	return clip.startMs + clip.outMs - clip.inMs;
}
export function createHistory(document: VodInputTimelineDocument) {
	return {
		present: normalizeTimeline(document),
		past: [] as VodInputTimelineV2Document[],
		future: [] as VodInputTimelineV2Document[],
	};
}
type History = ReturnType<typeof createHistory>;
type Action =
	| { type: "commit" | "reset"; document: VodInputTimelineDocument }
	| { type: "undo" | "redo" };
export function timelineHistory(state: History, action: Action): History {
	if (action.type === "reset") return createHistory(action.document);
	if (action.type === "commit") {
		const present = normalizeTimeline(action.document);
		if (JSON.stringify(state.present) === JSON.stringify(present)) return state;
		return {
			present,
			past: [...state.past.slice(-29), state.present],
			future: [],
		};
	}
	const list = action.type === "undo" ? state.past : state.future;
	const next = list.at(-1);
	if (!next) return state;
	return action.type === "undo"
		? {
				present: next,
				past: state.past.slice(0, -1),
				future: [...state.future, state.present],
			}
		: {
				present: next,
				past: [...state.past.slice(-29), state.present],
				future: state.future.slice(0, -1),
			};
}
export function formatTime(ms: number) {
	const safe = Math.max(0, Math.round(ms)),
		seconds = Math.floor(safe / 1000);
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}.${String(safe % 1000).padStart(3, "0")}`;
}
