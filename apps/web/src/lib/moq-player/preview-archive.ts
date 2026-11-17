import { createMoqAnalyticsBridge } from "./analytics";
import {
	createMoqObservationWriter,
	type MoqHistorySaveState,
} from "./history-client";
import { createMoqRecording, type MoqRecordingState } from "./recording";
import type { MoqPlaybackDescriptor } from "./types";
import type { MoqVideoStatistics } from "./video-statistics";

type Options = {
	channelId: string;
	runId: string;
	descriptor: MoqPlaybackDescriptor;
	startedAt: string;
	startedMonotonicMs: number;
	onRecordingState(state: MoqRecordingState): void;
	onHistoryState(state: MoqHistorySaveState): void;
	onAnalyticsState(state: "ready" | "unavailable" | "not-configured"): void;
	onPersisted(): void;
};
/** Session ownership is acknowledged before receiving/capturing media. */
export function createMoqPreviewArchive(options: Options) {
	const writer = createMoqObservationWriter({
		channelId: options.channelId,
		runId: options.runId,
		startedAt: options.startedAt,
		startedMonotonicMs: options.startedMonotonicMs,
		onState: options.onHistoryState,
		onPersisted: options.onPersisted,
	});
	let analytics:
		| Awaited<ReturnType<typeof createMoqAnalyticsBridge>>
		| undefined;
	let recording: ReturnType<typeof createMoqRecording> | undefined;
	let closed = false;
	let owned = false;
	let final: Promise<void> | undefined;
	const ready = (async () => {
		try {
			await writer.ready;
			owned = true;
		} catch {
			options.onRecordingState("unavailable");
		}
		if (closed) return;
		if (!options.descriptor.analytics) {
			options.onAnalyticsState("not-configured");
			return;
		}
		try {
			const bridge = await createMoqAnalyticsBridge({
				licenseKey: options.descriptor.analytics.licenseKey,
				videoId: options.descriptor.analytics.videoId,
				runId: options.runId,
				encodingId: options.descriptor.encodingId,
			});
			if (closed) {
				await bridge.dispose();
				return;
			}
			analytics = bridge;
			options.onAnalyticsState("ready");
		} catch {
			options.onAnalyticsState("unavailable");
		}
	})();
	void ready.catch(() => {});
	function video(element: HTMLVideoElement) {
		if (closed || recording) return;
		if (owned) writer.event("first-frame");
		try {
			analytics?.attach(element);
			writer.setAnalyticsImpressionId(analytics?.getImpressionId() ?? null);
		} catch {
			options.onAnalyticsState("unavailable");
		}
		if (owned)
			recording = createMoqRecording(element, {
				upload: writer.archive,
				onState: options.onRecordingState,
			});
	}
	function statistics(value: MoqVideoStatistics) {
		if (closed) return;
		if (owned) writer.sample(value);
		try {
			analytics?.sample(value);
			writer.setAnalyticsImpressionId(analytics?.getImpressionId() ?? null);
		} catch {
			options.onAnalyticsState("unavailable");
		}
	}
	function finish(reason: "stopped" | "failed" | "ended") {
		if (final) return final;
		closed = true;
		const media = recording?.finish() ?? Promise.resolve();
		// Stop its timers immediately, even when the initial ownership receipt is pending.
		// A rejected create has no owned session to finalize; a rejected final flush does.
		const observations = writer.finish(reason).catch(async () => {
			const acknowledged = await writer.ready.then(
				() => true,
				() => false,
			);
			if (acknowledged)
				throw new Error("MoQ observations could not be finalized");
		});
		final = (async () => {
			const results = await Promise.allSettled([media, observations]);
			let failed = results.some((value) => value.status === "rejected");
			try {
				await analytics?.dispose();
			} catch {
				failed = true;
			}
			if (failed) throw new Error("MoQ preview finalization failed");
		})();
		void final.catch(() => {});
		return final;
	}
	return { id: writer.id, ready, video, statistics, finish };
}
