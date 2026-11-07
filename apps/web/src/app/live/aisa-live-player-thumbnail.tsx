import {
	createThumbnailQueue,
	type ThumbnailSource,
} from "@/app/library/catalog-thumbnail-loader";
import {
	type AisaPlaybackMoment,
	resolveMomentPlaybackRange,
} from "@/lib/aisa-live/playback";

type Source = ThumbnailSource & { origin: number; moment: AisaPlaybackMoment };

const queue = createThumbnailQueue((source, signal) =>
	capture(source as Source, signal),
);

export function requestAisaThumbnail(source: Source, signal: AbortSignal) {
	return queue(source, signal);
}

/** Decode the actual anchor frame from the existing recording; no clip video is created. */
function capture(source: Source, signal: AbortSignal): Promise<string | null> {
	return new Promise((resolve) => {
		if (signal.aborted) {
			resolve(null);
			return;
		}
		const video = document.createElement("video");
		video.muted = true;
		video.playsInline = true;
		video.preload = "auto";
		video.crossOrigin = "anonymous";
		video.style.cssText =
			"position:fixed;left:-9999px;width:320px;height:180px;pointer-events:none";
		video.setAttribute("aria-hidden", "true");
		let hls: import("hls.js").default | undefined;
		let settled = false;
		let target: number | null = null;
		let frame: number | undefined;
		let presented: number | null = null;
		const finish = (value: string | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal.removeEventListener("abort", fail);
			for (const name of ["loadedmetadata", "loadeddata", "seeked"] as const)
				video.removeEventListener(name, captureFrame);
			if (frame !== undefined) video.cancelVideoFrameCallback?.(frame);
			hls?.destroy();
			video.pause();
			video.removeAttribute("src");
			video.load();
			video.remove();
			resolve(value);
		};
		const fail = () => finish(null);
		const captureFrame = () => {
			if (target === null || video.readyState < 1) return;
			if (Math.abs(video.currentTime - target) > 0.001) {
				video.currentTime = target;
				return;
			}
			if (video.seeking || video.readyState < 2 || !video.videoWidth) return;
			if (
				typeof video.requestVideoFrameCallback === "function" &&
				(presented === null || Math.abs(presented - target) > 0.15)
			)
				return;
			try {
				const canvas = document.createElement("canvas");
				canvas.width = Math.min(320, video.videoWidth);
				canvas.height = Math.round(
					(canvas.width * video.videoHeight) / video.videoWidth,
				);
				const context = canvas.getContext("2d");
				if (!context) {
					fail();
					return;
				}
				context.drawImage(video, 0, 0, canvas.width, canvas.height);
				finish(canvas.toDataURL("image/jpeg", 0.75));
			} catch {
				fail();
			}
		};
		const timer = setTimeout(fail, 15000);
		for (const name of ["loadedmetadata", "loadeddata", "seeked"] as const)
			video.addEventListener(name, captureFrame);
		signal.addEventListener("abort", fail, { once: true });
		document.body.appendChild(video);
		if (video.requestVideoFrameCallback) {
			const onFrame: VideoFrameRequestCallback = (_time, metadata) => {
				frame = undefined;
				presented = metadata.mediaTime;
				captureFrame();
				if (!settled) frame = video.requestVideoFrameCallback(onFrame);
			};
			frame = video.requestVideoFrameCallback(onFrame);
		}
		void import("hls.js")
			.then(({ default: Hls }) => {
				if (settled) return;
				if (!Hls.isSupported()) {
					fail();
					return;
				}
				hls = new Hls({
					autoStartLoad: false,
					startLevel: 0,
					maxBufferLength: 1,
					maxMaxBufferLength: 2,
					enableWorker: false,
				});
				hls.autoLevelCapping = 0;
				hls.on(Hls.Events.MANIFEST_PARSED, () => hls?.startLoad(0));
				hls.on(Hls.Events.LEVEL_UPDATED, (_event, data) => {
					if (target !== null) return;
					const range = resolveMomentPlaybackRange(
						source.moment,
						source.origin,
						data.details.fragments,
					);
					if (!range) {
						fail();
						return;
					}
					target = range.anchor;
					hls?.startLoad(target);
					captureFrame();
				});
				hls.on(Hls.Events.ERROR, (_event, data) => {
					if (data.fatal) fail();
				});
				hls.attachMedia(video);
				hls.loadSource(source.url);
			})
			.catch(fail);
	});
}
