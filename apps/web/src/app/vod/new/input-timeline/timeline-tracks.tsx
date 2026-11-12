"use client";

import type {
	VodInputTimelineDocument,
	VodInputTimelineSourceFacts,
} from "@bitovp/core/vod-input-timeline";
import { useEffect, useId, useRef, useState } from "react";
import { useTimelineLabels } from "./labels";
import { TimelineClip } from "./timeline-clip";
import { formatTime, timelineDuration, timelineItems } from "./timeline-state";
import { useTimelineGesture } from "./use-timeline-gesture";

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
	const helpId = useId();
	const track = useRef<HTMLDivElement>(null);
	const viewport = useRef<HTMLDivElement>(null);
	const [zoom, setZoom] = useState(1);
	const gesture = useTimelineGesture({
		document,
		facts,
		disabled,
		track,
		onChange,
		onSelect,
		onError,
	});
	const total = timelineDuration(gesture.shown);
	const items = timelineItems(gesture.shown);
	useEffect(() => onDragging(gesture.dragging), [gesture.dragging, onDragging]);
	useEffect(() => {
		const container = viewport.current,
			width = track.current?.clientWidth ?? 0;
		if (!container?.clientWidth || gesture.dragging || !total) return;
		const x = (positionMs / total) * width;
		if (zoom === 1) container.scrollLeft = 0;
		else if (
			x < container.scrollLeft ||
			x > container.scrollLeft + container.clientWidth - 20
		)
			container.scrollLeft = Math.max(0, x - container.clientWidth / 3);
	}, [positionMs, zoom, gesture.dragging, total]);
	const step =
		[1000, 5000, 10_000, 30_000, 60_000, 300_000, 900_000, 3_600_000].find(
			(value) => value >= total / (5 * zoom),
		) ?? 3_600_000;
	const ticks = Array.from(
		{ length: Math.ceil(total / step) },
		(_, index) => index * step,
	);
	return (
		<section
			aria-label={l.tracks}
			className="min-w-0 space-y-2 border-zinc-800 border-t pt-3"
		>
			<div className="flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-400">
				<span className="tabular-nums">
					{formatTime(positionMs)} / {formatTime(total)}
				</span>
				<label className="flex items-center gap-2">
					{l.zoom}
					<select
						aria-label={l.zoom}
						value={zoom}
						disabled={gesture.dragging}
						className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1"
						onChange={(event) => setZoom(Number(event.target.value))}
					>
						{[1, 2, 4, 8].map((value) => (
							<option value={value} key={value}>
								{value === 1 ? l.fit : `${value}×`}
							</option>
						))}
					</select>
				</label>
			</div>
			<div className="flex min-w-0 gap-2">
				<div className="w-12 shrink-0 pt-7 text-xs text-zinc-400">
					<div className="flex h-16 items-center">V1</div>
					<div className="flex h-10 items-center">A1</div>
				</div>
				<div
					ref={viewport}
					className="min-w-0 flex-1 overflow-x-auto overscroll-x-contain"
				>
					<div
						ref={track}
						data-testid="input-timeline-track"
						className="relative min-w-64"
						style={{ width: `${zoom * 100}%` }}
					>
						<div
							className="relative h-7 border-zinc-800 border-b text-[10px] text-zinc-400"
							aria-hidden="true"
						>
							{ticks.map((value) => (
								<span
									key={value}
									className="absolute bottom-1 whitespace-nowrap border-zinc-700 border-l pl-1 tabular-nums"
									style={{ left: `${(value / Math.max(1, total)) * 100}%` }}
								>
									{formatTime(value)}
								</span>
							))}
						</div>
						<div className="flex h-16">
							{items.map(({ clip, startMs }, index) => (
								<TimelineClip
									key={clip.id}
									clip={clip}
									index={index}
									name={names[clip.sourceKey] ?? clip.sourceKey}
									durationMs={total}
									selected={selectedId === clip.id}
									fact={facts.find((source) => source.key === clip.sourceKey)}
									disabled={disabled}
									helpId={helpId}
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
										width: `${((clip.outMs - clip.inMs) / total) * 100}%`,
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
									left: `${(Math.min(positionMs, total - 1) / total) * 100}%`,
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
			<details className="text-xs text-zinc-400">
				<summary className="w-fit cursor-pointer">{l.help}</summary>
				<p id={helpId} className="mt-1 max-w-prose">
					{l.helpText}
				</p>
			</details>
		</section>
	);
}
