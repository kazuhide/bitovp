"use client";

import { type RefObject, useEffect, useState } from "react";
import { useT } from "@/lib/i18n/context";
import { moqArchiveClientTime } from "@/lib/moq-player/client-playback-time";

type Props =
	| { mode: "live"; active: boolean }
	| {
			mode: "archive";
			mediaRef: RefObject<HTMLVideoElement | null>;
			originUtcMs: number | null;
			durationMs: number;
			onTimeChange?: (epoch: number | null) => void;
	  };

export function MoqClientPlaybackClock(props: Props) {
	const { t } = useT();
	const live = props.mode === "live";
	const active = props.mode === "live" ? props.active : true;
	const mediaRef = props.mode === "archive" ? props.mediaRef : undefined;
	const origin = props.mode === "archive" ? props.originUtcMs : null;
	const duration = props.mode === "archive" ? props.durationMs : 0;
	const onTimeChange =
		props.mode === "archive" ? props.onTimeChange : undefined;
	const [epoch, setEpoch] = useState<number | null>(null);
	useEffect(() => {
		let lastEpoch: number | null | undefined;
		function publish(epoch: number | null) {
			if (lastEpoch === epoch) return;
			lastEpoch = epoch;
			setEpoch(epoch);
			onTimeChange?.(epoch);
		}
		if (!active || (!live && origin === null)) {
			publish(null);
			return;
		}
		const video = mediaRef?.current;
		let blocked = false;
		function update() {
			publish(
				live
					? Date.now()
					: video &&
							!blocked &&
							!video.error &&
							!video.seeking &&
							video.readyState >= 2
						? moqArchiveClientTime(origin, video.currentTime, duration)
						: null,
			);
		}
		function onMedia(event: Event) {
			if (["error", "emptied", "loadstart", "seeking"].includes(event.type)) {
				blocked = true;
				publish(null);
			}
			if (["loadeddata", "seeked"].includes(event.type)) blocked = false;
		}
		const events = [
			"loadeddata",
			"seeking",
			"seeked",
			"emptied",
			"error",
			"loadstart",
		];
		for (const event of events) video?.addEventListener(event, onMedia);
		update();
		let timer: number;
		function tick() {
			update();
			timer = window.setTimeout(tick, 100);
		}
		timer = window.setTimeout(tick, 100);
		return () => {
			window.clearTimeout(timer);
			for (const event of events) video?.removeEventListener(event, onMedia);
		};
	}, [active, duration, live, mediaRef, onTimeChange, origin]);
	const date = !active || epoch === null ? null : new Date(epoch);
	const iso =
		date && Number.isFinite(date.getTime()) ? date.toISOString() : null;
	return (
		<p
			data-moq-client-playback-clock
			aria-live="off"
			title={live ? undefined : t("moqPlayback.archiveClockBasis")}
			className="flex flex-wrap gap-x-2 text-xs text-zinc-400"
		>
			<span>
				{t(
					live
						? "moqPlayback.clientPlaybackTime"
						: "moqPlayback.archivedClientPlaybackTime",
				)}
			</span>
			{iso ? (
				<time
					dateTime={iso}
					data-moq-client-playback-time={iso}
					className="font-mono tabular-nums text-zinc-200"
				>
					{iso.replace("T", " ").replace("Z", " UTC")}
				</time>
			) : (
				<span>—</span>
			)}
		</p>
	);
}
