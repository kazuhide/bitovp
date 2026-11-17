import type {
	MoqPlaybackDescriptor,
	MoqPlayer,
	MoqPlayerFactory,
	MoqSource,
} from "./types";
import { observeMoqVideo } from "./video-progress";
import type { MoqVideoStatistics } from "./video-statistics";

/** Each attempt owns a separate host, including constructors resolving after Stop. */
export function createMoqPlayback(
	factory: MoqPlayerFactory,
	descriptor: MoqPlaybackDescriptor,
	container: HTMLElement,
	onProgress: () => void,
	onFailure: () => void,
	telemetry?: {
		startedAt: number;
		onStatistics(value: MoqVideoStatistics): void;
		onVideo?(video: HTMLVideoElement): void;
		beforeDispose?(): Promise<void>;
	},
) {
	const host = document.createElement("div");
	host.className = "h-full w-full";
	container.append(host);
	let closed = false;
	let player: MoqPlayer | undefined;
	let source: MoqSource | undefined;
	let disposal: Promise<void> | undefined;
	let finalization: Promise<boolean> | undefined;
	const listeners: (() => void)[] = [];
	const fail = () => {
		if (closed) return;
		onFailure();
		void dispose().catch(() => {});
	};
	const stopObserving = observeMoqVideo(
		host,
		(video) => {
			if (!closed) {
				telemetry?.onVideo?.(video);
				onProgress();
			}
		},
		fail,
		telemetry ? { ...telemetry, source: () => source } : undefined,
	);
	function dispose(): Promise<void> {
		closed = true;
		stopObserving.stop();
		if (!finalization) {
			finalization = (async () => {
				let timer: ReturnType<typeof setTimeout> | undefined;
				try {
					await Promise.race([
						Promise.resolve().then(() => telemetry?.beforeDispose?.()),
						new Promise<never>((_resolve, reject) => {
							timer = setTimeout(() => reject(new Error()), 5500);
						}),
					]);
					return false;
				} catch {
					return true;
				} finally {
					if (timer) clearTimeout(timer);
				}
			})();
		}
		if (!player)
			return finalization.then((failed) => {
				stopObserving.disposeSurface();
				host.remove();
				if (failed) throw new Error("MoQ playback cleanup failed");
			});
		if (!disposal) {
			const owned = player;
			disposal = Promise.resolve().then(async () => {
				let failed = await finalization;
				try {
					stopObserving.disposeSurface();
				} catch {
					failed = true;
				}
				host.remove();
				for (const remove of listeners.splice(0)) {
					try {
						remove();
					} catch {
						failed = true;
					}
				}
				try {
					if (source) owned.sources.remove(source);
				} catch {
					failed = true;
				}
				try {
					await owned.dispose();
				} catch {
					failed = true;
				}
				if (failed) throw new Error("MoQ playback cleanup failed");
			});
		}
		return disposal;
	}
	const ready = (async () => {
		try {
			player = await factory({
				key: descriptor.playerLicenseKey,
				defaultContainer: host,
				defaultLogLevel: 0,
				playback: { autoplay: false, muted: true },
				volume: 0,
			});
			if (closed) {
				await dispose();
				return;
			}
			const events = player.events;
			if (events) {
				for (const type of [events.Type.PlayerError, events.Type.SourceError]) {
					if (!type) continue;
					events.on(type, fail);
					listeners.push(() => events.off(type, fail));
				}
			}
			source = player.sources.add(
				{ resources: [descriptor.resource] },
				{ attach: false },
			);
			source.logLevel = 0;
			source.setTargetBufferLevel(2);
			source.setVolume(0);
			await source.play();
		} catch {
			if (!closed) onFailure();
			await dispose().catch(() => {});
			throw new Error("MoQ playback failed");
		}
	})();
	return { ready, dispose };
}
