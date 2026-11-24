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

export type MoqPlaybackSettings = {
	targetBufferMs: number;
	volumePercent: number;
};
export const DEFAULT_MOQ_PLAYBACK_SETTINGS: MoqPlaybackSettings = {
	targetBufferMs: 2000,
	volumePercent: 0,
};

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
	readSettings: () => MoqPlaybackSettings = () => DEFAULT_MOQ_PLAYBACK_SETTINGS,
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
	function updateSetting(key: keyof MoqPlaybackSettings, value: number) {
		if (closed) return false;
		try {
			// An in-flight constructor reads the latest settings before playing.
			if (key === "targetBufferMs") source?.setTargetBufferLevel(value / 1000);
			else source?.setVolume(value / 100);
			return true;
		} catch {
			return false;
		}
	}
	function canSelectVideoQuality() {
		return (
			!closed &&
			typeof source?.setVideoQuality === "function" &&
			typeof source.getAvailableVideoQualities === "function"
		);
	}
	function selectVideoQuality(name: string) {
		if (!canSelectVideoQuality() || !source) return false;
		try {
			const available = source.getAvailableVideoQualities?.();
			if (!Array.isArray(available)) return false;
			const matches = available.filter(
				(quality: unknown) =>
					quality !== null &&
					typeof quality === "object" &&
					Reflect.get(quality, "name") === name,
			);
			if (matches.length !== 1) return false;
			source.setVideoQuality?.(matches[0]);
			return true;
		} catch {
			return false;
		}
	}
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
			const settings = readSettings();
			source.setTargetBufferLevel(settings.targetBufferMs / 1000);
			source.setVolume(settings.volumePercent / 100);
			telemetry?.onStage?.("subscribe-requested");
			await source.play();
		} catch {
			if (!closed) onFailure();
			await dispose().catch(() => {});
			throw new Error("MoQ playback failed");
		}
	})();
	return {
		ready,
		dispose,
		released,
		updateSetting,
		canSelectVideoQuality,
		selectVideoQuality,
	};
}
