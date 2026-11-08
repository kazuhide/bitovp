"use client";
import {
	type CompositionDocument,
	type CompositionSourceFacts,
	moveCompositionClip,
	originalTimeToCfrFrame,
	resolveCompositionCaptionDisplay,
	trimCompositionClip,
} from "@bitovp/core";
import { useRef, useState } from "react";
import { useCompositionCopy } from "./composition-copy";

type Drag = {
	id: string;
	mode: "MOVE" | "IN" | "OUT";
	x: number;
	delta: number;
};
export function CompositionTimeline({
	document,
	sources,
	duration,
	selectedId,
	frame,
	disabled,
	onSelect,
	onFrame,
	onChange,
	onError,
}: {
	document: CompositionDocument;
	sources: CompositionSourceFacts[];
	duration: number;
	selectedId: string;
	frame: number;
	disabled: boolean;
	onSelect: (id: string) => void;
	onFrame: (frame: number) => void;
	onChange: (document: CompositionDocument) => void;
	onError: () => void;
}) {
	const c = useCompositionCopy(),
		[zoom, setZoom] = useState(48),
		[drag, setDrag] = useState<Drag | null>(null),
		dragging = useRef<Drag | null>(null);
	const perFrame = zoom / 30,
		width = Math.max(720, duration * perFrame + 60),
		tracks = document.videoTracks ?? [{ id: "main", name: c.clips, order: 0 }];
	function apply(id: string, mode: Drag["mode"], delta: number) {
		const clip = document.clips.find((item) => item.id === id);
		if (!clip || !delta || disabled) return;
		try {
			if (mode === "MOVE")
				onChange(
					moveCompositionClip(document, id, {
						timelineStartFrame: Math.max(0, clip.timelineStartFrame + delta),
					}),
				);
			else if (mode === "IN") {
				const source = sources.find(
					(item) =>
						item.mediaVersionId ===
						(clip.mediaVersionId ?? document.mediaVersionId),
				);
				if (!source) throw new Error("Missing source");
				const start = source.timeMap.sourceStartUs;
				const sourceFrame =
					Number(originalTimeToCfrFrame(clip.sourceInUs, start, "FLOOR")) +
					delta;
				const next = trimCompositionClip(
					document,
					id,
					{
						sourceInUs: start + Math.ceil((sourceFrame * 1_000_000) / 30),
						durationFrames: clip.durationFrames - delta,
					},
					sources,
				);
				onChange(
					moveCompositionClip(next, id, {
						timelineStartFrame: Math.max(0, clip.timelineStartFrame + delta),
					}),
				);
			} else
				onChange(
					trimCompositionClip(
						document,
						id,
						{
							sourceInUs: clip.sourceInUs,
							durationFrames: clip.durationFrames + delta,
						},
						sources,
					),
				);
		} catch {
			onError();
		}
	}
	function start(
		event: React.PointerEvent<HTMLButtonElement>,
		id: string,
		mode: Drag["mode"],
	) {
		if (disabled || event.button !== 0) return;
		onSelect(id);
		event.currentTarget.setPointerCapture(event.pointerId);
		const next = { id, mode, x: event.clientX, delta: 0 };
		dragging.current = next;
		setDrag(next);
	}
	return (
		<section
			className="min-w-0 space-y-3 rounded-xl border border-zinc-800 bg-zinc-950 p-4"
			aria-label={c.clips}
		>
			<div className="flex flex-wrap items-center justify-between gap-3">
				<h2 className="font-medium text-sm">{c.clips}</h2>
				<label className="flex shrink-0 items-center gap-2 whitespace-nowrap text-xs text-zinc-400">
					{c.zoomShort}
					<input
						type="range"
						aria-label={c.zoom}
						min={24}
						max={180}
						value={zoom}
						className="w-28 max-w-full"
						onChange={(event) => setZoom(Number(event.target.value))}
					/>
				</label>
			</div>
			<div className="overflow-x-auto rounded-md border border-zinc-800">
				<div style={{ width }} className="relative pb-2">
					<div className="relative h-7 border-zinc-800 border-b font-mono text-[10px] text-zinc-500">
						{Array.from(
							{ length: Math.ceil(duration / 30) + 1 },
							(_, second) => second,
						)
							.filter((second) => second % (zoom < 36 ? 5 : 1) === 0)
							.map((second) => (
								<span
									key={second}
									className="absolute top-1"
									style={{ left: second * zoom + 4 }}
								>
									{second}s
								</span>
							))}
					</div>
					{[...tracks]
						.sort((a, b) => b.order - a.order)
						.map((track) => (
							<div
								key={track.id}
								className="relative h-[70px] border-zinc-800 border-b"
							>
								<button
									type="button"
									className="absolute inset-0 w-full text-left"
									aria-label={`${track.name} · ${c.position}`}
									onClick={(event) =>
										onFrame(
											Math.min(
												duration - 1,
												Math.max(
													0,
													Math.round(
														(event.clientX -
															event.currentTarget.getBoundingClientRect()
																.left) /
															perFrame,
													),
												),
											),
										)
									}
								>
									<span className="pointer-events-none absolute right-2 bottom-1 text-[10px] text-zinc-600">
										{track.name}
									</span>
								</button>
								{document.clips
									.filter((clip) => (clip.trackId ?? "main") === track.id)
									.map((clip, index) => {
										const delta = drag?.id === clip.id ? drag.delta : 0,
											startFrame =
												clip.timelineStartFrame +
												(drag?.id === clip.id && drag.mode !== "OUT"
													? delta
													: 0),
											frames =
												clip.durationFrames +
												(drag?.id === clip.id
													? drag.mode === "IN"
														? -delta
														: drag.mode === "OUT"
															? delta
															: 0
													: 0);
										const handler = (mode: Drag["mode"]) => ({
											onPointerDown: (
												event: React.PointerEvent<HTMLButtonElement>,
											) => start(event, clip.id, mode),
											onPointerMove: (
												event: React.PointerEvent<HTMLButtonElement>,
											) => {
												if (
													!dragging.current ||
													dragging.current.id !== clip.id
												)
													return;
												const next = {
													...dragging.current,
													delta: Math.round(
														(event.clientX - dragging.current.x) / perFrame,
													),
												};
												dragging.current = next;
												setDrag(next);
											},
											onPointerUp: (
												event: React.PointerEvent<HTMLButtonElement>,
											) => {
												const active = dragging.current;
												dragging.current = null;
												setDrag(null);
												if (
													event.currentTarget.hasPointerCapture(event.pointerId)
												)
													event.currentTarget.releasePointerCapture(
														event.pointerId,
													);
												if (active) apply(active.id, active.mode, active.delta);
											},
											onPointerCancel: () => {
												dragging.current = null;
												setDrag(null);
											},
											onKeyDown: (
												event: React.KeyboardEvent<HTMLButtonElement>,
											) => {
												if (event.key === "Escape") {
													dragging.current = null;
													setDrag(null);
												}
												if (
													event.key === "ArrowLeft" ||
													event.key === "ArrowRight"
												) {
													event.preventDefault();
													onSelect(clip.id);
													apply(
														clip.id,
														mode,
														(event.key === "ArrowLeft" ? -1 : 1) *
															(event.shiftKey ? 30 : 1),
													);
												}
											},
										});
										return (
											<div
												key={clip.id}
												className={`absolute top-2 h-12 min-w-3 rounded border ${selectedId === clip.id ? "border-emerald-300 bg-emerald-900 ring-1 ring-emerald-400" : "border-zinc-600 bg-zinc-800"}`}
												style={{
													left: Math.max(0, startFrame) * perFrame,
													width: Math.max(8, frames * perFrame),
												}}
											>
												<button
													type="button"
													className="h-full w-full touch-none overflow-hidden px-3 text-left text-xs"
													aria-label={`${c.selected} ${index + 1}`}
													aria-pressed={selectedId === clip.id}
													onClick={(event) => {
														onSelect(clip.id);
														if (!drag)
															onFrame(
																Math.max(
																	clip.timelineStartFrame,
																	Math.min(
																		clip.timelineStartFrame +
																			clip.durationFrames -
																			1,
																		clip.timelineStartFrame +
																			Math.floor(
																				(event.clientX -
																					event.currentTarget.getBoundingClientRect()
																						.left) /
																					perFrame,
																			),
																	),
																),
															);
													}}
													{...handler("MOVE")}
												>
													<span className="block truncate">
														{index + 1} ·{" "}
														{(clip.sourceInUs / 1_000_000).toFixed(1)}s
													</span>
													<span className="text-zinc-400">
														{(clip.durationFrames / 30).toFixed(1)}s
														{clip.transitionIn ? " ◈" : ""}
													</span>
												</button>
												{(["IN", "OUT"] as const).map((mode) => (
													<button
														key={mode}
														type="button"
														disabled={disabled}
														aria-label={`${mode === "IN" ? c.sourceIn : c.duration} ${index + 1}`}
														className={`absolute top-0 h-full w-2 touch-none cursor-ew-resize rounded bg-white/20 focus-visible:bg-emerald-300 ${mode === "IN" ? "left-0" : "right-0"}`}
														{...handler(mode)}
													/>
												))}
											</div>
										);
									})}
							</div>
						))}
					{(document.audioTracks?.length ?? 0) > 0 && (
						<div className="relative h-9 border-zinc-800 border-b">
							{document.audioTracks?.map((track) => (
								<div
									key={track.id}
									className="absolute top-1 h-6 truncate rounded bg-sky-950 px-2 text-[10px] text-sky-200"
									style={{
										left: track.timelineStartFrame * perFrame,
										width: track.durationFrames * perFrame,
									}}
								>
									{c.audio}
								</div>
							))}
						</div>
					)}
					{(document.captions?.length ?? 0) > 0 && (
						<div className="relative h-9">
							{document.captions?.map((caption) => (
								<button
									key={caption.id}
									type="button"
									onClick={() => onFrame(caption.fromFrame)}
									className="absolute top-1 h-6 truncate rounded bg-amber-950 px-2 text-[10px] text-amber-200"
									style={{
										left: caption.fromFrame * perFrame,
										width: (caption.toFrame - caption.fromFrame) * perFrame,
									}}
								>
									{
										resolveCompositionCaptionDisplay(
											caption,
											document.captionDisplayLanguage,
										).text
									}
								</button>
							))}
						</div>
					)}
					<div
						className="pointer-events-none absolute top-0 bottom-0 w-px bg-rose-400"
						style={{ left: frame * perFrame }}
					>
						<span className="absolute -left-1 top-0 h-2 w-2 rotate-45 bg-rose-400" />
					</div>
				</div>
			</div>
		</section>
	);
}
