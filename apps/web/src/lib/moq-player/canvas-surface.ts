export type MoqCanvasSurface = {
	video: HTMLVideoElement;
	/** A conservative visual update, not a decoder or source frame counter. */
	changed(): boolean;
	/** Whether the latest readback of this owned canvas contains a visible image. */
	hasVisibleImage(): boolean;
	dispose(): void;
};

/** Observe/record the received canvas without touching the SDK's renderer.
 * Native capture uses drawing events, with no requested or synthetic frame rate.
 * The caller keeps this surface alive until recording and Analytics finalize. */
export function createMoqCanvasSurface(
	canvas: HTMLCanvasElement,
	host: HTMLElement,
): MoqCanvasSurface | null {
	let video: HTMLVideoElement | undefined;
	let closed = false;
	let previous: number | null = null;
	const tracks: MediaStreamTrack[] = [];
	function dispose() {
		if (closed) return;
		closed = true;
		for (const track of tracks) {
			try {
				track.stop();
			} catch {
				// Continue releasing the remaining owned resources.
			}
		}
		if (video) {
			try {
				video.pause();
			} catch {
				// A failed media element must not retain the owned stream.
			}
			video.srcObject = null;
			video.remove();
		}
	}
	try {
		if (typeof canvas.captureStream !== "function") return null;
		const probe = document.createElement("canvas");
		probe.width = 96;
		probe.height = 54;
		const context = probe.getContext("2d", { willReadFrequently: true });
		if (!context) return null;
		const stream = canvas.captureStream();
		tracks.push(...stream.getTracks());
		video = document.createElement("video");
		video.dataset.bitovpMoqCanvasMirror = "true";
		video.setAttribute("aria-hidden", "true");
		video.tabIndex = -1;
		video.muted = true;
		video.defaultMuted = true;
		video.playsInline = true;
		video.style.cssText =
			"position:absolute;inset:0;width:100%;height:100%;opacity:0;pointer-events:none";
		video.srcObject = stream;
		host.append(video);
		void Promise.resolve(video.play()).catch(dispose);
		return {
			video,
			changed() {
				if (closed) return false;
				try {
					context.drawImage(canvas, 0, 0, probe.width, probe.height);
					const pixels = context.getImageData(
						0,
						0,
						probe.width,
						probe.height,
					).data;
					let hash = 0x811c9dc5;
					let visible = false;
					for (let i = 0; i < pixels.length; i += 4) {
						if (
							pixels[i + 3] !== 0 &&
							(pixels[i] !== 0 || pixels[i + 1] !== 0 || pixels[i + 2] !== 0)
						)
							visible = true;
						for (let channel = 0; channel < 4; channel++)
							hash = Math.imul(hash ^ (pixels[i + channel] ?? 0), 0x01000193);
					}
					if (!visible) {
						previous = null;
						return false;
					}
					const changed = previous !== null && previous !== hash;
					previous = hash;
					return changed;
				} catch {
					previous = null;
					return false;
				}
			},
			hasVisibleImage: () => !closed && previous !== null,
			dispose,
		};
	} catch {
		dispose();
		return null;
	}
}
