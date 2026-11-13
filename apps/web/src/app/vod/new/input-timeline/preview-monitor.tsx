"use client";

import type { VodInputPreviewTask } from "@bitovp/core/vod-input-timeline";
import { useEffect, useRef } from "react";
import { useDocumentOrganization } from "@/components/providers";
import { Button } from "@/components/ui/button";
import { bindPassiveRequestUrl } from "@/lib/passive-request";
import { useTimelineLabels } from "./labels";
import { formatTime } from "./timeline-state";

export function PreviewMonitor({
	task,
	stale,
	pending,
	mode,
	positionMs,
	durationMs,
	whole,
	fullAllowed,
	onMode,
	onPosition,
	onSeek,
	onWhole,
	onError,
}: {
	task: VodInputPreviewTask | null;
	stale: boolean;
	pending: boolean;
	mode: "source" | "sequence";
	positionMs: number;
	durationMs: number;
	whole: boolean;
	fullAllowed: boolean;
	onMode: (mode: "source" | "sequence") => void;
	onPosition: (position: number) => void;
	onSeek: (position: number) => void;
	onWhole: (whole: boolean) => void;
	onError: () => void;
}) {
	const l = useTimelineLabels();
	const video = useRef<HTMLVideoElement>(null);
	const range = task?.result?.preview;
	const organizationId = useDocumentOrganization();
	const contentUrl =
		task?.kind === "PREVIEW" && task.status === "SUCCEEDED" && organizationId
			? bindPassiveRequestUrl(
					`/api/vod/input-previews/${task.id}/content`,
					organizationId,
				)
			: undefined;
	useEffect(() => {
		const element = video.current;
		if (element && stale && !element.paused) element.pause();
	}, [stale]);
	useEffect(() => {
		const element = video.current;
		if (!element || !range || stale) return;
		const target = (positionMs - range.startMs) / 1000;
		if (
			target >= 0 &&
			target < range.durationMs / 1000 &&
			Math.abs(element.currentTime - target) > 0.05
		)
			element.currentTime = target;
	}, [positionMs, range, stale]);
	return (
		<section className="min-w-0 space-y-2">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<div className="flex flex-wrap gap-1">
					{(["source", "sequence"] as const).map((value) => (
						<Button
							key={value}
							size="sm"
							variant={mode === value ? "secondary" : "ghost"}
							aria-pressed={mode === value}
							onClick={() => onMode(value)}
						>
							{l[value]}
						</Button>
					))}
					<Button
						size="sm"
						variant="ghost"
						data-preview-play
						aria-label={l.play}
						disabled={!contentUrl || stale}
						onClick={() => {
							const element = video.current;
							if (!element) return;
							if (element.paused) void element.play().catch(onError);
							else element.pause();
						}}
					>
						▶ / Ⅱ
					</Button>
				</div>
				<span role="status" className="text-xs text-zinc-400">
					{pending ? l.updating : stale ? l.stale : range ? l.ready : ""}
				</span>
			</div>
			<div className="relative flex aspect-video items-center justify-center overflow-hidden rounded border border-zinc-800 bg-zinc-950">
				{/* biome-ignore lint/a11y/useMediaCaption: Raw input preview has no authored caption track; no transcript is fabricated. */}
				<video
					ref={video}
					aria-label={l.preview}
					controls={!!contentUrl && !stale}
					playsInline
					preload="metadata"
					className="h-full w-full object-contain"
					src={contentUrl}
					onError={() => task && onError()}
					onTimeUpdate={() => {
						if (!stale && range && video.current)
							onPosition(
								range.startMs + Math.round(video.current.currentTime * 1000),
							);
					}}
				/>
				{!task && (
					<span className="pointer-events-none absolute text-xs text-zinc-400">
						{pending ? l.updating : l.preview}
					</span>
				)}
				{stale && (
					<span className="pointer-events-none absolute top-2 left-2 rounded bg-zinc-950/90 px-2 py-1 text-xs text-amber-300">
						{l.stale}
					</span>
				)}
			</div>
			{mode === "source" && (
				<label className="block text-xs text-zinc-400">
					{l.sourcePosition}
					<input
						aria-label={l.sourcePosition}
						type="range"
						min={0}
						max={Math.max(0, durationMs - 1)}
						step={1}
						value={Math.min(positionMs, Math.max(0, durationMs - 1))}
						disabled={!durationMs}
						className="mt-1 block w-full accent-emerald-400"
						onChange={(event) => onSeek(Number(event.target.value))}
					/>
				</label>
			)}
			<div className="flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-400">
				<span className="tabular-nums">
					{range
						? `${formatTime(range.startMs)} – ${formatTime(range.startMs + range.durationMs)}`
						: "—"}
				</span>
				<label
					className="flex items-center gap-2"
					title={!fullAllowed ? l.fullLimit : undefined}
				>
					<input
						type="checkbox"
						checked={whole && fullAllowed}
						disabled={!fullAllowed}
						onChange={(event) => onWhole(event.target.checked)}
						className="accent-emerald-500"
					/>
					{l.whole}
				</label>
			</div>
		</section>
	);
}
