export type AisaPlaybackMoment = {
	startInSeconds: number;
	endInSeconds: number;
	anchorInSeconds: number;
};
export type AisaMediaFragment = {
	start: number;
	programDateTime?: number | null;
	duration: number;
	tagList?: readonly (readonly string[])[];
	gap?: boolean;
};
export type AisaPlaybackRange = { start: number; end: number; anchor: number };

/** Map only a fully represented analysis interval; never clamp it to another recording interval. */
export function resolveMomentPlaybackRange(
	moment: AisaPlaybackMoment,
	origin: number,
	fragments: readonly AisaMediaFragment[],
): AisaPlaybackRange | null {
	const {
		startInSeconds: start,
		endInSeconds: end,
		anchorInSeconds: anchor,
	} = moment;
	if (
		![start, end, anchor, origin].every(Number.isFinite) ||
		origin <= 0 ||
		start < 0 ||
		end <= start ||
		anchor < start ||
		anchor > end
	)
		return null;
	let coverage = start;
	let from: number | null = null;
	let peak: number | null = null;
	for (const fragment of fragments) {
		const duration = Number(
			fragment.tagList?.find((tag) => tag[0] === "INF")?.[1] ??
				fragment.duration,
		);
		if (
			fragment.gap ||
			!Number.isFinite(fragment.programDateTime) ||
			!Number.isFinite(fragment.start) ||
			fragment.start < 0 ||
			!Number.isFinite(duration) ||
			duration <= 0
		)
			continue;
		const beginning = (Number(fragment.programDateTime) - origin) / 1000;
		const ending = beginning + duration;
		if (ending <= coverage && ending < end) continue;
		if (beginning > coverage + 0.001) return null;
		if (from === null) from = fragment.start + start - beginning;
		if (anchor >= beginning - 0.001 && anchor <= ending + 0.001)
			peak = fragment.start + anchor - beginning;
		coverage = ending;
		if (coverage >= end - 0.001) {
			const to = fragment.start + end - beginning;
			return from >= 0 &&
				to > from &&
				peak !== null &&
				peak >= from &&
				peak <= to
				? { start: from, end: to, anchor: peak }
				: null;
		}
	}
	return null;
}

export function clampMomentSeek(
	seconds: number,
	range: AisaPlaybackRange,
): number {
	const lastFrame = range.end - Math.min(0.04, (range.end - range.start) / 2);
	return Math.max(
		range.start,
		Math.min(lastFrame, Number.isFinite(seconds) ? seconds : range.start),
	);
}

export type BoundedPlaybackState = {
	ready: boolean;
	playing: boolean;
	ended: boolean;
	elapsed: number;
	duration: number;
};

/** Playback reads existing media; this controller only constrains its presentation range. */
export function createBoundedMomentPlayback(
	video: HTMLVideoElement,
	getRange: () => AisaPlaybackRange | null,
	changed: (state: BoundedPlaybackState) => void,
) {
	let pending = false;
	let ended = false;
	let ready = false;
	let disposed = false;
	let frame: number | undefined;
	const sync = () => {
		if (disposed) return;
		const range = getRange();
		if (!range || video.readyState < 1) {
			ready = false;
			video.pause();
			changed({
				ready: false,
				playing: false,
				ended,
				elapsed: 0,
				duration: range ? range.end - range.start : 0,
			});
			return;
		}
		const first = !ready;
		ready = true;
		if (first || video.currentTime < range.start - 0.001)
			video.currentTime = range.start;
		if (video.currentTime >= range.end) {
			ended = true;
			pending = false;
			video.pause();
			video.currentTime = clampMomentSeek(range.end, range);
		}
		if (pending) {
			pending = false;
			void video.play().catch(() => {
				if (!disposed) sync();
			});
		}
		changed({
			ready,
			playing: !video.paused,
			ended,
			elapsed: ended
				? range.end - range.start
				: Math.max(
						0,
						Math.min(range.end - range.start, video.currentTime - range.start),
					),
			duration: range.end - range.start,
		});
		if (!video.paused && frame === undefined && video.requestVideoFrameCallback)
			frame = video.requestVideoFrameCallback(() => {
				frame = undefined;
				sync();
			});
	};
	const events = [
		"loadedmetadata",
		"progress",
		"timeupdate",
		"seeking",
		"play",
		"pause",
		"ended",
	] as const;
	for (const event of events) video.addEventListener(event, sync);
	return {
		sync,
		play() {
			const range = getRange();
			if (ended && range) video.currentTime = range.start;
			ended = false;
			pending = true;
			sync();
		},
		pause() {
			pending = false;
			video.pause();
			sync();
		},
		seek(seconds: number) {
			const range = getRange();
			if (!range || !ready) return;
			ended = false;
			video.currentTime = clampMomentSeek(range.start + seconds, range);
			sync();
		},
		destroy() {
			disposed = true;
			pending = false;
			if (frame !== undefined) video.cancelVideoFrameCallback?.(frame);
			for (const event of events) video.removeEventListener(event, sync);
			video.pause();
		},
	};
}
