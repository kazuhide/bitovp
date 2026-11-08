"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useT } from "@/lib/i18n/context";
import { type TrimEdge, timelineTimecode } from "../timeline-model";
import { TimelineClip } from "./timeline-clip";
import { type TimelineProps, useTimelineTrim } from "./use-timeline-trim";

export function VisualTimeline(props: TimelineProps) {
	const {
		map,
		positionFrame,
		selectedClipId,
		disabled,
		rangePending,
		onSeek,
		onSelectClip,
	} = props;
	const { t } = useT();
	const helpId = useId();
	const track = useRef<HTMLDivElement>(null);
	const viewport = useRef<HTMLElement>(null);
	const [zoom, setZoom] = useState(1);
	const { shown, dragging, activeIndex, error, trimHandlers } = useTimelineTrim(
		props,
		track,
	);
	const total = shown.clips.reduce((sum, clip) => sum + clip.durationFrames, 0);
	const cursor = Math.max(0, Math.min(total - 1, positionFrame));
	useEffect(() => {
		const container = viewport.current;
		const width = track.current?.clientWidth ?? 0;
		if (!container?.clientWidth || dragging) return;
		if (zoom === 1 && width <= container.clientWidth) {
			container.scrollLeft = 0;
			return;
		}
		const x = (cursor / total) * width;
		const margin = Math.min(24, container.clientWidth / 4);
		if (
			x < container.scrollLeft + margin ||
			x > container.scrollLeft + container.clientWidth - margin
		)
			container.scrollLeft = Math.max(
				0,
				Math.min(width - container.clientWidth, x - container.clientWidth / 3),
			);
	}, [cursor, total, zoom, dragging]);
	const selectedIndex = shown.clips.findIndex(
		(clip) => clip.id === selectedClipId,
	);
	const selected =
		activeIndex ??
		(selectedIndex >= 0
			? selectedIndex
			: shown.clips.findIndex(
					(clip) => cursor < clip.timelineStartFrame + clip.durationFrames,
				));
	function selectClip(index: number) {
		const clip = shown.clips[index];
		if (clip) onSelectClip(clip.id);
	}
	function selectPosition(frame: number) {
		const target = Math.max(0, Math.min(total - 1, frame));
		selectClip(
			shown.clips.findIndex(
				(clip) => target < clip.timelineStartFrame + clip.durationFrames,
			),
		);
		onSeek(target);
	}
	function editingHandlers(index: number, edge: TrimEdge) {
		const handlers = trimHandlers(index, edge);
		return {
			...handlers,
			onFocus: () => selectClip(index),
			onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => {
				selectClip(index);
				handlers.onKeyDown(event);
			},
		};
	}
	const step =
		[1, 5, 15, 30, 60, 150, 300, 600, 900, 1800].find(
			(value) => value >= total / (4 * zoom),
		) ?? 1800;
	const ticks = Array.from(
		{ length: Math.ceil(total / step) },
		(_, i) => i * step,
	).filter((frame) => frame === 0 || (frame > step && total - frame > step));
	ticks.push(total);
	return (
		<div className="min-w-0 space-y-2 rounded-md border border-zinc-800 p-3">
			<div className="flex flex-wrap items-center justify-between gap-2 text-xs">
				<span className="tabular-nums">
					{t("editing.timelineCursor", {
						time: timelineTimecode(cursor),
						frame: cursor,
					})}
				</span>
				<label className="flex items-center gap-2">
					{t("editing.timelineZoom")}
					<select
						className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1"
						value={zoom}
						disabled={dragging}
						onChange={(event) => setZoom(Number(event.target.value))}
					>
						{[1, 2, 4, 8].map((value) => (
							<option key={value} value={value}>
								{value}×
							</option>
						))}
					</select>
				</label>
			</div>
			<section
				ref={viewport}
				className="max-w-full overflow-x-auto overscroll-x-contain"
				aria-label={t("editing.timeline")}
			>
				<div
					ref={track}
					data-testid="timeline-track"
					className="relative min-w-80 pb-2"
					style={{ width: `${zoom * 100}%` }}
				>
					<div
						className="relative h-7 border-zinc-700 border-b text-[10px] text-zinc-400"
						aria-hidden="true"
					>
						{ticks.map((frame) => (
							<span
								key={frame}
								className="absolute bottom-0 h-2 border-zinc-700 border-l"
								style={{
									left: `${(frame / total) * 100}%`,
								}}
							>
								<span
									className="absolute bottom-2 whitespace-nowrap tabular-nums"
									style={{
										transform:
											frame === 0
												? undefined
												: frame === total
													? "translateX(-100%)"
													: "translateX(-50%)",
									}}
								>
									{timelineTimecode(frame)}
								</span>
							</span>
						))}
					</div>
					<div className="relative flex h-16">
						{shown.clips.map((clip, index) => (
							<TimelineClip
								key={clip.id}
								clip={clip}
								index={index}
								total={total}
								selected={selected === index}
								map={map}
								mutationDisabled={disabled || (rangePending && !dragging)}
								helpId={helpId}
								onSeek={selectPosition}
								trimHandlers={editingHandlers}
							/>
						))}
						<div
							className="pointer-events-none absolute top-0 bottom-0 z-20 border-amber-300 border-l-2"
							style={{ left: `${(cursor / total) * 100}%` }}
							aria-hidden="true"
						/>
					</div>
				</div>
			</section>
			<label className="block text-xs text-zinc-400">
				{t("editing.timelineSeek")}
				<input
					type="range"
					min={0}
					max={Math.max(0, total - 1)}
					step={1}
					value={cursor}
					disabled={!map || dragging}
					className="mt-1 block w-full accent-emerald-400"
					onChange={(event) => selectPosition(Number(event.target.value))}
				/>
			</label>
			<p id={helpId} className="text-xs text-zinc-400">
				{t("editing.timelineHelp")}
			</p>
			{error && (
				<p role="alert" className="text-amber-300 text-xs">
					{t("editing.timelineTrimError")}
				</p>
			)}
		</div>
	);
}
