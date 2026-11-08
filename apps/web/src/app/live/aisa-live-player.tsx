"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { AisaResultSnapshot } from "@/lib/aisa-live/contracts";
import {
	type AisaPlaybackRange,
	type BoundedPlaybackState,
	createBoundedMomentPlayback,
	resolveMomentPlaybackRange,
} from "@/lib/aisa-live/playback";
import { requestAisaThumbnail } from "./aisa-live-player-thumbnail";
import {
	type AisaMomentPlayRequest,
	momentPlaybackIdentity,
	useAisaRecordingUrl,
} from "./aisa-recording-scope";

export type AisaMomentPlayerLabels = {
	play: string;
	pause: string;
	replay: string;
	loading: string;
	unavailable: string;
	failed: string;
	seek: string;
	mute: string;
	unmute: string;
	thumbnailAlt: string;
};
type Props = {
	accountId: string;
	analysisId: string;
	encodingId: string;
	mediaTimeOriginUnixMs: number;
	moment: AisaResultSnapshot["keyMoments"][number];
	labels: AisaMomentPlayerLabels;
	playRequest?: AisaMomentPlayRequest;
};
type Controller = ReturnType<typeof createBoundedMomentPlayback>;
const initial: BoundedPlaybackState = {
	ready: false,
	playing: false,
	ended: false,
	elapsed: 0,
	duration: 0,
};
let activeStop: (() => void) | undefined;

export function AisaMomentPreview(props: Props) {
	const url = useAisaRecordingUrl(
		props.accountId,
		props.analysisId,
		props.encodingId,
	);
	const identity = momentPlaybackIdentity(
		url,
		props.mediaTimeOriginUnixMs,
		props.moment,
	);
	return (
		<MomentPreview
			key={identity}
			{...props}
			url={url}
			identity={identity}
			playRequest={
				props.playRequest?.identity === identity
					? props.playRequest.token
					: undefined
			}
		/>
	);
}

function MomentPreview({
	url,
	identity,
	mediaTimeOriginUnixMs,
	moment,
	labels,
	playRequest,
}: Omit<Props, "playRequest"> & {
	url: string;
	identity: string;
	playRequest?: number;
}) {
	const video = useRef<HTMLVideoElement | null>(null);
	const controller = useRef<Controller | null>(null);
	const hls = useRef<import("hls.js").default | null>(null);
	const hlsModule = useRef<Promise<typeof import("hls.js")> | null>(null);
	const canceled = useRef(false);
	const starting = useRef(false);
	const attempt = useRef(0);
	const handledPlayRequest = useRef<number | undefined>(undefined);
	const [poster, setPoster] = useState<string | null>(null);
	const [playback, setPlayback] = useState(initial);
	const [phase, setPhase] = useState<
		"idle" | "loading" | "unavailable" | "failed"
	>("idle");
	const [muted, setMuted] = useState(true);
	const { startInSeconds, endInSeconds, anchorInSeconds } = moment;
	const cleanup = useCallback(() => {
		canceled.current = true;
		starting.current = false;
		attempt.current++;
		controller.current?.destroy();
		controller.current = null;
		hls.current?.destroy();
		hls.current = null;
		video.current?.removeAttribute("src");
		video.current?.load();
	}, []);
	const stop = useCallback(() => {
		cleanup();
		setPlayback(initial);
		setPhase("idle");
	}, [cleanup]);
	useEffect(
		() => () => {
			cleanup();
			// Effect replay must be able to restart the request canceled by teardown.
			handledPlayRequest.current = undefined;
			if (activeStop === stop) activeStop = undefined;
		},
		[cleanup, stop],
	);
	useEffect(() => {
		if (!url) return;
		const abort = new AbortController();
		void requestAisaThumbnail(
			{
				kind: "HLS",
				url,
				time: anchorInSeconds,
				cacheKey: identity,
				origin: mediaTimeOriginUnixMs,
				moment: { startInSeconds, endInSeconds, anchorInSeconds },
			},
			abort.signal,
		).then((frame) => {
			if (!abort.signal.aborted) setPoster(frame);
		});
		return () => abort.abort();
	}, [
		url,
		identity,
		mediaTimeOriginUnixMs,
		startInSeconds,
		endInSeconds,
		anchorInSeconds,
	]);
	const startPlayback = useCallback(
		async (restart = false) => {
			if (!url || starting.current) return;
			if (controller.current) {
				if (restart) controller.current.seek(0);
				controller.current.play();
				return;
			}
			activeStop?.();
			activeStop = stop;
			canceled.current = false;
			starting.current = true;
			const currentAttempt = ++attempt.current;
			setPhase("loading");
			try {
				hlsModule.current ??= import("hls.js");
				const { default: Hls } = await hlsModule.current;
				if (
					canceled.current ||
					currentAttempt !== attempt.current ||
					!video.current
				)
					return;
				if (!Hls.isSupported()) {
					setPhase("unavailable");
					return;
				}
				const element = video.current;
				let range: AisaPlaybackRange | null = null;
				controller.current = createBoundedMomentPlayback(
					element,
					() => range,
					(state) => {
						if (!canceled.current) {
							setPlayback(state);
							if (state.ready) setPhase("idle");
						}
					},
				);
				const instance = new Hls({
					autoStartLoad: false,
					startLevel: 0,
					maxBufferLength: 5,
					maxMaxBufferLength: 10,
					enableWorker: false,
				});
				hls.current = instance;
				instance.on(Hls.Events.MANIFEST_PARSED, () => instance.startLoad(0));
				instance.on(Hls.Events.LEVEL_UPDATED, (_event, data) => {
					const before = range;
					range = resolveMomentPlaybackRange(
						moment,
						mediaTimeOriginUnixMs,
						data.details.fragments,
					);
					if (!range) setPhase("unavailable");
					else if (!before) instance.startLoad(range.start);
					controller.current?.sync();
				});
				instance.on(Hls.Events.ERROR, (_event, data) => {
					if (data.fatal && !canceled.current) {
						cleanup();
						setPhase("failed");
					}
				});
				instance.attachMedia(element);
				instance.loadSource(url);
				controller.current.play();
			} catch {
				if (currentAttempt === attempt.current) {
					hlsModule.current = null;
					cleanup();
					setPhase("failed");
				}
			} finally {
				if (currentAttempt === attempt.current) starting.current = false;
			}
		},
		[url, stop, moment, mediaTimeOriginUnixMs, cleanup],
	);
	useEffect(() => {
		if (playRequest === undefined || handledPlayRequest.current === playRequest)
			return;
		handledPlayRequest.current = playRequest;
		void startPlayback(true);
	}, [playRequest, startPlayback]);
	const toggle = () => {
		if (!url || phase === "loading") return;
		if (controller.current && playback.playing) controller.current.pause();
		else void startPlayback();
	};
	const action = playback.playing
		? labels.pause
		: playback.ended
			? labels.replay
			: labels.play;
	return (
		<div className="space-y-2" data-aisa-moment-media={moment.id}>
			<button
				type="button"
				aria-label={`${action}: ${labels.thumbnailAlt}`}
				onClick={() => void toggle()}
				disabled={!url || phase === "loading"}
				className="relative block aspect-video w-full overflow-hidden rounded-md border border-zinc-800 bg-black focus-visible:outline-2 focus-visible:outline-emerald-500"
			>
				<video
					ref={video}
					poster={poster ?? undefined}
					muted={muted}
					playsInline
					preload="none"
					aria-label={labels.thumbnailAlt}
					className="h-full w-full object-contain"
				/>
				{!playback.playing ? (
					<span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/20 text-sm text-white">
						{phase === "loading" ? labels.loading : action}
					</span>
				) : null}
			</button>
			<div className="flex flex-wrap items-center gap-2">
				<Button
					variant="secondary"
					size="sm"
					disabled={!url || phase === "loading"}
					onClick={() => void toggle()}
				>
					{action}
				</Button>
				<Button
					variant="ghost"
					size="sm"
					onClick={() => setMuted((value) => !value)}
				>
					{muted ? labels.unmute : labels.mute}
				</Button>
				<span className="font-mono text-xs text-zinc-400">
					{playback.elapsed.toFixed(1)} /{" "}
					{(
						playback.duration || moment.endInSeconds - moment.startInSeconds
					).toFixed(1)}{" "}
					s
				</span>
			</div>
			<input
				type="range"
				aria-label={labels.seek}
				min={0}
				max={playback.duration || moment.endInSeconds - moment.startInSeconds}
				step={0.01}
				value={playback.elapsed}
				disabled={!playback.ready}
				onChange={(event) =>
					controller.current?.seek(event.target.valueAsNumber)
				}
				className="w-full accent-emerald-500"
			/>
			{phase === "unavailable" || !url ? (
				<p role="status" className="text-xs text-zinc-400">
					{labels.unavailable}
				</p>
			) : null}
			{phase === "failed" ? (
				<p role="alert" className="text-xs text-red-300">
					{labels.failed}
				</p>
			) : null}
		</div>
	);
}
