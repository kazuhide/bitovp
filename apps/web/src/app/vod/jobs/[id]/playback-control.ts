export type PlaybackSnapshot = {
	time: number;
	duration: number;
	paused: boolean;
	ready: boolean;
	ended: boolean;
	failed: boolean;
	qualityId?: string;
};
export type PlaybackQuality = { id: string; height: number; bitrate?: number };
export type QualityControl = {
	list: () => PlaybackQuality[];
	select: (id: string) => boolean;
};
export type PlaybackControl = {
	read: () => PlaybackSnapshot;
	play: () => Promise<void>;
	pause: () => void;
	seek: (seconds: number) => void;
	mute: (muted: boolean) => void;
	subscribe: (listener: () => void) => () => void;
	qualities: () => PlaybackQuality[];
	selectQuality: (id: string) => boolean;
};

/** The existing player owns decoding; this optional port observes its real media clock. */
export function videoPlaybackControl(
	video: HTMLVideoElement,
	commands?: Pick<PlaybackControl, "play" | "pause" | "seek" | "mute">,
) {
	let blocked = video.readyState < 3;
	let failed = false;
	let released = false;
	let quality: QualityControl | undefined;
	let qualityId: string | undefined;
	const listeners = new Set<() => void>();
	const notify = () => {
		for (const listener of listeners) listener();
	};
	const waiting = () => {
		blocked = true;
		notify();
	};
	const ready = () => {
		blocked = false;
		notify();
	};
	const events = {
		waiting,
		seeking: waiting,
		emptied: waiting,
		canplay: ready,
		playing: ready,
		seeked: ready,
		loadeddata: ready,
		timeupdate: notify,
		durationchange: notify,
		pause: notify,
		ended: notify,
		error: notify,
	};
	for (const [event, listener] of Object.entries(events))
		video.addEventListener(event, listener);
	const native = commands ?? {
		play: () => video.play(),
		pause: () => video.pause(),
		seek: (seconds: number) => {
			video.currentTime = seconds;
		},
		mute: (muted: boolean) => {
			video.muted = muted;
		},
	};
	return {
		read: (): PlaybackSnapshot => ({
			time: Number.isFinite(video.currentTime) ? video.currentTime : 0,
			duration:
				Number.isFinite(video.duration) && video.duration > 0
					? video.duration
					: 0,
			paused: video.paused,
			ready:
				!released &&
				!failed &&
				!video.error &&
				!blocked &&
				!video.seeking &&
				video.readyState >= 3,
			ended: video.ended,
			failed: failed || !!video.error,
			qualityId,
		}),
		play: async () => {
			if (released) throw new Error("Playback control released");
			await native.play();
			if (released) native.pause();
		},
		pause: () => native.pause(),
		seek: (seconds: number) => {
			if (Number.isFinite(seconds) && seconds >= 0) native.seek(seconds);
		},
		mute: (muted: boolean) => native.mute(muted),
		subscribe: (listener: () => void) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		qualities: () =>
			quality
				?.list()
				.filter((item) => Number.isFinite(item.height) && item.height > 0) ??
			[],
		selectQuality: (id: string) => {
			try {
				if (!quality?.select(id)) return false;
			} catch {
				notify();
				return false;
			}
			qualityId = id || undefined;
			notify();
			return true;
		},
		setQuality: (value: QualityControl) => {
			quality = value;
			notify();
		},
		refresh: notify,
		fail: () => {
			failed = true;
			notify();
		},
		release: () => {
			released = true;
			for (const [event, listener] of Object.entries(events))
				video.removeEventListener(event, listener);
			listeners.clear();
			native.pause();
		},
	};
}
