"use client";

import { type ReactNode, useRef, useState } from "react";
import { useT } from "@/lib/i18n/context";
import { fmtScore } from "../vmaf-shared";

export type ComparisonMedia = { id: string; label: string; url: string };
export type ComparisonClock =
	| { kind: "frame"; fps: number; max: number }
	| { kind: "time"; timestamps: number[]; max: number };

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
	const [ready, setReady] = useState<Record<string, boolean>>({});
	const videos = useRef(new Map<string, HTMLVideoElement>());
	const refs = useRef(
		new Map<string, (video: HTMLVideoElement | null) => void>(),
	);
	const pending = useRef(0);
	const operation = useRef(0);
	function videoRef(candidate: ComparisonMedia) {
		let ref = refs.current.get(candidate.id);
		if (!ref) {
			ref = (video) => {
				if (video) {
					videos.current.set(candidate.id, video);
					// React Strict Mode reattaches the element after ref cleanup.
					if (video.getAttribute("src") !== candidate.url) {
						video.setAttribute("src", candidate.url);
						video.load();
					}
				} else {
					operation.current += 1;
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
	const max = clock?.max ?? 0;
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
			? clock.timestamps.find((time) => time > position + 1e-9)
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
			(clock?.kind === "frame" && !Number.isInteger(value))
		)
			return;
		pause();
		pending.current = value;
		setPosition(value);
		if (clock)
			for (const video of videos.current.values()) {
				if (video.readyState >= 1) video.currentTime = secondsAt(value);
			}
	}
	function fail() {
		pause();
		setError(true);
	}
	async function play() {
		if (!clock || error || !selection.every((item) => ready[item.id])) return;
		seek(position);
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
										preload="metadata"
										aria-label={candidate.label}
										className="aspect-video w-full bg-black object-contain"
										src={candidate.url}
										ref={videoRef(candidate)}
										onLoadedMetadata={(event) => {
											event.currentTarget.currentTime = secondsAt(
												pending.current,
											);
										}}
										onCanPlay={() =>
											setReady((old) => ({ ...old, [candidate.id]: true }))
										}
										onError={fail}
										onEnded={pause}
										onTimeUpdate={(event) => {
											if (!playing || candidate.id !== ids[0]) return;
											const time = event.currentTarget.currentTime;
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
											for (const [id, video] of videos.current)
												if (
													id !== candidate.id &&
													video.readyState >= 2 &&
													Math.abs(video.currentTime - time) > 0.08
												)
													video.currentTime = time;
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
							disabled={previous === undefined}
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
							disabled={next === undefined}
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
							{t("qc.previewFailed")}
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
