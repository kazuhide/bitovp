"use client";

import {
	MAX_VOD_TIMELINE_CLIPS,
	type VodInputTimelineDocument,
	type VodInputTimelineSourceFacts,
} from "@bitovp/core/vod-input-timeline";
import { useEffect, useRef, useState } from "react";
import { baseName } from "@/lib/format";
import { taskErrorText, useTimelineLabels } from "./labels";
import {
	appendSource,
	changeRange,
	moveClip,
	splitAt,
	timelineAt,
	timelineDuration,
} from "./timeline-state";
import type { VodInputTimelineEditorProps } from "./types";
import { useInputTimelinePreview } from "./use-input-timeline-preview";
import { useTimelineEditor } from "./use-timeline-editor";

export function useInputTimelineWorkbench({
	document,
	onChange,
	sources,
	disabled = false,
	onReadinessChange,
}: VodInputTimelineEditorProps) {
	const l = useTimelineLabels();
	const editor = useTimelineEditor(document, onChange, disabled);
	const [mode, setMode] = useState<"source" | "sequence">("sequence");
	const [sourceSelection, setSourceSelection] = useState<string | null>(
		sources[0]?.key ?? null,
	);
	const sourceKey = sources.some((source) => source.key === sourceSelection)
		? sourceSelection
		: (sources[0]?.key ?? null);
	const [sourcePosition, setSourcePosition] = useState(0);
	const [sequenceAnchor, setSequenceAnchor] = useState(0);
	const [sourceAnchor, setSourceAnchor] = useState(0);
	const [whole, setWhole] = useState(false);
	const [dragging, setDragging] = useState(false);
	const [localError, setLocalError] = useState<string | null>(null);
	const container = useRef<HTMLElement>(null);
	const focusAfter = useRef<string | null>(null);
	const readinessCallback = useRef(onReadinessChange);
	readinessCallback.current = onReadinessChange;
	const state = useInputTimelinePreview({
		document,
		sources,
		sourceKey: mode === "source" ? sourceKey : null,
		anchorMs: mode === "source" ? sourceAnchor : sequenceAnchor,
		whole,
		disabled,
	});
	const names = Object.fromEntries(
		sources.map((source) => [source.key, baseName(source.path) || source.key]),
	);
	const selectedIndex = document.clips.findIndex(
		(clip) => clip.id === editor.selectedId,
	);
	const selected = document.clips[selectedIndex];
	const point = timelineAt(document, editor.positionMs);
	const issue =
		state.probeError ??
		(!state.probe.pending && state.problem !== "addClip"
			? state.problem
			: null);
	const error = localError ?? issue ?? state.preview.error;
	useEffect(() => {
		readinessCallback.current?.({
			ready: state.ready,
			probeId: state.probeId,
			facts: state.facts,
			error: issue ? taskErrorText(issue, l) : null,
		});
	}, [state.ready, state.probeId, state.facts, issue, l]);
	useEffect(() => {
		if (focusAfter.current !== null) {
			const target = document.clips.some(
				(clip) => clip.id === focusAfter.current,
			)
				? container.current?.querySelector<HTMLButtonElement>(
						`button[data-clip-id="${focusAfter.current}"]`,
					)
				: container.current;
			target?.focus();
			focusAfter.current = null;
		}
	}, [document]);
	function apply(next: () => VodInputTimelineDocument) {
		if (disabled) return;
		try {
			editor.commit(next());
			setLocalError(null);
		} catch {
			setLocalError("invalidRange");
		}
	}
	function seek(position: number) {
		setMode("sequence");
		editor.seek(position);
		const range =
			mode === "sequence" ? state.preview.ready?.result?.preview : null;
		if (
			!range ||
			position < range.startMs ||
			position >= range.startMs + range.durationMs
		)
			setSequenceAnchor(position);
	}
	function remove(id: string) {
		const index = document.clips.findIndex((clip) => clip.id === id);
		const next = {
			...document,
			clips: document.clips.filter((clip) => clip.id !== id),
		};
		const nextId = next.clips[Math.min(index, next.clips.length - 1)]?.id ?? "";
		apply(() => next);
		editor.setSelectedId(nextId);
		focusAfter.current = nextId;
	}
	function add(source: VodInputTimelineSourceFacts) {
		const id = crypto.randomUUID();
		apply(() => {
			const next = appendSource(document, source, id);
			editor.seek(timelineDuration(document), timelineDuration(next));
			setSequenceAnchor(timelineDuration(document));
			editor.setSelectedId(id);
			setMode("sequence");
			return next;
		});
	}
	function sourceSeek(position: number) {
		setSourcePosition(position);
		const range = state.preview.ready?.result?.preview;
		if (
			!range ||
			position < range.startMs ||
			position >= range.startMs + range.durationMs
		)
			setSourceAnchor(position);
	}
	return {
		l,
		editor,
		state,
		names,
		selected,
		selectedIndex,
		error,
		container,
		mode,
		sourceKey,
		sourcePosition,
		whole,
		setWhole,
		dragging,
		setDragging,
		add,
		remove,
		seek,
		sourceSeek,
		previewDurationMs:
			mode === "source"
				? (state.facts.find((source) => source.key === sourceKey)?.durationMs ??
					0)
				: timelineDuration(document),
		canSplit:
			!!point &&
			point.sourceMs > point.clip.inMs &&
			document.clips.length < MAX_VOD_TIMELINE_CLIPS,
		canRetry:
			!!state.probeError || !!state.preview.error || localError === "failed",
		selectSource(key: string) {
			setSourceSelection(key);
			setSourcePosition(0);
			setSourceAnchor(0);
			setMode("source");
		},
		selectClip(id: string) {
			editor.setSelectedId(id);
			setMode("sequence");
		},
		setMode,
		onPlayback: mode === "source" ? setSourcePosition : editor.seek,
		invalid: () => setLocalError("invalidRange"),
		mediaError: () => setLocalError("failed"),
		changeRange: (inMs: number, outMs: number) =>
			selected &&
			apply(() => changeRange(document, selected.id, inMs, outMs, state.facts)),
		move: (direction: number) =>
			selected &&
			apply(() => moveClip(document, selected.id, selectedIndex + direction)),
		split: () =>
			apply(() => splitAt(document, editor.positionMs, crypto.randomUUID())),
		toggleAudio: (audioEnabled: boolean) =>
			apply(() => ({ ...document, audioEnabled })),
		commit: (next: VodInputTimelineDocument) => apply(() => next),
		retry() {
			setLocalError(null);
			state.probe.retry();
		},
		onKeyDown(event: React.KeyboardEvent<HTMLElement>) {
			const target = event.target;
			const textInput =
				target instanceof HTMLInputElement &&
				!["range", "checkbox", "button"].includes(target.type);
			if (
				event.defaultPrevented ||
				textInput ||
				target instanceof HTMLTextAreaElement ||
				(target instanceof HTMLElement && target.isContentEditable)
			)
				return;
			if (
				(event.metaKey || event.ctrlKey) &&
				event.key.toLowerCase() === "z" &&
				!disabled &&
				!dragging
			) {
				event.preventDefault();
				if (event.shiftKey) editor.redo();
				else editor.undo();
			}
			if (
				event.key === " " &&
				target instanceof HTMLElement &&
				(target === container.current ||
					target.getAttribute("role") === "slider")
			) {
				event.preventDefault();
				container.current
					?.querySelector<HTMLButtonElement>("button[data-preview-play]")
					?.click();
			}
		},
	};
}
