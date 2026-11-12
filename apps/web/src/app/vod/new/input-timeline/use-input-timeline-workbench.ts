"use client";
import {
	MAX_VOD_TIMELINE_CLIPS,
	type VodInputTimelineTrack,
	type VodInputTimelineV2Document,
} from "@bitovp/core/vod-input-timeline";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { baseName } from "@/lib/format";
import { taskErrorText, useTimelineLabels } from "./labels";
import {
	availableSourceDuration,
	canAppendTarget,
} from "./source-availability";
import {
	appendSource,
	changeRange,
	deleteClip,
	linkedPartner,
	moveClip,
	normalizeTimeline,
	splitAt,
	type TimelineSelection,
	timelineAt,
	timelineDuration,
	timelineItems,
} from "./timeline-state";
import type { VodInputTimelineEditorProps } from "./types";
import { useInputTimelinePreview } from "./use-input-timeline-preview";
import { useSourceInsertion } from "./use-source-insertion";
import { useTimelineEditor } from "./use-timeline-editor";

export function useInputTimelineWorkbench({
	document: wireDocument,
	onChange,
	sources,
	disabled = false,
	onReadinessChange,
}: VodInputTimelineEditorProps) {
	const document = useMemo(
		() => normalizeTimeline(wireDocument),
		[wireDocument],
	);
	const l = useTimelineLabels();
	const editor = useTimelineEditor(document, onChange, disabled);
	const [linked, setLinked] = useState(true);
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
	const focusAfter = useRef<TimelineSelection | null>(null);
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
	const items = timelineItems(document, editor.selectedTrack);
	const selectedIndex = items.findIndex(
		(item) => item.clip.id === editor.selectedId,
	);
	const selected = items[selectedIndex]?.clip;
	const partner = selected ? linkedPartner(document, editor.selection) : null;
	const linkedSelection =
		linked &&
		(!!partner ||
			(!selected &&
				!document.videoClips.length &&
				!document.audioClips.length));
	const point = timelineAt(document, editor.positionMs, editor.selectedTrack);
	const selectedSource = state.facts.find((source) => source.key === sourceKey);
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
		const selection = focusAfter.current;
		if (!selection) return;
		const target = timelineItems(document, selection.track).some(
			(item) => item.clip.id === selection.id,
		)
			? container.current?.querySelector<HTMLButtonElement>(
					`button[data-clip-track="${selection.track}"][data-clip-id="${selection.id}"]`,
				)
			: container.current;
		target?.focus();
		focusAfter.current = null;
	}, [document]);
	const selectTrack = useCallback(
		(track: VodInputTimelineTrack) => {
			const rows = timelineItems(document, track);
			editor.select({
				track,
				id: rows.some((item) => item.clip.id === editor.selectedId)
					? editor.selectedId
					: (rows[0]?.clip.id ?? ""),
			});
			setLinked(false);
		},
		[document, editor.selectedId, editor.select],
	);
	const sourceMedium = selectedSource
		? !selectedSource.video
			? "audio"
			: !selectedSource.audio
				? "video"
				: "both"
		: null;
	const sourceTargetSeen = useRef("");
	useEffect(() => {
		if (mode !== "source" || !sourceMedium) return;
		const signature = `${sourceKey}:${sourceMedium}`;
		if (sourceTargetSeen.current === signature) return;
		sourceTargetSeen.current = signature;
		if (sourceMedium !== "both") selectTrack(sourceMedium);
	}, [sourceKey, sourceMedium, mode, selectTrack]);
	function apply(next: () => VodInputTimelineV2Document) {
		if (disabled) return null;
		try {
			const value = next();
			editor.commit(value);
			setLocalError(null);
			return value;
		} catch (cause) {
			const code =
				cause instanceof Error && "code" in cause ? String(cause.code) : "";
			const labels: Record<string, string> = {
				SOURCE_TOO_SHORT: "sourceTooShort",
				SOURCE_VIDEO_MISSING: "missingVideo",
				SOURCE_AUDIO_MISSING: "missingAudio",
				TIMELINE_GAP_TOO_LONG: "gapTooLong",
			};
			setLocalError(labels[code] ?? "invalidRange");
			return null;
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
	const insertion = useSourceInsertion({
		document,
		source: selectedSource,
		facts: state.facts,
		selection: editor.selection,
		selectedDurationMs: selected ? selected.outMs - selected.inMs : 0,
		linked: linkedSelection,
		disabled: disabled || dragging,
		apply,
		onInserted(id, track, positionMs, durationMs) {
			editor.select({ track, id });
			editor.seek(positionMs, durationMs);
			setSequenceAnchor(positionMs);
			setMode("sequence");
		},
		onRangeChanged(positionMs) {
			sourceSeek(positionMs);
			setLocalError(null);
		},
	});
	function remove(
		id: string,
		track: VodInputTimelineTrack = editor.selectedTrack,
	) {
		const rows = timelineItems(document, track),
			index = rows.findIndex((item) => item.clip.id === id);
		const next = apply(() =>
			deleteClip(
				document,
				{ track, id },
				linked && !!linkedPartner(document, { track, id }),
			),
		);
		if (!next) return;
		const remaining = timelineItems(next, track);
		const nextId =
			remaining[Math.min(index, remaining.length - 1)]?.clip.id ?? "";
		editor.select({ track, id: nextId });
		focusAfter.current = { track, id: nextId };
	}
	const targetLabel = linkedSelection
		? "V1+A1"
		: editor.selectedTrack === "video"
			? "V1"
			: "A1";
	function quickTarget(source: (typeof state.facts)[number]) {
		return !source.video
			? "audio"
			: !source.audio
				? "video"
				: linkedSelection
					? "both"
					: editor.selectedTrack;
	}
	function canQuickAdd(source: (typeof state.facts)[number]) {
		const target = quickTarget(source);
		return (
			canAppendTarget(document, target) &&
			availableSourceDuration(source, target, document.audioEnabled) > 0
		);
	}
	return {
		document,
		l,
		editor,
		state,
		names,
		selected,
		selectedIndex,
		selectedSource,
		insertion,
		error,
		container,
		mode,
		sourceKey,
		sourcePosition,
		whole,
		setWhole,
		dragging,
		setDragging,
		linked: linked && !!partner,
		linkPreference: linked,
		linkAvailable: !!partner,
		targetLabel,
		selectTrack,
		canQuickAdd,
		setLinked,
		remove,
		seek,
		sourceSeek,
		previewDurationMs:
			mode === "source"
				? state.sourcePreviewDurationMs
				: timelineDuration(document),
		canSplit:
			!!point &&
			point.sourceMs > point.clip.inMs &&
			items.length < MAX_VOD_TIMELINE_CLIPS,
		canMoveEarlier: selectedIndex > 0,
		canMoveLater: selectedIndex >= 0 && selectedIndex < items.length - 1,
		canRetry:
			!!state.probeError || !!state.preview.error || localError === "failed",
		selectSource(key: string) {
			setLocalError(null);
			setSourceSelection(key);
			setSourcePosition(0);
			setSourceAnchor(0);
			setMode("source");
		},
		selectClip(id: string, track: VodInputTimelineTrack = "video") {
			editor.select({ track, id });
			setMode("sequence");
		},
		add(source: (typeof state.facts)[number]) {
			if (!canQuickAdd(source)) return;
			const target = quickTarget(source);
			const id = crypto.randomUUID();
			const next = apply(() =>
				appendSource(
					document,
					source,
					id,
					{
						inMs: 0,
						outMs: availableSourceDuration(
							source,
							target,
							document.audioEnabled,
						),
					},
					target,
					state.facts,
				),
			);
			if (!next) return;
			const track = target === "both" ? "video" : target;
			const clip = timelineItems(next, track).find(
				(item) => item.clip.id === id,
			)?.clip;
			if (clip) {
				editor.select({ track, id });
				editor.seek(clip.startMs, next.durationMs);
				setSequenceAnchor(clip.startMs);
				setMode("sequence");
			}
		},
		setMode,
		onPlayback: mode === "source" ? setSourcePosition : editor.seek,
		invalid: () => setLocalError("invalidRange"),
		mediaError: () => setLocalError("failed"),
		changeRange: (inMs: number, outMs: number) =>
			selected &&
			apply(() =>
				changeRange(document, selected.id, inMs, outMs, state.facts, {
					track: editor.selectedTrack,
					linked: linked && !!partner,
				}),
			),
		move: (direction: number) =>
			selected &&
			apply(() =>
				moveClip(document, selected.id, selectedIndex + direction, {
					track: editor.selectedTrack,
					linked: linked && !!partner,
				}),
			),
		split() {
			const id = crypto.randomUUID();
			const next = apply(() =>
				splitAt(document, editor.positionMs, id, {
					track: editor.selectedTrack,
					linked:
						linked &&
						!!point &&
						!!linkedPartner(document, {
							track: editor.selectedTrack,
							id: point.clip.id,
						}),
				}),
			);
			if (
				next &&
				point?.clip.id === editor.selectedId &&
				timelineItems(next, editor.selectedTrack).some(
					(item) => item.clip.id === id,
				)
			)
				editor.select({ track: editor.selectedTrack, id });
		},
		toggleAudio: (audioEnabled: boolean) =>
			apply(() => ({ ...document, audioEnabled })),
		commit: (next: VodInputTimelineV2Document) => apply(() => next),
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
