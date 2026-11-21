import {
	MOQ_ARCHIVE_SAVE_TIMEOUT_MS,
	MOQ_PLAYER_DISPOSE_TIMEOUT_MS,
} from "../../../config/moq-policy";
import type { MoqPlaybackStage } from "./observations";
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
		onFirstVisibleFrame?(): void;
		onStatistics(value: MoqVideoStatistics): void;
		onStage?(type: MoqPlaybackStage): void;
		onVideo?(video: HTMLVideoElement): void;
		beforeDispose?(): Promise<void>;
	},
) {
	const host = document.createElement("div");
	host.className = "h-full w-full";
	container.append(host);
	let closed = false;
	let constructing = true;
	let player: MoqPlayer | undefined;
	let source: MoqSource | undefined;
	let disposal: Promise<void> | undefined;
	let finalization: Promise<boolean> | undefined;
	let confirmRelease!: () => void;
	const released = new Promise<void>((resolve) => {
		confirmRelease = resolve;
	});
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
				telemetry?.onStage?.("first-frame");
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
							timer = setTimeout(
								() => reject(new Error()),
								MOQ_ARCHIVE_SAVE_TIMEOUT_MS + 2000,
							);
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
				try {
					stopObserving.disposeSurface();
				} finally {
					host.remove();
					if (!constructing) confirmRelease();
				}
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
				let timer: ReturnType<typeof setTimeout> | undefined;
				try {
					await Promise.race([
						Promise.resolve()
							.then(() => owned.dispose())
							.then(confirmRelease),
						new Promise<never>((_resolve, reject) => {
							timer = setTimeout(
								() => reject(new Error()),
								MOQ_PLAYER_DISPOSE_TIMEOUT_MS,
							);
						}),
					]);
				} catch {
					failed = true;
				} finally {
					clearTimeout(timer);
				}
				if (failed) throw new Error("MoQ playback cleanup failed");
			});
		}
		return disposal;
	}
	const ready = (async () => {
		try {
			try {
				player = await factory({
					key: descriptor.playerLicenseKey,
					defaultContainer: host,
					defaultLogLevel: 0,
					playback: { autoplay: false, muted: true },
					volume: 0,
				});
			} finally {
				constructing = false;
			}
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
			telemetry?.onStage?.("subscribe-requested");
			await source.play();
		} catch {
			if (!closed) onFailure();
			await dispose().catch(() => {});
			throw new Error("MoQ playback failed");
		}
	})();
	return { ready, dispose, released };
}
