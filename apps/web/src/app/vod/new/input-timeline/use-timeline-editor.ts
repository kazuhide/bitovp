"use client";

import type { VodInputTimelineDocument } from "@bitovp/core/vod-input-timeline";
import { useEffect, useRef, useState } from "react";
import {
	createHistory,
	timelineDuration,
	timelineHistory,
} from "./timeline-state";

export function useTimelineEditor(
	document: VodInputTimelineDocument,
	onChange: (next: VodInputTimelineDocument) => void,
	disabled: boolean,
) {
	const [history, setHistory] = useState(() => createHistory(document));
	const [selectedId, setSelectedId] = useState(document.clips[0]?.id ?? "");
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
		if (!document.clips.some((clip) => clip.id === selectedId))
			setSelectedId(document.clips[0]?.id ?? "");
		setPositionMs((position) =>
			Math.min(position, Math.max(0, timelineDuration(document) - 1)),
		);
	}, [document, selectedId]);
	function publish(next: ReturnType<typeof createHistory>) {
		if (disabled || next === history) return;
		accepted.current = JSON.stringify(next.present);
		setHistory(next);
		onChange(next.present);
	}
	return {
		selectedId,
		setSelectedId,
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
