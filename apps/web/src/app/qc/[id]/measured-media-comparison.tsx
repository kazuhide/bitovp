"use client";

import { type ReactNode, useRef, useState } from "react";
import { useT } from "@/lib/i18n/context";
import { fmtScore } from "../vmaf-shared";
import { observePresentationOrigin } from "./presentation-origin";

export type ComparisonMedia = {
	id: string;
	label: string;
	url: string;
	endSeconds?: number;
};
export type ComparisonClock =
	| { kind: "frame"; fps: number; max: number }
	| { kind: "time"; timestamps: number[] };

const control =
	"rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-emerald-500";

/** Shared decoder lifecycle; each metric supplies its own clock and measured scores. */
export function MeasuredMediaComparison({
	candidates,
	clock,
	metric,
	initialIds,
	unavailableReason,
	scoreAt,
	renderChart,
}: {
	candidates: ComparisonMedia[];
	clock: ComparisonClock | null;
	metric: "VMAF" | "CAMBI";
	initialIds?: [string, string];
	unavailableReason: string;
	scoreAt: (id: string, position: number) => number | undefined;
	renderChart: (selection: {
		selectedPosition?: number;
		onPositionSelect: (position: number) => void;
	}) => ReactNode;
}) {
	const { t } = useT();
	const available = clock !== null && candidates.length > 0;
	const [open, setOpen] = useState(false);
	const [chosenIds, setIds] = useState<[string, string] | null>(null);
	const ids: [string, string] = chosenIds ??
		initialIds ?? [candidates[0]?.id ?? "", candidates[1]?.id ?? ""];
	const [position, setPosition] = useState(0);
	const [draft, setDraft] = useState<string | null>(null);
	const [playing, setPlaying] = useState(false);
	const [error, setError] = useState(false);
	const [failure, setFailure] = useState<"media" | "timing" | "range">("media");
	const [ready, setReady] = useState<Record<string, boolean>>({});
	const [limits, setLimits] = useState<Record<string, number>>({});
	const origins = useRef(new Map<string, number>());
	const releaseOrigins = useRef(new Map<string, () => void>());
	const seeks = useRef(new Map<string, { target: number; timeout: number }>());
	const videos = useRef(new Map<string, HTMLVideoElement>());
	const refs = useRef(
		new Map<string, (video: HTMLVideoElement | null) => void>(),
	);
	const pending = useRef(0);
	const operation = useRef(0);
	function updateLimit(id: string, video: HTMLVideoElement) {
		const origin = origins.current.get(id);
		if (origin === undefined) return;
		const span = video.duration - origin;
		if (Number.isFinite(span) && span > 0)
			setLimits((old) => (old[id] === span ? old : { ...old, [id]: span }));
	}
	function finishSeek(id: string, video: HTMLVideoElement) {
		if (!origins.current.has(id)) return;
		updateLimit(id, video);
		const request = seeks.current.get(id);
		if (request) {
			if (
				video.seeking ||
				video.readyState < 2 ||
				video.duration < request.target
			)
				return;
			if (Math.abs(video.currentTime - request.target) > 0.000001) {
				// MP4 duration can grow after the browser reads its tail. Retry a
				// clamped seek only when the requested presentation is available.
				video.currentTime = request.target;
				return;
			}
			window.clearTimeout(request.timeout);
			seeks.current.delete(id);
		}
		if (video.readyState >= 3)
			setReady((old) => (old[id] ? old : { ...old, [id]: true }));
	}
	function seekTime(id: string, video: HTMLVideoElement, seconds: number) {
		const origin = origins.current.get(id);
		if (origin === undefined) return;
		const previous = seeks.current.get(id);
		if (previous) window.clearTimeout(previous.timeout);
		const request: { target: number; timeout: number } = {
			target: origin + seconds,
			timeout: window.setTimeout(() => {
				if (seeks.current.get(id) === request) {
					seeks.current.delete(id);
					fail("range");
				}
			}, 10_000),
		};
		seeks.current.set(id, request);
		setReady((old) => ({ ...old, [id]: false }));
		video.currentTime = request.target;
		finishSeek(id, video);
	}
	function videoRef(candidate: ComparisonMedia) {
		let ref = refs.current.get(candidate.id);
		if (!ref) {
			ref = (video) => {
				if (video) {
					videos.current.set(candidate.id, video);
					if (clock?.kind === "time") {
						let failed = false;
						const timeout = window.setTimeout(() => {
							failed = true;
							fail("timing");
						}, 10_000);
						const cancel = observePresentationOrigin(
							video,
							(origin) => {
								if (failed) return;
								window.clearTimeout(timeout);
								if (
									!Number.isFinite(video.duration) ||
									video.duration <= origin
								)
									return fail("range");
								origins.current.set(candidate.id, origin);
								updateLimit(candidate.id, video);
								seekTime(candidate.id, video, pending.current);
							},
							() => {
								failed = true;
								window.clearTimeout(timeout);
								fail("timing");
							},
						);
						releaseOrigins.current.set(candidate.id, () => {
							window.clearTimeout(timeout);
							cancel();
						});
						if (failed) return;
					}
					// React Strict Mode reattaches the element after ref cleanup.
					if (video.getAttribute("src") !== candidate.url) {
						video.setAttribute("src", candidate.url);
						video.load();
					}
				} else {
					operation.current += 1;
					releaseOrigins.current.get(candidate.id)?.();
					releaseOrigins.current.delete(candidate.id);
					origins.current.delete(candidate.id);
					const request = seeks.current.get(candidate.id);
					if (request) window.clearTimeout(request.timeout);
					seeks.current.delete(candidate.id);
					const old = videos.current.get(candidate.id);
					old?.pause();
					old?.removeAttribute("src");
					old?.load();
					videos.current.delete(candidate.id);
				}
			};
			refs.current.set(candidate.id, ref);
		}
		return ref;
	}
	const selection = ids
		.map((id) => candidates.find((candidate) => candidate.id === id))
		.filter((item) => item !== undefined);
	const max =
		clock?.kind === "frame"
			? clock.max
			: selection.length
				? Math.min(
						...selection.map((item) => item.endSeconds ?? limits[item.id] ?? 0),
					)
				: 0;
	const timingReady =
		clock?.kind !== "time" ||
		selection.every((item) => origins.current.has(item.id));
	const secondsAt = (value: number) =>
		clock?.kind === "frame" ? (value + 0.5) / clock.fps : value;
	const previous =
		clock?.kind === "time"
			? clock.timestamps.filter((time) => time < position - 1e-9).at(-1)
			: position > 0
				? position - 1
				: undefined;
	const next =
		clock?.kind === "time"
			? clock.timestamps.find((time) => time > position + 1e-9 && time <= max)
			: position < max
				? position + 1
				: undefined;
	function pause() {
		operation.current += 1;
		for (const video of videos.current.values()) video.pause();
		setPlaying(false);
	}
	function seek(value: number) {
		setDraft(null);
		if (
			!Number.isFinite(value) ||
			value < 0 ||
			value > max ||
			!timingReady ||
			(clock?.kind === "frame" && !Number.isInteger(value))
		)
			return;
		pause();
		pending.current = value;
		setPosition(value);
		if (clock)
			for (const [id, video] of videos.current) {
				if (clock.kind === "time") seekTime(id, video, value);
				else if (video.readyState >= 1) video.currentTime = secondsAt(value);
			}
	}
	function fail(reason: "media" | "timing" | "range" = "media") {
		pause();
		setFailure(reason);
		setError(true);
	}
	async function play() {
		if (!clock || error || !selection.every((item) => ready[item.id])) return;
		if (clock.kind === "frame") seek(position);
		else
			for (const [id, video] of videos.current) {
				const origin = origins.current.get(id);
				if (origin === undefined) return fail("timing");
				video.currentTime = origin + position;
			}
		const token = operation.current;
		const elements = [...videos.current.values()];
		try {
			await Promise.all(elements.map((video) => video.play()));
			if (token === operation.current) setPlaying(true);
			else for (const video of elements) video.pause();
		} catch {
			if (token === operation.current) fail();
		}
	}
	return (
		<div className="mt-2 space-y-3">
			<div className="flex flex-wrap items-end gap-3">
				<button
					type="button"
					className={control}
					disabled={!available}
					aria-expanded={open}
					onClick={() => {
						pause();
						setOpen(!open);
						setError(false);
						setReady({});
					}}
				>
					{t(open ? "qc.previewClose" : "qc.previewOpen")}
				</button>
				{available ? (
					([0, 1] as const).map((slot) => (
						<label
							key={slot}
							className="grid w-full min-w-0 max-w-full gap-1 text-xs text-zinc-400 sm:w-auto"
						>
							{t(slot === 0 ? "qc.previewA" : "qc.previewB")}
							<select
								className={`${control} w-full min-w-0 max-w-full`}
								value={ids[slot]}
								onChange={(event) => {
									pause();
									setError(false);
									const id = event.target.value;
									setReady((old) => ({ ...old, [id]: false }));
									setIds(slot === 0 ? [id, ids[1]] : [ids[0], id]);
								}}
							>
								{slot === 1 ? (
									<option value="">{t("qc.previewNone")}</option>
								) : null}
								{candidates.map((candidate) => (
									<option
										key={candidate.id}
										value={candidate.id}
										disabled={ids[1 - slot] === candidate.id}
									>
										{candidate.label}
									</option>
								))}
							</select>
						</label>
					))
				) : (
					<p className="text-xs text-zinc-400">{unavailableReason}</p>
				)}
			</div>
			{open && available ? (
				<section
					aria-label={t("qc.previewOpen")}
					className="space-y-3 rounded-lg border border-zinc-800 bg-zinc-950 p-3"
				>
					<div className="grid gap-3 md:grid-cols-2">
						{selection.map((candidate) => {
							const score = scoreAt(candidate.id, position);
							return (
								<figure key={candidate.id} className="min-w-0">
									<video
										muted
										playsInline
										preload={clock.kind === "time" ? "auto" : "metadata"}
										aria-label={candidate.label}
										className="aspect-video w-full bg-black object-contain"
										src={clock.kind === "frame" ? candidate.url : undefined}
										ref={videoRef(candidate)}
										onLoadedMetadata={(event) => {
											if (clock.kind === "frame")
												event.currentTarget.currentTime = secondsAt(
													pending.current,
												);
											else finishSeek(candidate.id, event.currentTarget);
										}}
										onCanPlay={(event) => {
											if (clock.kind === "frame")
												setReady((old) => ({ ...old, [candidate.id]: true }));
											else finishSeek(candidate.id, event.currentTarget);
										}}
										onDurationChange={(event) => {
											if (clock.kind === "time")
												finishSeek(candidate.id, event.currentTarget);
										}}
										onSeeked={(event) => {
											if (clock.kind === "time")
												finishSeek(candidate.id, event.currentTarget);
										}}
										onError={() => fail()}
										onEnded={pause}
										onTimeUpdate={(event) => {
											if (!playing || candidate.id !== ids[0]) return;
											const mediaTime = event.currentTarget.currentTime;
											const origin =
												clock.kind === "time"
													? origins.current.get(candidate.id)
													: 0;
											if (origin === undefined) return fail("timing");
											const time = mediaTime - origin;
											const value = Math.min(
												max,
												Math.max(
													0,
													clock.kind === "frame"
														? Math.floor(time * clock.fps)
														: time,
												),
											);
											pending.current = value;
											setPosition(value);
											for (const [id, video] of videos.current) {
												const otherOrigin =
													clock.kind === "time" ? origins.current.get(id) : 0;
												if (otherOrigin === undefined) return fail("timing");
												const target = time + otherOrigin;
												if (
													id !== candidate.id &&
													video.readyState >= 2 &&
													Math.abs(video.currentTime - target) > 0.08
												)
													video.currentTime = target;
											}
										}}
									/>

									<figcaption className="mt-1 text-xs text-zinc-400">
										{candidate.label} · {metric}{" "}
										{score !== undefined && Number.isFinite(score)
											? fmtScore(score)
											: t("qc.previewNoScore")}
									</figcaption>
								</figure>
							);
						})}
					</div>
					<div className="flex flex-wrap items-end gap-2">
						<button
							type="button"
							className={control}
							disabled={error || !selection.every((item) => ready[item.id])}
							onClick={() => (playing ? pause() : void play())}
						>
							{t(playing ? "qc.previewPause" : "qc.previewPlay")}
						</button>
						<button
							type="button"
							className={control}
							disabled={!timingReady || previous === undefined}
							onClick={() => previous !== undefined && seek(previous)}
						>
							{t(
								clock.kind === "frame"
									? "qc.previewPrevious"
									: "banding.previewPrevious",
							)}
						</button>
						<label className="grid gap-1 text-xs text-zinc-400">
							{t(
								clock.kind === "frame"
									? "qc.previewFrame"
									: "banding.previewTime",
							)}
							<input
								type="number"
								disabled={!timingReady}
								min={0}
								max={max}
								step={clock.kind === "frame" ? 1 : "any"}
								value={
									draft ??
									(clock.kind === "frame"
										? position
										: Number(position.toFixed(3)))
								}
								className={`${control} w-32`}
								onChange={(event) => {
									pause();
									setDraft(event.target.value);
								}}
								onBlur={(event) => {
									if (event.target.value.trim() !== "")
										seek(Number(event.target.value));
									else setDraft(null);
								}}
								onKeyDown={(event) => {
									if (event.key === "Enter") event.currentTarget.blur();
								}}
							/>
						</label>
						<button
							type="button"
							className={control}
							disabled={!timingReady || next === undefined}
							onClick={() => next !== undefined && seek(next)}
						>
							{t(
								clock.kind === "frame"
									? "qc.previewNext"
									: "banding.previewNext",
							)}
						</button>
						<span className="text-xs text-zinc-400">
							{clock.kind === "frame"
								? t("qc.previewTiming", {
										frame: position,
										fps: Number(clock.fps.toFixed(4)),
										seconds: (position / clock.fps).toFixed(3),
									})
								: t("banding.previewTiming", { seconds: position.toFixed(3) })}
						</span>
					</div>
					{error ? (
						<p role="alert" className="text-red-400 text-sm">
							{t(
								failure === "timing"
									? "banding.previewTimingUnavailable"
									: failure === "range"
										? "banding.previewRangeUnavailable"
										: "qc.previewFailed",
							)}
						</p>
					) : !selection.every((item) => ready[item.id]) ? (
						<p role="status" className="text-xs text-zinc-400">
							{t("qc.previewLoading")}
						</p>
					) : null}
					<p className="text-xs text-zinc-500">
						{t(
							metric === "VMAF" ? "qc.previewCaveat" : "banding.previewCaveat",
						)}
					</p>
				</section>
			) : null}
			{renderChart({
				selectedPosition: open ? position : undefined,
				onPositionSelect: seek,
			})}
		</div>
	);
}
