"use client";

import { Play, Slash } from "lucide-react";
import Image from "next/image";
import { Tooltip as TooltipPrimitive } from "radix-ui";
import { type KeyboardEvent, useEffect, useState } from "react";
import {
	formatMomentTime,
	layoutMomentTracks,
} from "@/lib/aisa-live/timeline-layout";
import { useT } from "@/lib/i18n/context";
import { AisaMomentInfo, type AisaTimelineItem } from "./aisa-live-moment-info";
import { requestAisaThumbnail } from "./aisa-live-player-thumbnail";
import { momentPlaybackIdentity } from "./aisa-recording-scope";

function MomentOverlay({
	item,
	url,
	origin,
}: {
	item: AisaTimelineItem;
	url: string;
	origin: number;
}) {
	const { t } = useT();
	const [poster, setPoster] = useState<string | null>(null);
	const identity = momentPlaybackIdentity(url, origin, item.moment);
	useEffect(() => {
		if (!item.playable || !url) return;
		const abort = new AbortController();
		void requestAisaThumbnail(
			{
				kind: "HLS",
				url,
				origin,
				time: item.moment.anchorInSeconds,
				moment: item.moment,
				cacheKey: identity,
			},
			abort.signal,
		).then((frame) => {
			if (!abort.signal.aborted) setPoster(frame);
		});
		return () => abort.abort();
	}, [identity, item.playable, item.moment, url, origin]);
	return (
		<div className="space-y-3">
			{poster ? (
				<Image
					src={poster}
					alt={t("aisaLive.previewThumbnail")}
					width={320}
					height={180}
					unoptimized
					className="aspect-video w-full rounded object-contain"
				/>
			) : null}
			<AisaMomentInfo item={item} compact />
			<p className="text-xs text-zinc-400">
				{t(
					item.playable === true
						? "aisaLive.timelinePlayable"
						: item.playable === false
							? "aisaLive.timelineOutside"
							: "aisaLive.timelineRecordingUnknown",
				)}
			</p>
		</div>
	);
}

function moveFocus(event: KeyboardEvent<HTMLButtonElement>) {
	if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
	const nodes = [
		...(event.currentTarget
			.closest("[data-aisa-timeline-track]")
			?.querySelectorAll<HTMLButtonElement>(
				"button[data-aisa-timeline-moment]",
			) ?? []),
	];
	const index = nodes.indexOf(event.currentTarget);
	const next =
		event.key === "Home"
			? 0
			: event.key === "End"
				? nodes.length - 1
				: Math.max(
						0,
						Math.min(
							nodes.length - 1,
							index + (event.key === "ArrowRight" ? 1 : -1),
						),
					);
	event.preventDefault();
	nodes[next]?.focus();
}

export function AisaTimelineTrack({
	items,
	duration,
	windows,
	selectedId,
	url,
	origin,
	onSelect,
}: {
	items: AisaTimelineItem[];
	duration: number;
	windows: { start: number; end: number }[];
	selectedId: string | null;
	url: string;
	origin: number;
	onSelect: (item: AisaTimelineItem) => void;
}) {
	const { t } = useT();
	const layout = layoutMomentTracks(
		items.map((item) => item.moment),
		duration,
	);
	const byId = new Map(items.map((item) => [item.moment.id, item]));
	const pct = (time: number) =>
		Math.max(0, Math.min(100, (time / duration) * 100));
	return (
		<div className="max-w-full overflow-x-auto rounded-md border border-zinc-800 bg-zinc-950">
			<fieldset
				className="min-w-168 p-4"
				aria-label={t("aisaLive.timelineLabel")}
				data-aisa-timeline-track
			>
				<div
					className="relative mb-2 h-4 text-xs tabular-nums text-zinc-500"
					aria-hidden="true"
				>
					{Array.from({ length: 5 }, (_, index) => (
						<span
							key={index}
							className="absolute"
							style={{
								left: `${index * 25}%`,
								transform: `translateX(${index === 0 ? 0 : index === 4 ? -100 : -50}%)`,
							}}
						>
							{formatMomentTime((duration * index) / 4).split(".")[0]}
						</span>
					))}
				</div>
				<div
					className="relative"
					style={{ height: Math.max(1, layout.lanes) * 36 + 16 }}
				>
					<div
						className="absolute inset-x-0 top-0 h-1 rounded bg-zinc-800"
						aria-hidden="true"
					/>
					{windows.map((window) => (
						<div
							key={`${window.start}:${window.end}`}
							className="absolute top-0 h-1 bg-emerald-500/70"
							style={{
								left: `${pct(window.start)}%`,
								width: `${Math.max(0, pct(window.end) - pct(window.start))}%`,
							}}
							aria-hidden="true"
						/>
					))}
					<TooltipPrimitive.Provider delayDuration={180}>
						{layout.moments.map((marker) => {
							const item = byId.get(marker.id);
							if (!item) return null;
							const state = t(
								item.playable === true
									? "aisaLive.timelinePlayable"
									: item.playable === false
										? "aisaLive.timelineOutside"
										: "aisaLive.timelineRecordingUnknown",
							);
							const tone =
								item.playable === true
									? "border-emerald-700 bg-emerald-950 text-emerald-300 hover:bg-emerald-900"
									: item.playable === false
										? "border-zinc-700 bg-zinc-900 text-zinc-400 hover:bg-zinc-800"
										: "border-amber-800 bg-zinc-900 text-amber-300";
							return (
								<TooltipPrimitive.Root key={marker.id}>
									<div
										className="pointer-events-none absolute h-3 border-l border-zinc-400"
										style={{
											left: `${marker.anchorPercent}%`,
											top: marker.lane * 36 + 10,
										}}
										aria-hidden="true"
									/>
									<div
										className={`absolute h-0.5 ${item.playable ? "bg-emerald-600/60" : "bg-zinc-600"}`}
										style={{
											left: `${marker.startPercent}%`,
											width: `${marker.endPercent - marker.startPercent}%`,
											top: marker.lane * 36 + 31,
										}}
										aria-hidden="true"
									/>
									<TooltipPrimitive.Trigger asChild>
										<button
											type="button"
											data-aisa-timeline-moment={marker.id}
											data-playable={
												item.playable === null
													? "unknown"
													: String(item.playable)
											}
											aria-label={t("aisaLive.timelineMomentLabel", {
												time: formatMomentTime(item.moment.anchorInSeconds),
												level: item.moment.importanceLevel,
												state,
											})}
											aria-pressed={selectedId === marker.id}
											onClick={() => onSelect(item)}
											onKeyDown={moveFocus}
											className={`absolute flex h-8 min-w-0 items-center justify-center gap-0.5 rounded border text-xs tabular-nums focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-emerald-400 focus-visible:outline-offset-2 ${tone} ${selectedId === marker.id ? "ring-2 ring-zinc-200" : ""}`}
											style={{
												left: `${marker.hitLeftPercent}%`,
												width: `${marker.hitWidthPercent}%`,
												top: marker.lane * 36 + 16,
											}}
										>
											{item.playable === true ? (
												<Play
													className="size-2.5 shrink-0"
													aria-hidden="true"
												/>
											) : item.playable === false ? (
												<Slash
													className="size-2.5 shrink-0"
													aria-hidden="true"
												/>
											) : null}
											<span className="truncate" aria-hidden="true">
												{item.moment.importanceLevel}
											</span>
										</button>
									</TooltipPrimitive.Trigger>
									<TooltipPrimitive.Portal>
										<TooltipPrimitive.Content
											side="top"
											sideOffset={8}
											collisionPadding={12}
											aria-label={`${formatMomentTime(item.moment.startInSeconds)} ${t("aisaLive.importance", { level: item.moment.importanceLevel })}. ${item.descriptions.map((description) => description.text).join(" ")}. ${state}`}
											className="z-50 w-72 max-w-[calc(100vw-1.5rem)] rounded-md border border-zinc-700 bg-zinc-900 p-3 shadow-xl"
										>
											<MomentOverlay
												key={momentPlaybackIdentity(url, origin, item.moment)}
												item={item}
												url={url}
												origin={origin}
											/>
											<TooltipPrimitive.Arrow className="fill-zinc-700" />
										</TooltipPrimitive.Content>
									</TooltipPrimitive.Portal>
								</TooltipPrimitive.Root>
							);
						})}
					</TooltipPrimitive.Provider>
				</div>
			</fieldset>
		</div>
	);
}
