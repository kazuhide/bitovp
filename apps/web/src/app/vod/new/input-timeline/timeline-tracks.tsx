"use client";
import type {
	VodInputTimelineDocument,
	VodInputTimelineSourceFacts,
	VodInputTimelineTrack,
	VodInputTimelineV2Document,
} from "@bitovp/core/vod-input-timeline";
import { Magnet } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useTimelineLabels } from "./labels";
import { TimelineClip } from "./timeline-clip";
import { TimelineRuler } from "./timeline-ruler";
import { snapTimelineTime, timelineSnapCandidates } from "./timeline-snapping";
import {
	formatTime,
	linkedPartner,
	normalizeTimeline,
	timelineDuration,
	timelineItems,
} from "./timeline-state";
import { useTimelineGesture } from "./use-timeline-gesture";
import { useTimelineScale } from "./use-timeline-scale";

export function TimelineTracks({
	document: wireDocument,
	facts,
	names,
	selectedId,
	selectedTrack = "video",
	linked = true,
	positionMs,
	disabled,
	onSelect,
	onSelectTrack,
	onSeek,
	onChange,
	onDelete,
	onError,
	onDragging,
}: {
	document: VodInputTimelineDocument;
	facts: VodInputTimelineSourceFacts[];
	names: Record<string, string>;
	selectedId: string;
	selectedTrack?: VodInputTimelineTrack;
	linked?: boolean;
	positionMs: number;
	disabled: boolean;
	onSelect: (id: string, track: VodInputTimelineTrack) => void;
	onSelectTrack?: (track: VodInputTimelineTrack) => void;
	onSeek: (position: number) => void;
	onChange: (next: VodInputTimelineV2Document) => void;
	onDelete: (id: string, track: VodInputTimelineTrack) => void;
	onError: () => void;
	onDragging: (active: boolean) => void;
}) {
	const document = useMemo(
		() => normalizeTimeline(wireDocument),
		[wireDocument],
	);
	const l = useTimelineLabels(),
		track = useRef<HTMLDivElement>(null),
		viewport = useRef<HTMLDivElement>(null);
	const scale = useTimelineScale(viewport);
	const [snapping, setSnapping] = useState(true);
	const gesture = useTimelineGesture({
		document,
		facts,
		disabled,
		track,
		pixelsPerMs: scale.pixelsPerMs,
		linked,
		snapping,
		positionMs,
		onChange,
		onSelect,
		onSeek,
		onError,
	});
	const total = timelineDuration(gesture.shown),
		canvas = scale.canvas(gesture.extentMs);
	const labelBeforeGuide =
		gesture.snapMs !== null &&
		gesture.snapMs * scale.pixelsPerMs - scale.scrollLeft >
			scale.viewportWidth / 2;
	const partner = linked
		? linkedPartner(gesture.shown, { track: selectedTrack, id: selectedId })
		: null;
	const followed = useRef({ positionMs, pixelsPerMs: scale.pixelsPerMs });
	useEffect(() => onDragging(gesture.dragging), [gesture.dragging, onDragging]);
	useEffect(() => {
		const changed =
			followed.current.positionMs !== positionMs ||
			followed.current.pixelsPerMs !== scale.pixelsPerMs;
		followed.current = { positionMs, pixelsPerMs: scale.pixelsPerMs };
		const container = viewport.current;
		if (!changed || !container?.clientWidth || gesture.dragging) return;
		const x = positionMs * scale.pixelsPerMs;
		if (
			x < container.scrollLeft ||
			x > container.scrollLeft + container.clientWidth - 20
		)
			container.scrollLeft = Math.max(0, x - container.clientWidth / 3);
	}, [positionMs, scale.pixelsPerMs, gesture.dragging]);
	return (
		<section
			aria-label={l.tracks}
			className="min-w-0 space-y-2 border-zinc-800 border-t pt-3"
		>
			<div className="flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-400">
				<span className="tabular-nums">
					{formatTime(positionMs)} / {formatTime(total)}
				</span>
				<div className="flex items-center gap-2">
					<Button
						type="button"
						size="sm"
						variant={snapping ? "secondary" : "ghost"}
						aria-label={l.snap}
						aria-pressed={snapping}
						title={l.snapHint}
						disabled={gesture.dragging}
						onClick={() => setSnapping((value) => !value)}
					>
						<Magnet className="size-4" aria-hidden="true" />
					</Button>
					<label className="flex items-center gap-2">
						<span className="hidden whitespace-nowrap sm:inline">{l.zoom}</span>
						<select
							aria-label={l.zoom}
							value={scale.zoom}
							disabled={gesture.dragging}
							className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1"
							onChange={(event) => scale.setZoom(event.target.value)}
						>
							{scale.zoom === "custom" && (
								<option value="custom" disabled>
									{Number(scale.factor.toPrecision(3))}×
								</option>
							)}
							{[0.25, 0.5, 1, 2, 4, 8].map((value) => (
								<option value={value} key={value}>
									{value}×
								</option>
							))}
						</select>
					</label>
					<Button
						type="button"
						size="sm"
						variant="ghost"
						disabled={!total || gesture.dragging}
						onClick={() => scale.fit(total)}
					>
						{l.fit}
					</Button>
				</div>
			</div>
			<span role="status" className="sr-only">
				{gesture.snapMs !== null
					? `${l.snapped}: ${formatTime(gesture.snapMs)}`
					: ""}
			</span>
			<div className="flex min-w-0 gap-2">
				<div className="w-12 shrink-0 pt-7 text-xs text-zinc-400">
					{(["video", "audio"] as const).map((medium) => (
						<button
							type="button"
							key={medium}
							aria-label={medium === "video" ? l.selectVideo : l.selectAudio}
							aria-pressed={selectedTrack === medium}
							disabled={disabled || gesture.dragging}
							onClick={() => onSelectTrack?.(medium)}
							className={`block w-full rounded text-left font-medium focus-visible:outline-2 focus-visible:outline-emerald-300 ${medium === "video" ? "h-16" : "h-10"} ${selectedTrack === medium ? "text-zinc-100" : "text-zinc-500"}`}
						>
							{medium === "video" ? "V1" : "A1"}
						</button>
					))}
				</div>
				<div
					ref={viewport}
					onScroll={scale.onScroll}
					className="min-w-0 flex-1 overflow-x-auto overscroll-x-contain"
				>
					<div
						ref={track}
						data-testid="input-timeline-track"
						className="relative"
						style={{ width: canvas.widthPx }}
						{...gesture.pointerHandlers}
					>
						<TimelineRuler
							durationMs={total}
							positionMs={positionMs}
							pixelsPerMs={scale.pixelsPerMs}
							ticks={canvas.ticks}
							disabled={!total || gesture.dragging}
							snap={
								snapping
									? (position) =>
											snapTimelineTime(
												position,
												timelineSnapCandidates(document).filter(
													(time) => time < total,
												),
												scale.pixelsPerMs,
											)
									: undefined
							}
							onSeek={onSeek}
						/>
						{(["video", "audio"] as const).map((medium) => (
							<fieldset
								key={medium}
								aria-label={medium === "video" ? l.videoTrack : l.audioTrack}
								className={`relative m-0 min-w-0 border-0 border-zinc-800 p-0 ${medium === "video" ? "h-16" : "h-10 border-t"}`}
							>
								{timelineItems(gesture.shown, medium).map(
									({ clip, startMs }, index) => (
										<TimelineClip
											key={clip.id}
											clip={clip}
											track={medium}
											index={index}
											name={names[clip.sourceKey] ?? clip.sourceKey}
											pixelsPerMs={scale.pixelsPerMs}
											selected={
												selectedId === clip.id &&
												(selectedTrack === medium || partner?.id === clip.id)
											}
											fact={facts.find(
												(source) => source.key === clip.sourceKey,
											)}
											disabled={disabled}
											muted={medium === "audio" && !document.audioEnabled}
											linked={linked && partner?.id === clip.id}
											audioEnabled={document.audioEnabled}
											handlers={gesture.handlers}
											onSelect={onSelect}
											onSeek={(local) => onSeek(startMs + local)}
											onDelete={onDelete}
										/>
									),
								)}
							</fieldset>
						))}
						{!!total && (
							<div
								aria-hidden="true"
								className="pointer-events-none absolute inset-y-0 z-20 border-amber-300 border-l-2"
								style={{
									left: Math.min(positionMs, total - 1) * scale.pixelsPerMs,
								}}
							/>
						)}
						{gesture.snapMs !== null && (
							<div
								data-testid="input-timeline-snap-guide"
								data-snap-ms={gesture.snapMs}
								aria-hidden="true"
								className="pointer-events-none absolute inset-y-0 z-30 border-emerald-300 border-l border-dashed"
								style={{ left: gesture.snapMs * scale.pixelsPerMs }}
							>
								<span
									className={`absolute top-0 whitespace-nowrap rounded border border-emerald-300 bg-zinc-950 px-1 text-emerald-200 text-[10px] tabular-nums ${labelBeforeGuide ? "right-1" : "left-1"}`}
								>
									{formatTime(gesture.snapMs)}
								</span>
							</div>
						)}
					</div>
				</div>
			</div>
			<label className="block text-xs text-zinc-400">
				{l.position}
				<input
					type="range"
					aria-label={l.position}
					min={0}
					max={Math.max(0, timelineDuration(document) - 1)}
					value={positionMs}
					step={1}
					disabled={!total || gesture.dragging}
					className="mt-1 block w-full accent-emerald-400"
					onChange={(event) => onSeek(Number(event.target.value))}
				/>
			</label>
		</section>
	);
}
