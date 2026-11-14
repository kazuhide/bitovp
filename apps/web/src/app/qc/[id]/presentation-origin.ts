/** Register before assigning src/loading; a later frame cannot establish the origin. */
export function observePresentationOrigin(
	video: HTMLVideoElement,
	onOrigin: (seconds: number) => void,
	onUnavailable: () => void,
): () => void {
	let active = true;
	let request = 0;
	if (typeof video.requestVideoFrameCallback !== "function") onUnavailable();
	else {
		request = video.requestVideoFrameCallback((_now, metadata) => {
			if (!active) return;
			if (
				!Number.isFinite(metadata.mediaTime) ||
				metadata.mediaTime < 0 ||
				metadata.presentedFrames !== 1 ||
				video.seeking ||
				!video.paused
			)
				onUnavailable();
			else onOrigin(metadata.mediaTime);
		});
	}
	return () => {
		active = false;
		if (request) video.cancelVideoFrameCallback?.(request);
	};
}
