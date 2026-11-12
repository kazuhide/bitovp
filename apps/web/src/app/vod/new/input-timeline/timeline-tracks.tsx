"use client";

import type {
	VodInputTimelineDocument,
	VodInputTimelineSourceFacts,
} from "@bitovp/core/vod-input-timeline";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { useTimelineLabels } from "./labels";
import { TimelineClip } from "./timeline-clip";
import { TimelineRuler } from "./timeline-ruler";
import { formatTime, timelineDuration, timelineItems } from "./timeline-state";
import { useTimelineGesture } from "./use-timeline-gesture";
import { useTimelineScale } from "./use-timeline-scale";

export function TimelineTracks({
	document,
	facts,
	names,
	selectedId,
	positionMs,
	disabled,
	onSelect,
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
	positionMs: number;
	disabled: boolean;
	onSelect: (id: string) => void;
	onSeek: (position: number) => void;
	onChange: (next: VodInputTimelineDocument) => void;
	onDelete: (id: string) => void;
	onError: () => void;
	onDragging: (active: boolean) => void;
}) {
	const l = useTimelineLabels();
	const track = useRef<HTMLDivElement>(null);
	const viewport = useRef<HTMLDivElement>(null);
	const scale = useTimelineScale(viewport);
	const gesture = useTimelineGesture({
		document,
		facts,
		disabled,
		track,
		pixelsPerMs: scale.pixelsPerMs,
		onChange,
		onSelect,
		onError,
	});
	const total = timelineDuration(gesture.shown);
	const items = timelineItems(gesture.shown);
	const canvas = scale.canvas(Math.max(total, timelineDuration(document)));
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
					<label className="flex items-center gap-2">
						{l.zoom}
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
			<div className="flex min-w-0 gap-2">
				<div className="w-12 shrink-0 pt-7 text-xs text-zinc-400">
					<div className="flex h-16 items-center">V1</div>
					<div className="flex h-10 items-center">A1</div>
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
					>
						<TimelineRuler
							durationMs={total}
							positionMs={positionMs}
							pixelsPerMs={scale.pixelsPerMs}
							ticks={canvas.ticks}
							disabled={!total || gesture.dragging}
							onSeek={onSeek}
						/>
						<div className="flex h-16">
							{items.map(({ clip, startMs }, index) => (
								<TimelineClip
									key={clip.id}
									clip={clip}
									index={index}
									name={names[clip.sourceKey] ?? clip.sourceKey}
									pixelsPerMs={scale.pixelsPerMs}
									selected={selectedId === clip.id}
									fact={facts.find((source) => source.key === clip.sourceKey)}
									disabled={disabled}
									handlers={gesture.handlers}
									consumeClick={gesture.consumeClick}
									onSelect={onSelect}
									onSeek={(local) => onSeek(startMs + local)}
									onDelete={onDelete}
								/>
							))}
						</div>
						<fieldset
							className="flex h-10 min-w-0 border-zinc-800 border-t p-0"
							aria-label={l.linked}
						>
							{items.map(({ clip }) => (
								<button
									key={clip.id}
									type="button"
									onClick={() => onSelect(clip.id)}
									aria-label={`${l.audio}, ${names[clip.sourceKey] ?? clip.sourceKey}`}
									aria-pressed={selectedId === clip.id}
									className={`my-1 min-w-0 shrink-0 truncate border px-3 text-left text-[10px] ${document.audioEnabled ? "border-sky-800 bg-sky-950 text-sky-200" : "border-zinc-800 bg-zinc-900 text-zinc-500"}`}
									style={{
										width: (clip.outMs - clip.inMs) * scale.pixelsPerMs,
									}}
								>
									{document.audioEnabled
										? (names[clip.sourceKey] ?? clip.sourceKey)
										: l.noAudio}
								</button>
							))}
						</fieldset>
						{!!total && (
							<div
								aria-hidden="true"
								className="pointer-events-none absolute inset-y-0 z-20 border-amber-300 border-l-2"
								style={{
									left: Math.min(positionMs, total - 1) * scale.pixelsPerMs,
								}}
							/>
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
