"use client";

import { useRef, useState } from "react";
import { useT } from "@/lib/i18n/context";
import {
	fmtScore,
	renditionLabel,
	sortedRenditions,
	type VmafResultDetail,
} from "../vmaf-shared";
import { FrameChart } from "./frame-chart";

const control =
	"rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-emerald-500";

/** Time-based subjective inspection, deliberately separate from VMAF scoring. */
export function FrameComparison({
	results,
	fps,
	mode,
}: {
	results: VmafResultDetail[];
	fps?: number;
	mode: "VOD" | "LIVE";
}) {
	const { t } = useT();
	const candidates = sortedRenditions(results).filter(
		({ result }) => result.preview && "url" in result.preview,
	);
	const validClock = typeof fps === "number" && Number.isFinite(fps) && fps > 0;
	const available = mode === "VOD" && validClock && candidates.length > 0;
	const [open, setOpen] = useState(false);
	const [chosenIds, setIds] = useState<[string, string] | null>(null);
	const ids: [string, string] = chosenIds ?? [
		candidates[0]?.result.id ?? "",
		candidates[1]?.result.id ?? "",
	];
	const [frame, setFrame] = useState(0);
	const [frameDraft, setFrameDraft] = useState<string | null>(null);
	const [playing, setPlaying] = useState(false);
	const [error, setError] = useState(false);
	const [ready, setReady] = useState<Record<string, boolean>>({});
	const videos = useRef(new Map<string, HTMLVideoElement>());
	const refs = useRef(
		new Map<string, (video: HTMLVideoElement | null) => void>(),
	);
	function videoRef(id: string, url: string | undefined) {
		let ref = refs.current.get(id);
		if (!ref) {
			ref = (video) => {
				if (video) {
					videos.current.set(id, video);
					// React Strict Mode reattaches the same element after cleanup.
					if (url && video.getAttribute("src") !== url) {
						video.setAttribute("src", url);
						video.load();
					}
				} else {
					const old = videos.current.get(id);
					old?.pause();
					old?.removeAttribute("src");
					old?.load();
					videos.current.delete(id);
				}
			};
			refs.current.set(id, ref);
		}
		return ref;
	}
	const selection = ids
		.map((id) => candidates.find((c) => c.result.id === id))
		.filter((item) => item !== undefined);
	const maxFrame = results.reduce(
		(max, result) =>
			result.frames.reduce((m, point) => Math.max(m, point.frameNum), max),
		0,
	);
	const pendingFrame = useRef(0);
	const operation = useRef(0);
	function pause() {
		operation.current += 1;
		for (const video of videos.current.values()) video.pause();
		setPlaying(false);
	}
	function seek(next: number) {
		setFrameDraft(null);
		if (!Number.isInteger(next) || next < 0 || next > maxFrame) return;
		pause();
		pendingFrame.current = next;
		setFrame(next);
		if (validClock)
			for (const video of videos.current.values()) {
				if (video.readyState >= 1) video.currentTime = (next + 0.5) / fps;
			}
	}
	function fail() {
		pause();
		setError(true);
	}
	async function play() {
		if (
			!validClock ||
			error ||
			!selection.every(({ result }) => ready[result.id])
		)
			return;
		seek(frame);
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
						<label key={slot} className="grid gap-1 text-xs text-zinc-400">
							{t(slot === 0 ? "qc.previewA" : "qc.previewB")}
							<select
								className={control}
								value={ids[slot]}
								onChange={(event) => {
									pause();
									setError(false);
									const nextId = event.target.value;
									setReady((old) => ({ ...old, [nextId]: false }));
									setIds(slot === 0 ? [nextId, ids[1]] : [ids[0], nextId]);
								}}
							>
								{slot === 1 ? (
									<option value="">{t("qc.previewNone")}</option>
								) : null}
								{candidates.map(({ result, index }) => (
									<option
										key={result.id}
										value={result.id}
										disabled={ids[1 - slot] === result.id}
									>
										{renditionLabel(result.renditionRef, index)}
									</option>
								))}
							</select>
						</label>
					))
				) : (
					<p className="text-xs text-zinc-400">
						{t(
							mode === "LIVE"
								? "qc.previewLiveUnavailable"
								: "qc.previewUnavailable",
						)}
					</p>
				)}
			</div>
			{open && available ? (
				<section
					aria-label={t("qc.previewOpen")}
					className="space-y-3 rounded-lg border border-zinc-800 bg-zinc-950 p-3"
				>
					<div className="grid gap-3 md:grid-cols-2">
						{selection.map(({ result, index }) => (
							<figure key={result.id} className="min-w-0">
								<video
									muted
									playsInline
									preload="metadata"
									aria-label={renditionLabel(result.renditionRef, index)}
									className="aspect-video w-full bg-black object-contain"
									src={
										result.preview && "url" in result.preview
											? result.preview.url
											: undefined
									}
									ref={videoRef(
										result.id,
										result.preview && "url" in result.preview
											? result.preview.url
											: undefined,
									)}
									onLoadedMetadata={(event) => {
										event.currentTarget.currentTime =
											(pendingFrame.current + 0.5) / fps;
									}}
									onCanPlay={() =>
										setReady((old) => ({ ...old, [result.id]: true }))
									}
									onError={fail}
									onEnded={pause}
									onTimeUpdate={(event) => {
										if (!playing || result.id !== ids[0]) return;
										const time = event.currentTarget.currentTime;
										const next = Math.min(
											maxFrame,
											Math.max(0, Math.floor(time * fps)),
										);
										pendingFrame.current = next;
										setFrame(next);
										for (const [id, video] of videos.current)
											if (
												id !== result.id &&
												video.readyState >= 2 &&
												Math.abs(video.currentTime - time) > 0.08
											)
												video.currentTime = time;
									}}
								/>
								<figcaption className="mt-1 text-xs text-zinc-400">
									{renditionLabel(result.renditionRef, index)} · VMAF{" "}
									{result.frames.find((point) => point.frameNum === frame)
										?.vmaf !== undefined
										? fmtScore(
												result.frames.find((point) => point.frameNum === frame)
													?.vmaf ?? Number.NaN,
											)
										: t("qc.previewNoScore")}
								</figcaption>
							</figure>
						))}
					</div>
					<div className="flex flex-wrap items-end gap-2">
						<button
							type="button"
							className={control}
							disabled={
								error || !selection.every(({ result }) => ready[result.id])
							}
							onClick={() => (playing ? pause() : void play())}
						>
							{t(playing ? "qc.previewPause" : "qc.previewPlay")}
						</button>
						<button
							type="button"
							className={control}
							disabled={frame <= 0}
							onClick={() => seek(frame - 1)}
						>
							{t("qc.previewPrevious")}
						</button>
						<label className="grid gap-1 text-xs text-zinc-400">
							{t("qc.previewFrame")}
							<input
								type="number"
								min={0}
								max={maxFrame}
								step={1}
								value={frameDraft ?? frame}
								className={`${control} w-32`}
								onChange={(event) => {
									pause();
									setFrameDraft(event.target.value);
								}}
								onBlur={(event) => {
									if (event.target.value.trim() !== "")
										seek(Number(event.target.value));
									else setFrameDraft(null);
								}}
								onKeyDown={(event) => {
									if (event.key === "Enter") event.currentTarget.blur();
								}}
							/>
						</label>
						<button
							type="button"
							className={control}
							disabled={frame >= maxFrame}
							onClick={() => seek(frame + 1)}
						>
							{t("qc.previewNext")}
						</button>
						<span className="text-xs text-zinc-400">
							{t("qc.previewTiming", {
								frame,
								fps: Number(fps.toFixed(4)),
								seconds: (frame / fps).toFixed(3),
							})}
						</span>
					</div>
					{error ? (
						<p role="alert" className="text-red-400 text-sm">
							{t("qc.previewFailed")}
						</p>
					) : !selection.every(({ result }) => ready[result.id]) ? (
						<p role="status" className="text-xs text-zinc-400">
							{t("qc.previewLoading")}
						</p>
					) : null}
					<p className="text-xs text-zinc-500">{t("qc.previewCaveat")}</p>
				</section>
			) : null}
			<FrameChart
				results={results}
				selectedFrame={open ? frame : undefined}
				onFrameSelect={seek}
			/>
		</div>
	);
}
