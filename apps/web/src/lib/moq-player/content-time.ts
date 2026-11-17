export type MoqContentTimeStatus = "decoded" | "no-barcode" | "unreadable";

const CELLS = 64;
const INTERVAL_MS = 100;
// Compatibility bounds for this demo's epoch-ms barcode, independent of today.
const MIN_EPOCH_MS = Date.UTC(2000, 0, 1);
const MAX_EPOCH_MS = Date.UTC(2100, 0, 1);

/** Header white/black, 48 little-endian epoch-ms bits, 14 black tail cells.
 * The source format has no checksum; this validates framing, neutral colours,
 * opacity and the fixed date range, without claiming timestamp authenticity.
 */
export function decodeMoqContentTime(rgba: ArrayLike<number>): number | null {
	try {
		if (!rgba || rgba.length !== CELLS * 4) return null;
		let epochMs = 0;
		for (let cell = 0; cell < CELLS; cell++) {
			const offset = cell * 4;
			const r = rgba[offset],
				g = rgba[offset + 1],
				b = rgba[offset + 2],
				a = rgba[offset + 3];
			if (
				[r, g, b, a].some(
					(value) =>
						typeof value !== "number" ||
						!Number.isInteger(value) ||
						value < 0 ||
						value > 255,
				) ||
				r === undefined ||
				g === undefined ||
				b === undefined ||
				a === undefined ||
				a < 240
			)
				return null;
			const low = Math.min(r, g, b),
				high = Math.max(r, g, b);
			if (high - low > 32) return null;
			const bit = low >= 192 ? 1 : high <= 64 ? 0 : null;
			if (bit === null) return null;
			if (cell === 0 ? bit !== 1 : cell === 1 || cell >= 50 ? bit !== 0 : false)
				return null;
			if (cell >= 2 && cell < 50 && bit === 1) epochMs += 2 ** (cell - 2);
		}
		return Number.isSafeInteger(epochMs) &&
			epochMs >= MIN_EPOCH_MS &&
			epochMs < MAX_EPOCH_MS
			? epochMs
			: null;
	} catch {
		return null;
	}
}

/** Reads received pixels only; never extrapolates content time from media/wall clocks. */
export function observeMoqContentTime(
	source: HTMLVideoElement | HTMLCanvasElement,
	onTime: (epochMs: number | null, status: MoqContentTimeStatus) => void,
): () => void {
	const video =
		source.tagName === "VIDEO" ? (source as HTMLVideoElement) : null;
	let disposed = false;
	let blocked = false;
	let seeking = video?.seeking ?? false;
	let scratch: HTMLCanvasElement | undefined;
	let context: CanvasRenderingContext2D | null | undefined;
	let lastRead = Number.NEGATIVE_INFINITY;
	let lastTime: number | null | undefined;
	let lastStatus: MoqContentTimeStatus | undefined;
	let deferred: ReturnType<typeof setTimeout> | undefined;
	let polling: ReturnType<typeof setInterval> | undefined;
	let frame: number | undefined;
	let frameCallbacks = Boolean(
		video &&
			typeof video.requestVideoFrameCallback === "function" &&
			typeof video.cancelVideoFrameCallback === "function",
	);
	const listeners: [string, EventListener][] = [];
	function publish(epochMs: number | null, status: MoqContentTimeStatus) {
		if (disposed || (epochMs === lastTime && status === lastStatus)) return;
		lastTime = epochMs;
		lastStatus = status;
		try {
			onTime(epochMs, status);
		} catch {
			// A consumer callback cannot interrupt owned resource cleanup.
		}
	}
	function cancelDeferred() {
		if (deferred !== undefined) clearTimeout(deferred);
		deferred = undefined;
	}
	function cancelFrame() {
		if (frame !== undefined && video) {
			try {
				video.cancelVideoFrameCallback(frame);
			} catch {
				// A removed media surface may no longer accept cancellation.
			}
		}
		frame = undefined;
	}
	function read(now: number) {
		if (disposed) return;
		try {
			const width = video?.videoWidth ?? (source as HTMLCanvasElement).width;
			const height = video?.videoHeight ?? (source as HTMLCanvasElement).height;
			if (
				blocked ||
				seeking ||
				(video && (video.seeking || video.readyState < 2)) ||
				!Number.isInteger(width) ||
				!Number.isInteger(height) ||
				width < CELLS ||
				height < 1 ||
				width > 16_384 ||
				height > 16_384
			) {
				publish(null, "unreadable");
				return;
			}
			lastRead = now;
			// Lazy allocation avoids touching canvas APIs for videos without a frame.
			scratch ??= source.ownerDocument.createElement("canvas");
			scratch.width = CELLS;
			scratch.height = 1;
			context ??= scratch.getContext("2d", { willReadFrequently: true });
			if (!context) {
				publish(null, "unreadable");
				return;
			}
			// Nearest-neighbour downsampling samples each horizontal cell centre.
			// Resetting the scratch dimensions also clears a prior origin-tainted image.
			context.imageSmoothingEnabled = false;
			const y = Math.min(height - 1, Math.floor(height * 0.04));
			context.drawImage(source, 0, y, width, 1, 0, 0, CELLS, 1);
			const epoch = decodeMoqContentTime(
				context.getImageData(0, 0, CELLS, 1).data,
			);
			publish(epoch, epoch === null ? "no-barcode" : "decoded");
		} catch {
			publish(null, "unreadable");
		}
	}
	function requestRead() {
		if (disposed) return;
		const now = performance.now();
		if (!Number.isFinite(now)) {
			publish(null, "unreadable");
			return;
		}
		const remaining = INTERVAL_MS - (now - lastRead);
		if (remaining <= 0) {
			cancelDeferred();
			read(now);
		} else if (deferred === undefined) {
			deferred = setTimeout(() => {
				deferred = undefined;
				requestRead();
			}, remaining);
		}
	}
	function startPolling() {
		polling ??= setInterval(requestRead, INTERVAL_MS);
	}
	function requestFrame() {
		if (
			disposed ||
			!video ||
			!frameCallbacks ||
			frame !== undefined ||
			blocked ||
			seeking ||
			video.paused ||
			video.ended
		)
			return;
		try {
			frame = video.requestVideoFrameCallback(() => {
				frame = undefined;
				if (disposed) return;
				requestRead();
				requestFrame();
			});
		} catch {
			frameCallbacks = false;
			startPolling();
		}
	}
	function listen(name: string, callback: EventListener) {
		source.addEventListener(name, callback);
		listeners.push([name, callback]);
	}
	if (video) {
		listen("seeking", () => {
			seeking = true;
			cancelDeferred();
			cancelFrame();
			publish(null, "unreadable");
		});
		for (const name of ["error", "emptied", "loadstart"])
			listen(name, () => {
				blocked = true;
				cancelDeferred();
				cancelFrame();
				publish(null, "unreadable");
			});
		for (const name of ["loadeddata", "seeked"])
			listen(name, () => {
				blocked = false;
				seeking = video.seeking;
				requestRead();
				requestFrame();
			});
		for (const name of ["play", "playing", "ratechange", "timeupdate"])
			listen(name, () => {
				requestRead();
				requestFrame();
			});
		for (const name of ["pause", "ended"])
			listen(name, () => {
				cancelFrame();
				requestRead();
			});
	}
	requestRead();
	if (frameCallbacks) requestFrame();
	else startPolling();
	return () => {
		if (disposed) return;
		disposed = true;
		cancelDeferred();
		cancelFrame();
		if (polling !== undefined) clearInterval(polling);
		for (const [name, callback] of listeners)
			source.removeEventListener(name, callback);
		scratch = undefined;
		context = undefined;
	};
}
