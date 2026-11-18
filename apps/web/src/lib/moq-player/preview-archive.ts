import { createMoqAnalyticsBridge } from "./analytics";
import {
	createMoqObservationWriter,
	type MoqHistorySaveState,
} from "./history-client";
import type { MoqObservationEvent } from "./observations";
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
/** Playback can begin immediately. Capture requires acknowledged session ownership. */
export function createMoqPreviewArchive(options: Options) {
	const configuredAnalytics = options.descriptor.analytics
		? { ...options.descriptor.analytics }
		: undefined;
	const writer = createMoqObservationWriter({
		channelId: options.channelId,
		runId: options.runId,
		startedAt: options.startedAt,
		startedMonotonicMs: options.startedMonotonicMs,
		analyticsLicenseKeySha256: configuredAnalytics?.licenseKeySha256,
		onState: options.onHistoryState,
		onPersisted: options.onPersisted,
		onAnalyticsUnavailable: () => options.onAnalyticsState("unavailable"),
	});
	let analytics:
		| Awaited<ReturnType<typeof createMoqAnalyticsBridge>>
		| undefined;
	let receivingVideo: HTMLVideoElement | undefined;
	let recording: ReturnType<typeof createMoqRecording> | undefined;
	let closed = false;
	let owned = false;
	let final: Promise<void> | undefined;
	const analyticsAbort = new AbortController();

	function startRecording() {
		if (closed || !owned || !receivingVideo || recording) return;
		recording = createMoqRecording(receivingVideo, {
			upload: writer.archive,
			onState: (state) => {
				if (state === "recording") writer.event("recording-started");
				options.onRecordingState(state);
				if (state === "unconfirmed") options.onPersisted();
			},
		});
	}

	void writer.ready.then(
		() => {
			owned = true;
			startRecording();
		},
		() => {
			if (!closed) options.onRecordingState("unavailable");
		},
	);

	function attachAnalytics() {
		if (!analytics || !receivingVideo) return;
		try {
			analytics.attach(receivingVideo);
			writer.setAnalyticsImpressionId(analytics.getImpressionId());
		} catch {
			options.onAnalyticsState("unavailable");
		}
	}
	const analyticsReady = (async () => {
		if (!configuredAnalytics) {
			options.onAnalyticsState("not-configured");
			return;
		}
		try {
			const bridge = await createMoqAnalyticsBridge(
				{
					licenseKey: configuredAnalytics.licenseKey,
					videoId: configuredAnalytics.videoId,
					runId: options.runId,
					encodingId: options.descriptor.encodingId,
				},
				analyticsAbort.signal,
			);
			if (closed) {
				await bridge.dispose();
				return;
			}
			analytics = bridge;
			options.onAnalyticsState("ready");
			attachAnalytics();
		} catch {
			if (!closed) options.onAnalyticsState("unavailable");
		}
	})();
	function video(element: HTMLVideoElement) {
		if (closed || receivingVideo) return;
		receivingVideo = element;
		startRecording();
		attachAnalytics();
	}
	function statistics(value: MoqVideoStatistics) {
		if (closed) return;
		// Pending ownership can retain these bounded samples in memory. The
		// writer flushes them only after the server accepts this session.
		writer.sample(value);
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
		receivingVideo = undefined;
		analyticsAbort.abort();
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
		const media = recording?.finish() ?? Promise.resolve();
		final = (async () => {
			const results = await Promise.allSettled([
				media,
				observations,
				analyticsReady,
			]);
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
	return {
		id: writer.id,
		video,
		event: (type: MoqObservationEvent["type"], elapsedMs: number) =>
			writer.event(type, elapsedMs),
		statistics,
		finish,
	};
}
