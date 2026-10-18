"use client";

import type { SceneAnalysisDocument } from "@bitovp/core";
import { useEffect, useState } from "react";

/** The rendered frame excludes letterboxing. Unknown geometry never guesses. */
export function fittedVideoFrame(
	width: number,
	height: number,
	videoWidth: number,
	videoHeight: number,
	fit = "contain",
) {
	if (
		![width, height, videoWidth, videoHeight].every(
			(value) => Number.isFinite(value) && value > 0,
		)
	)
		return null;
	if (fit === "fill") return { left: 0, top: 0, width, height };
	const contain = Math.min(width / videoWidth, height / videoHeight);
	const scale =
		fit === "cover"
			? Math.max(width / videoWidth, height / videoHeight)
			: fit === "none"
				? 1
				: fit === "scale-down"
					? Math.min(1, contain)
					: contain;
	const frameWidth = videoWidth * scale;
	const frameHeight = videoHeight * scale;
	return {
		left: (width - frameWidth) / 2,
		top: (height - frameHeight) / 2,
		width: frameWidth,
		height: frameHeight,
	};
}

/** Shot observations are static points, NOT boxes or a tracked trajectory. */
export function SubjectOverlay({
	host,
	analysis,
	time,
}: {
	host: HTMLDivElement | null;
	analysis: SceneAnalysisDocument;
	time: number | null;
}) {
	const [frame, setFrame] = useState<ReturnType<typeof fittedVideoFrame>>(null);
	useEffect(() => {
		if (!host) return;
		let video: HTMLVideoElement | null = null;
		const measure = () => {
			if (!video) {
				setFrame(null);
				return;
			}
			const style = getComputedStyle(video);
			// Both shipped players center their video. Do not silently misplace
			// coordinates if a future skin changes to another object-position.
			if (
				style.objectPosition &&
				!["50% 50%", "center center", "center"].includes(style.objectPosition)
			) {
				setFrame(null);
				return;
			}
			const area = fittedVideoFrame(
				video.clientWidth,
				video.clientHeight,
				video.videoWidth,
				video.videoHeight,
				style.objectFit || "contain",
			);
			if (!area) {
				setFrame(null);
				return;
			}
			const bounds = video.getBoundingClientRect();
			const origin = host.getBoundingClientRect();
			setFrame({
				...area,
				left: area.left + bounds.left - origin.left + video.clientLeft,
				top: area.top + bounds.top - origin.top + video.clientTop,
			});
		};
		const resize =
			typeof ResizeObserver === "undefined"
				? null
				: new ResizeObserver(measure);
		const discover = () => {
			const next = host.querySelector("video");
			if (next !== video) {
				if (video) {
					resize?.unobserve(video);
					video.removeEventListener("loadedmetadata", measure);
					video.removeEventListener("resize", measure);
				}
				video = next;
				if (video) {
					resize?.observe(video);
					video.addEventListener("loadedmetadata", measure);
					video.addEventListener("resize", measure);
				}
			}
			measure();
		};
		const mutation = new MutationObserver(discover);
		mutation.observe(host, { childList: true, subtree: true });
		resize?.observe(host);
		window.addEventListener("resize", measure);
		discover();
		return () => {
			mutation.disconnect();
			resize?.disconnect();
			window.removeEventListener("resize", measure);
			video?.removeEventListener("loadedmetadata", measure);
			video?.removeEventListener("resize", measure);
		};
	}, [host]);
	const scene =
		time === null
			? undefined
			: analysis.scenes.find(
					(item) => time >= item.startInSeconds && time < item.endInSeconds,
				);
	const shot =
		time === null
			? undefined
			: scene?.shots.find(
					(item) => time >= item.startInSeconds && time < item.endInSeconds,
				);
	if (!frame || !shot?.mainSubjects.length) return null;
	return (
		<div className="pointer-events-none absolute inset-0 overflow-hidden">
			<div className="absolute" style={frame} data-testid="subject-frame">
				{shot.mainSubjects.map((subject, index) => (
					<span
						key={`${subject.appearanceTimeInSeconds}-${index}`}
						title={subject.description}
						className="absolute text-xs text-zinc-100"
						style={{ left: `${subject.centerX}%`, top: `${subject.centerY}%` }}
					>
						<span className="absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-emerald-300 bg-emerald-950/70" />
						<span className="absolute top-2 max-w-40 -translate-x-1/2 truncate rounded bg-zinc-950/90 px-1 py-0.5">
							{subject.classification}
						</span>
					</span>
				))}
			</div>
		</div>
	);
}
