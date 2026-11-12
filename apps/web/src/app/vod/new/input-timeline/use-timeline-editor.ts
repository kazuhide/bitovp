"use client";
import type {
	VodInputTimelineDocument,
	VodInputTimelineV2Document,
} from "@bitovp/core/vod-input-timeline";
import { useEffect, useRef, useState } from "react";
import {
	createHistory,
	type TimelineSelection,
	timelineDuration,
	timelineHistory,
	timelineItems,
} from "./timeline-state";

export function useTimelineEditor(
	document: VodInputTimelineV2Document,
	onChange: (next: VodInputTimelineDocument) => void,
	disabled: boolean,
) {
	const [history, setHistory] = useState(() => createHistory(document));
	const [selection, select] = useState<TimelineSelection>(() => ({
		track: document.videoClips.length
			? "video"
			: document.audioClips.length
				? "audio"
				: "video",
		id: document.videoClips[0]?.id ?? document.audioClips[0]?.id ?? "",
	}));
	const [positionMs, setPositionMs] = useState(0);
	const accepted = useRef(JSON.stringify(document));
	const serialized = JSON.stringify(document);
	useEffect(() => {
		if (accepted.current !== serialized) {
			accepted.current = serialized;
			setHistory(createHistory(JSON.parse(serialized)));
		}
	}, [serialized]);
	useEffect(() => {
		const items = timelineItems(document, selection.track);
		if (
			!items.some((item) => item.clip.id === selection.id) &&
			selection.id !== ""
		)
			select({ track: selection.track, id: items[0]?.clip.id ?? "" });
		setPositionMs((position) =>
			Math.min(position, Math.max(0, timelineDuration(document) - 1)),
		);
	}, [document, selection]);
	function publish(next: ReturnType<typeof createHistory>) {
		if (disabled || next === history) return;
		accepted.current = JSON.stringify(next.present);
		setHistory(next);
		onChange(next.present);
	}
	return {
		selection,
		select,
		selectedId: selection.id,
		selectedTrack: selection.track,
		positionMs,
		seek(position: number, duration = timelineDuration(document)) {
			if (Number.isFinite(position))
				setPositionMs(
					Math.max(
						0,
						Math.min(Math.round(position), Math.max(0, duration - 1)),
					),
				);
		},
		commit(next: VodInputTimelineDocument) {
			publish(timelineHistory(history, { type: "commit", document: next }));
		},
		undo: () => publish(timelineHistory(history, { type: "undo" })),
		redo: () => publish(timelineHistory(history, { type: "redo" })),
		canUndo: history.past.length > 0,
		canRedo: history.future.length > 0,
	};
}
