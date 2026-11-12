import {
	getVodInputTimelineDurationMs,
	locateVodInputTimelineTime,
	type VodInputTimelineDocument,
	type VodInputTimelineSourceFacts,
	validateVodInputTimeline,
	vodInputTimelineDocumentSchema,
} from "@bitovp/core/vod-input-timeline";

export function timelineDuration(document: VodInputTimelineDocument) {
	return getVodInputTimelineDurationMs(document);
}

export function timelineItems(document: VodInputTimelineDocument) {
	let startMs = 0;
	return document.clips.map((clip) => {
		const durationMs = clip.outMs - clip.inMs;
		const item = { clip, startMs, durationMs };
		startMs += durationMs;
		return item;
	});
}

export function timelineAt(
	document: VodInputTimelineDocument,
	position: number,
) {
	const total = timelineDuration(document);
	if (!total || !Number.isFinite(position)) return null;
	const positionMs = Math.max(0, Math.min(total - 1, Math.round(position)));
	const point = locateVodInputTimelineTime(document, positionMs);
	const clip = point && document.clips[point.clipIndex];
	return point && clip
		? {
				clip,
				index: point.clipIndex,
				startMs: point.timelineStartMs,
				durationMs: clip.outMs - clip.inMs,
				sourceMs: point.sourceMs,
			}
		: null;
}

export function changeRange(
	document: VodInputTimelineDocument,
	id: string,
	inMs: number,
	outMs: number,
	facts: VodInputTimelineSourceFacts[],
) {
	const clip = document.clips.find((item) => item.id === id);
	const source = facts.find((item) => item.key === clip?.sourceKey);
	if (!clip || !source || outMs > source.durationMs)
		throw new RangeError("Invalid source range");
	return vodInputTimelineDocumentSchema.parse({
		...document,
		clips: document.clips.map((item) =>
			item.id === id ? { ...item, inMs, outMs } : item,
		),
	});
}

export function appendSource(
	document: VodInputTimelineDocument,
	source: VodInputTimelineSourceFacts,
	id: string,
) {
	return vodInputTimelineDocumentSchema.parse({
		...document,
		clips: [
			...document.clips,
			{ id, sourceKey: source.key, inMs: 0, outMs: source.durationMs },
		],
	});
}

export function moveClip(
	document: VodInputTimelineDocument,
	id: string,
	toIndex: number,
) {
	const from = document.clips.findIndex((item) => item.id === id);
	const clip = document.clips[from];
	if (!clip) return document;
	const to = Math.max(0, Math.min(document.clips.length - 1, toIndex));
	if (from === to) return document;
	const clips = document.clips.filter((item) => item.id !== id);
	clips.splice(to, 0, clip);
	return { ...document, clips };
}

export function splitAt(
	document: VodInputTimelineDocument,
	positionMs: number,
	id: string,
) {
	const point = timelineAt(document, positionMs);
	if (!point || point.sourceMs === point.clip.inMs) return document;
	return vodInputTimelineDocumentSchema.parse({
		...document,
		clips: document.clips.flatMap((clip) =>
			clip.id === point.clip.id
				? [
						{ ...clip, outMs: point.sourceMs },
						{ ...clip, id, inMs: point.sourceMs },
					]
				: [clip],
		),
	});
}

export function timelineProblem(
	document: VodInputTimelineDocument,
	facts: VodInputTimelineSourceFacts[],
): "addClip" | "sourceUnavailable" | "invalidRange" | "missingAudio" | null {
	if (!vodInputTimelineDocumentSchema.safeParse(document).success)
		return "invalidRange";
	const issue = validateVodInputTimeline(document, facts)[0];
	return issue
		? {
				TIMELINE_EMPTY: "addClip" as const,
				SOURCE_NOT_READY: "sourceUnavailable" as const,
				SOURCE_RANGE_INVALID: "invalidRange" as const,
				SOURCE_AUDIO_MISSING: "missingAudio" as const,
			}[issue.code]
		: null;
}

export function createHistory(document: VodInputTimelineDocument) {
	return {
		present: document,
		past: [] as VodInputTimelineDocument[],
		future: [] as VodInputTimelineDocument[],
	};
}
type History = ReturnType<typeof createHistory>;
type Action =
	| { type: "commit" | "reset"; document: VodInputTimelineDocument }
	| { type: "undo" | "redo" };

export function timelineHistory(state: History, action: Action): History {
	if (action.type === "reset") return createHistory(action.document);
	if (action.type === "commit") {
		if (JSON.stringify(state.present) === JSON.stringify(action.document))
			return state;
		return {
			present: action.document,
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
				past: list.slice(0, -1),
				future: [...state.future, state.present],
			}
		: {
				present: next,
				past: [...state.past.slice(-29), state.present],
				future: list.slice(0, -1),
			};
}

export function formatTime(ms: number) {
	const safe = Math.max(0, Math.round(ms));
	const seconds = Math.floor(safe / 1000);
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}.${String(safe % 1000).padStart(3, "0")}`;
}
