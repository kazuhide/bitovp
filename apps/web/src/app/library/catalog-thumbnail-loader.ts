import { type ContentView, isLibraryFileKind } from "@bitovp/core";

export type ThumbnailSource = NonNullable<ContentView["catalogPreview"]> & {
	cacheKey?: string;
};
type Loader = (
	source: ThumbnailSource,
	signal: AbortSignal,
) => Promise<string | null>;

/** Two transient decoders at most; only small stills survive in a bounded memory cache. */
export function createThumbnailQueue(load: Loader) {
	const cache = new Map<string, string>();
	const waiting: (() => void)[] = [];
	let active = 0;
	const pump = () => {
		while (active < 2 && waiting.length) waiting.shift()?.();
	};
	return (
		source: ThumbnailSource,
		signal: AbortSignal,
	): Promise<string | null> => {
		if (signal.aborted) return Promise.resolve(null);
		const key = JSON.stringify([
			source.cacheKey,
			source.kind,
			source.url,
			source.time,
		]);
		if (cache.has(key)) return Promise.resolve(cache.get(key) ?? null);
		return new Promise((resolve) => {
			const cancel = () => {
				const index = waiting.indexOf(run);
				if (index >= 0) {
					waiting.splice(index, 1);
					resolve(null);
				}
				signal.removeEventListener("abort", cancel);
			};
			const run = () => {
				signal.removeEventListener("abort", cancel);
				if (signal.aborted) {
					resolve(null);
					return;
				}
				active++;
				void load(source, signal)
					.catch(() => null)
					.then((frame) => {
						if (!signal.aborted && frame !== null) {
							cache.set(key, frame);
							if (cache.size > 64)
								cache.delete(cache.keys().next().value ?? "");
						}
						resolve(signal.aborted ? null : frame);
					})
					.finally(() => {
						active--;
						pump();
					});
			};
			waiting.push(run);
			signal.addEventListener("abort", cancel, { once: true });
			pump();
		});
	};
}

export const captureThumbnail: Loader = (source, signal) =>
	new Promise((resolve) => {
		if (signal.aborted) {
			resolve(null);
			return;
		}
		const video = document.createElement("video");
		video.crossOrigin = "anonymous";
		video.muted = true;
		video.playsInline = true;
		video.preload = "auto";
		video.width = 320;
		video.height = 180;
		video.style.cssText =
			"position:fixed;left:-9999px;top:0;width:320px;height:180px;pointer-events:none";
		video.setAttribute("aria-hidden", "true");
		let settled = false,
			target = source.time;
		let destroy: (() => unknown) | undefined;
		const finish = (frame: string | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal.removeEventListener("abort", fail);
			video.removeEventListener("loadedmetadata", seek);
			video.removeEventListener("loadeddata", frameReady);
			video.removeEventListener("seeked", frameReady);
			video.removeEventListener("error", fail);
			video.removeEventListener("encrypted", fail);
			video.pause();
			void Promise.resolve(destroy?.())
				.catch(() => {})
				.finally(() => {
					video.removeAttribute("src");
					video.load();
					video.remove();
					resolve(frame);
				});
		};
		const fail = () => finish(null);
		const timer = setTimeout(fail, 15_000);
		const frameReady = () => {
			if (
				video.seeking ||
				video.readyState < 2 ||
				!video.videoWidth ||
				Math.abs(video.currentTime - target) > 0.25
			)
				return;
			try {
				const canvas = document.createElement("canvas");
				canvas.width = 320;
				canvas.height = 180;
				const context = canvas.getContext("2d");
				if (!context) {
					fail();
					return;
				}
				const scale = Math.min(320 / video.videoWidth, 180 / video.videoHeight);
				const width = video.videoWidth * scale,
					height = video.videoHeight * scale;
				context.fillRect(0, 0, 320, 180);
				context.drawImage(
					video,
					(320 - width) / 2,
					(180 - height) / 2,
					width,
					height,
				);
				finish(canvas.toDataURL("image/jpeg", 0.7));
			} catch {
				fail();
			} // Tainted canvas / CORS is an ordinary unavailable preview.
		};
		const seek = () => {
			target = Number.isFinite(video.duration)
				? Math.min(source.time, Math.max(0, video.duration - 0.1))
				: source.time;
			video.currentTime = target;
			frameReady();
		};
		video.addEventListener("loadedmetadata", seek);
		video.addEventListener("loadeddata", frameReady);
		video.addEventListener("seeked", frameReady);
		video.addEventListener("error", fail);
		video.addEventListener("encrypted", fail);
		signal.addEventListener("abort", fail, { once: true });
		document.body.appendChild(video);
		void (async () => {
			if (isLibraryFileKind(source.kind)) {
				video.src = source.url;
				return;
			}
			if (
				source.kind === "HLS" &&
				video.canPlayType("application/vnd.apple.mpegurl")
			) {
				video.src = source.url;
				return;
			}
			if (source.kind === "HLS") {
				const { default: Hls } = await import("hls.js");
				if (settled) return;
				if (!Hls.isSupported()) {
					fail();
					return;
				}
				const hls = new Hls({
					startLevel: 0,
					startPosition: source.time,
					maxBufferLength: 3,
					maxMaxBufferLength: 6,
					enableWorker: false,
				});
				destroy = () => hls.destroy();
				hls.autoLevelCapping = 0;
				hls.on(Hls.Events.ERROR, (_event, data) => {
					if (data.fatal) fail();
				});
				hls.loadSource(source.url);
				hls.attachMedia(video);
			} else {
				const { default: shaka } = await import("shaka-player");
				if (settled) return;
				shaka.polyfill.installAll();
				if (!shaka.Player.isBrowserSupported()) {
					fail();
					return;
				}
				const player = new shaka.Player();
				destroy = () => player.destroy();
				player.addEventListener("error", fail);
				player.configure({
					streaming: { bufferingGoal: 3, rebufferingGoal: 0.5 },
					abr: { defaultBandwidthEstimate: 200000 },
					drm: { delayLicenseRequestUntilPlayed: true },
				});
				await player.attach(video);
				if (settled) return;
				await player.load(source.url, source.time);
			}
		})().catch(fail);
	});

export const requestThumbnail = createThumbnailQueue(captureThumbnail);
