"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n/context";
import type { PublicBandingAssessment } from "@/lib/server/banding-public";
import { observePresentationOrigin } from "./presentation-origin";

type Interval = Pick<
	PublicBandingAssessment["ranges"][number],
	"startSeconds" | "endSeconds"
>;
type Status = "loading" | "playing" | "paused" | "ended" | "error";
type Failure = "timing" | "range" | "media";
type Actions = { play: () => void; pause: () => void; replay: () => void };

/** Each mount owns one measured object and establishes its clock before any seek. */
function useIntervalVideo(url: string, range: Interval) {
	const videoRef = useRef<HTMLVideoElement>(null);
	const actions = useRef<Actions | null>(null);
	const [status, setStatus] = useState<Status>("loading");
	const [failure, setFailure] = useState<Failure>("media");
	useEffect(() => {
		const element = videoRef.current;
		if (!element) return;
		const video = element;
		setStatus("loading");
		let disposed = false;
		let failed = false;
		let operation = 0;
		let origin: number | undefined;
		let start = 0;
		let end = 0;
		let pendingPlay = true;
		let pendingStart = true;
		let animation = 0;
		let cancelOrigin = () => {};
		let seekTimeout = 0;
		const timeout = window.setTimeout(() => fail("timing"), 10_000);
		function pause(next: Status = "paused") {
			operation += 1;
			pendingPlay = false;
			video?.pause();
			cancelAnimationFrame(animation);
			window.clearTimeout(seekTimeout);
			if (!disposed) setStatus(next);
		}
		function fail(reason: Failure) {
			failed = true;
			window.clearTimeout(timeout);
			pause("error");
			if (!disposed) setFailure(reason);
		}
		function bound() {
			if (origin === undefined || disposed || failed || pendingPlay) return;
			if (video.currentTime >= end) {
				pause("ended");
				// The end is exclusive. Browser seeking is approximate, not frame-exact.
				video.currentTime = Math.max(
					start,
					end - Math.min(0.000001, (end - start) / 2),
				);
			} else if (video.currentTime < start - 0.000001) {
				pause();
				video.currentTime = start;
			}
		}
		function watch() {
			bound();
			if (!disposed && !video.paused) animation = requestAnimationFrame(watch);
		}
		async function maybePlay() {
			if (
				disposed ||
				failed ||
				origin === undefined ||
				!pendingPlay ||
				video.seeking ||
				video.readyState < 2
			)
				return;
			if (video.currentTime < start - 0.000001) {
				// Metadata duration can grow when the browser reads the tail of an MP4.
				// Retry a clamped initial seek only after the requested start is seekable.
				if (video.duration < start) return;
				video.currentTime = start;
				return;
			}
			if (video.currentTime >= end) return fail("range");
			if (pendingStart && Math.abs(video.currentTime - start) > 0.000001)
				return fail("range");
			pendingStart = false;
			pendingPlay = false;
			const token = ++operation;
			window.clearTimeout(seekTimeout);
			seekTimeout = window.setTimeout(() => fail("media"), 10_000);
			try {
				await video.play();
				if (disposed) video.pause();
				else if (token === operation) {
					window.clearTimeout(seekTimeout);
					setStatus("playing");
					cancelAnimationFrame(animation);
					animation = requestAnimationFrame(watch);
				}
			} catch {
				if (!disposed && token === operation) fail("media");
			}
		}
		function seekAndPlay() {
			if (origin === undefined || disposed || failed) return;
			pause();
			pendingPlay = true;
			pendingStart = true;
			setStatus("loading");
			seekTimeout = window.setTimeout(() => fail("range"), 10_000);
			const alreadyThere = Math.abs(video.currentTime - start) < 0.000001;
			video.currentTime = start;
			if (alreadyThere) void maybePlay();
		}
		const ready = () => void maybePlay();
		const error = () => fail("media");
		const ended = () => {
			if (origin !== undefined && video.currentTime < end - 0.000001)
				fail("range");
			else pause("ended");
		};
		const playing = () => {
			if (origin === undefined || disposed || failed) video.pause();
			else {
				cancelAnimationFrame(animation);
				animation = requestAnimationFrame(watch);
			}
		};
		const listeners = {
			canplay: ready,
			seeked: ready,
			durationchange: ready,
			seeking: bound,
			timeupdate: bound,
			playing,
			ended,
			error,
		};
		for (const [name, listener] of Object.entries(listeners))
			video.addEventListener(name, listener);
		actions.current = {
			pause: () => pause(),
			replay: seekAndPlay,
			play: () => {
				if (video.currentTime >= end || video.currentTime < start)
					seekAndPlay();
				else {
					if (disposed || failed || origin === undefined) return;
					pendingPlay = true;
					setStatus("loading");
					window.clearTimeout(seekTimeout);
					seekTimeout = window.setTimeout(() => fail("media"), 10_000);
					void maybePlay();
				}
			},
		};
		cancelOrigin = observePresentationOrigin(
			video,
			(mediaTime) => {
				if (disposed || failed) return;
				origin = mediaTime;
				start = origin + range.startSeconds;
				end = origin + range.endSeconds;
				if (
					!Number.isFinite(start) ||
					!Number.isFinite(end) ||
					range.startSeconds < 0 ||
					end <= start ||
					!Number.isFinite(video.duration) ||
					video.duration <= 0
				)
					return fail("range");
				window.clearTimeout(timeout);
				seekAndPlay();
			},
			() => fail("timing"),
		);
		if (!failed) {
			video.src = url;
			video.load();
		}
		return () => {
			disposed = true;
			operation += 1;
			window.clearTimeout(timeout);
			window.clearTimeout(seekTimeout);
			cancelAnimationFrame(animation);
			cancelOrigin();
			for (const [name, listener] of Object.entries(listeners))
				video.removeEventListener(name, listener);
			actions.current = null;
			video.pause();
			video.removeAttribute("src");
			video.load();
		};
	}, [url, range.startSeconds, range.endSeconds]);
	return { videoRef, actions, status, failure };
}

export function BandingIntervalPlayer({
	url,
	label,
	range,
	onClose,
}: {
	url: string;
	label: string;
	range: Interval;
	onClose: () => void;
}) {
	const { t } = useT();
	const { videoRef, actions, status, failure } = useIntervalVideo(url, range);
	const section = useRef<HTMLElement>(null);
	useEffect(() => section.current?.focus(), []);
	return (
		<section
			ref={section}
			tabIndex={-1}
			aria-label={t("banding.previewTitle", { label })}
			className="mt-4 space-y-3 rounded-lg border border-zinc-700 bg-zinc-950 p-3 outline-none focus-visible:outline-2 focus-visible:outline-emerald-500"
		>
			<div className="flex flex-wrap items-center justify-between gap-2">
				<p className="text-sm text-zinc-200">
					{label} · {range.startSeconds.toFixed(3)}–
					{range.endSeconds.toFixed(3)} s
				</p>
				<Button size="sm" variant="secondary" onClick={onClose}>
					{t("banding.previewClose")}
				</Button>
			</div>
			<video
				ref={videoRef}
				muted
				playsInline
				preload="auto"
				aria-label={label}
				className="aspect-video w-full bg-black object-contain"
			/>
			<div className="flex flex-wrap gap-2">
				<Button
					size="sm"
					variant="secondary"
					disabled={status === "loading" || status === "error"}
					onClick={() =>
						status === "playing"
							? actions.current?.pause()
							: actions.current?.play()
					}
				>
					{t(
						status === "playing"
							? "banding.previewPause"
							: "banding.previewPlay",
					)}
				</Button>
				<Button
					size="sm"
					variant="secondary"
					disabled={status === "loading" || status === "error"}
					onClick={() => actions.current?.replay()}
				>
					{t("banding.previewReplay")}
				</Button>
			</div>
			{status === "loading" ? (
				<p role="status" className="text-sm text-zinc-400">
					{t("banding.previewLoading")}
				</p>
			) : null}
			{status === "ended" ? (
				<p role="status" className="text-sm text-zinc-400">
					{t("banding.previewEnded")}
				</p>
			) : null}
			{status === "error" ? (
				<p role="alert" className="text-sm text-red-400">
					{t(
						failure === "timing"
							? "banding.previewTimingUnavailable"
							: failure === "range"
								? "banding.previewRangeUnavailable"
								: "banding.previewFailed",
					)}
				</p>
			) : null}
			<p className="text-xs text-zinc-400">{t("banding.previewCaveat")}</p>
		</section>
	);
}
