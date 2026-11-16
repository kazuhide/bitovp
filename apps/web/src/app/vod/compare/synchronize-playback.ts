import type { PlaybackControl } from "../jobs/[id]/playback-control";

export type AudioSide = "left" | "right" | "muted";
export type SynchronizedState = {
	time: number;
	duration: number;
	intent: boolean;
	status: "ready" | "playing" | "waiting" | "failed";
};

/** One playback intent, with the left output's media clock driving the follower. */
export function synchronizePlayback(
	outputs: readonly [PlaybackControl, PlaybackControl],
	onChange: () => void,
) {
	let intent = false;
	let disposed = false;
	let failed = false;
	let epoch = 0;
	let reconciling = false;
	let pending: Promise<void> | null = null;
	const defaultQuality = new Set<PlaybackControl>();
	const pauseBoth = () => {
		for (const output of outputs) {
			try {
				output.pause();
			} catch {
				// A failed player must not prevent pausing its peer.
				if (!disposed) {
					failed = true;
					intent = false;
					epoch += 1;
				}
			}
		}
	};
	const fail = () => {
		failed = true;
		intent = false;
		epoch += 1;
		pauseBoth();
	};
	const audio = (side: AudioSide) => {
		// Mute both before making the selected side audible.
		try {
			for (const output of outputs) output.mute(true);
			if (side !== "muted") outputs[side === "left" ? 0 : 1].mute(false);
		} catch {
			fail();
		}
	};
	const read = (): SynchronizedState => {
		const states = outputs.map((output) => output.read());
		return {
			time: states[0]?.time ?? 0,
			duration: Math.min(...states.map((state) => state.duration)),
			intent,
			status:
				failed || states.some((state) => state.failed)
					? "failed"
					: states.some((state) => !state.ready) ||
							(intent && states.some((state) => state.paused))
						? "waiting"
						: intent
							? "playing"
							: "ready",
		};
	};
	function start(): Promise<void> {
		if (pending) return pending;
		const request = ++epoch;
		const plays = outputs.map((output) => {
			let playing: Promise<void>;
			try {
				playing = output.play();
			} catch {
				fail();
				return Promise.resolve();
			}
			return playing.then(
				() => {
					// Fence each completion: its peer may still have a pending play promise.
					if (disposed || request !== epoch || !intent) {
						try {
							output.pause();
						} catch {
							if (!disposed) fail();
						}
					}
				},
				() => {
					fail();
				},
			);
		});
		pending = Promise.allSettled(plays)
			.then((results) => {
				if (disposed || request !== epoch || !intent) {
					pauseBoth();
				} else if (results.some((result) => result.status === "rejected")) {
					failed = true;
					intent = false;
					pauseBoth();
				}
			})
			.finally(() => {
				pending = null;
				reconcile();
			});
		return pending;
	}
	function reconcile() {
		if (disposed || reconciling) return;
		reconciling = true;
		try {
			for (const output of outputs) {
				if (defaultQuality.has(output)) continue;
				const qualities = output
					.qualities()
					.sort(
						(a, b) =>
							b.height - a.height || (b.bitrate ?? 0) - (a.bitrate ?? 0),
					);
				const preferred =
					qualities.find((quality) => quality.height === 2160) ?? qualities[0];
				if (preferred) {
					defaultQuality.add(output);
					output.selectQuality(preferred.id);
				}
			}
			const states = outputs.map((output) => output.read());
			if (states.some((state) => state.failed)) {
				failed = true;
				intent = false;
			}
			if (intent && states.some((state) => state.ended)) intent = false;
			if (!intent || states.some((state) => !state.ready)) {
				if (states.some((state) => !state.paused)) {
					epoch += 1;
					pauseBoth();
				}
			} else if (!pending && states.some((state) => state.paused)) {
				void start();
			} else if (
				!pending &&
				Math.abs((states[0]?.time ?? 0) - (states[1]?.time ?? 0)) > 0.15
			) {
				outputs[1].seek(states[0]?.time ?? 0);
				if (!outputs[1].read().ready) {
					epoch += 1;
					pauseBoth();
				}
			}
			onChange();
		} catch {
			fail();
			onChange();
		} finally {
			reconciling = false;
		}
	}
	const unsubscribe = outputs.map((output) => output.subscribe(reconcile));
	const interval = setInterval(reconcile, 250);
	audio("left");
	reconcile();
	return {
		read,
		audio,
		play: () => {
			if (disposed) return Promise.resolve();
			failed = false;
			intent = true;
			if (outputs.some((output) => output.read().ended)) {
				reconciling = true;
				try {
					for (const output of outputs) output.seek(0);
				} catch {
					fail();
				} finally {
					reconciling = false;
				}
			}
			if (failed) {
				reconcile();
				return Promise.resolve();
			}
			if (outputs.some((output) => !output.read().ready)) {
				reconcile();
				return Promise.resolve();
			}
			return start();
		},
		pause: () => {
			intent = false;
			epoch += 1;
			pauseBoth();
			reconcile();
		},
		seek: (seconds: number) => {
			const duration = read().duration;
			if (disposed || !Number.isFinite(seconds) || duration <= 0) return;
			epoch += 1;
			reconciling = true;
			try {
				pauseBoth();
				const target = Math.max(
					0,
					Math.min(seconds, Math.max(0, duration - 0.001)),
				);
				for (const output of outputs) output.seek(target);
			} catch {
				fail();
			} finally {
				reconciling = false;
			}
			reconcile();
		},
		dispose: () => {
			if (disposed) return;
			disposed = true;
			intent = false;
			epoch += 1;
			clearInterval(interval);
			for (const release of unsubscribe) release();
			pauseBoth();
		},
	};
}
