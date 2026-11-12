"use client";
import type {
	VodInputTimelineSourceFacts,
	VodInputTimelineTrack,
	VodInputTimelineV2Document,
} from "@bitovp/core/vod-input-timeline";
import { useState } from "react";
import {
	appendSource,
	clipEnd,
	replaceSource,
	type TimelineSelection,
	timelineItems,
} from "./timeline-state";

export function useSourceInsertion({
	document,
	source,
	facts,
	selection,
	selectedDurationMs,
	linked,
	disabled,
	apply,
	onInserted,
	onRangeChanged,
}: {
	document: VodInputTimelineV2Document;
	source: VodInputTimelineSourceFacts | undefined;
	facts: VodInputTimelineSourceFacts[];
	selection: TimelineSelection;
	selectedDurationMs: number;
	linked: boolean;
	disabled: boolean;
	apply: (
		next: () => VodInputTimelineV2Document,
	) => VodInputTimelineV2Document | null;
	onInserted: (
		id: string,
		track: VodInputTimelineTrack,
		positionMs: number,
		durationMs: number,
	) => void;
	onRangeChanged: (positionMs: number) => void;
}) {
	const [chosen, setChosen] = useState<{
		key: string;
		inMs: number;
		outMs: number;
	} | null>(null);
	const range =
		chosen && chosen.key === source?.key
			? chosen
			: { inMs: 0, outMs: source?.durationMs ?? 0 };
	const target = linked ? "both" : selection.track;
	function sourceError(forReplacement: boolean): string | null {
		if (!source) return "sourceUnavailable";
		if (
			range.inMs < 0 ||
			range.outMs <= range.inMs ||
			range.outMs > source.durationMs
		)
			return "invalidRange";
		if ((target === "both" || target === "video") && !source.video)
			return "missingVideo";
		if (
			(target === "audio" || (target === "both" && document.audioEnabled)) &&
			!source.audio
		)
			return "missingAudio";
		const mediaDuration = Math.min(
			target === "both" || target === "video"
				? (source.video?.durationMs ?? source.durationMs)
				: source.durationMs,
			target === "audio" || (target === "both" && document.audioEnabled)
				? (source.audio?.durationMs ?? source.durationMs)
				: source.durationMs,
		);
		const requiredEnd = forReplacement
			? range.inMs + selectedDurationMs
			: range.outMs;
		if (
			requiredEnd > mediaDuration ||
			(forReplacement && range.outMs - range.inMs < selectedDurationMs)
		)
			return "sourceTooShort";
		return null;
	}
	const hasSelection = !!selection.id && selectedDurationMs > 0;
	const appendError = sourceError(false);
	const replaceError = hasSelection ? sourceError(true) : null;
	return {
		range,
		target,
		appendError,
		replaceError,
		canAppend: !disabled && !!source && !appendError,
		canReplace: !disabled && !!source && hasSelection && !replaceError,
		setRange(inMs: number, outMs: number) {
			if (!source) return;
			setChosen({ key: source.key, inMs, outMs });
			onRangeChanged(inMs);
		},
		append(selectedSource = source, useFullRange = false) {
			if (disabled || !selectedSource) return;
			const nextRange = useFullRange
				? { inMs: 0, outMs: selectedSource.durationMs }
				: range;
			const id = crypto.randomUUID();
			const next = apply(() =>
				appendSource(document, selectedSource, id, nextRange, target, facts),
			);
			if (!next) return;
			const track = target === "both" ? "video" : target;
			const inserted = timelineItems(next, track).find(
				(item) => item.clip.id === id,
			)?.clip;
			if (inserted) onInserted(id, track, inserted.startMs, next.durationMs);
		},
		replace() {
			if (disabled || !source || !hasSelection || replaceError) return;
			const next = apply(() =>
				replaceSource(
					document,
					selection,
					linked,
					source,
					range.inMs,
					range.outMs,
					facts,
				),
			);
			const clip =
				next &&
				timelineItems(next, selection.track).find(
					(item) => item.clip.id === selection.id,
				)?.clip;
			if (next && clip)
				onInserted(clip.id, selection.track, clip.startMs, next.durationMs);
		},
		appendPositionMs:
			target === "both"
				? document.durationMs
				: timelineItems(document, target).reduce(
						(end, item) => Math.max(end, clipEnd(item.clip)),
						0,
					),
	};
}
