import {
	MOQ_OBSERVATION_LIMITS,
	type MoqObservationSample,
} from "./observations";

export type MoqMetricSample = Pick<
	MoqObservationSample,
	| "elapsedMs"
	| "latencyMs"
	| "fps"
	| "bufferSeconds"
	| "bufferSource"
	| "renderingSource"
>;

export type MoqViewerMetricPoint = {
	timestamp: number;
	latencyMs: number | null;
	videoFps: number | null;
	canvasUpdates: number | null;
	legacyFrameRate: number | null;
	playerBufferSeconds: number | null;
	videoBufferSeconds: number | null;
	legacyBufferSeconds: number | null;
};

const gap = {
	latencyMs: null,
	videoFps: null,
	canvasUpdates: null,
	legacyFrameRate: null,
	playerBufferSeconds: null,
	videoBufferSeconds: null,
	legacyBufferSeconds: null,
};

// Match the stored history's tolerance for one downsampled tick plus timer jitter.
const intervalMs = MOQ_OBSERVATION_LIMITS.sampleIntervalMs;
const maxContinuousIntervalMs = intervalMs * 2.5;

export function moqViewerMetricSeries(
	samples: readonly MoqMetricSample[],
	startedAt: string,
): MoqViewerMetricPoint[] {
	const origin = Date.parse(startedAt);
	if (!Number.isFinite(origin)) return [];

	const points: MoqViewerMetricPoint[] = [];
	let previous: number | undefined;
	for (const sample of samples) {
		const {
			elapsedMs,
			latencyMs,
			fps,
			renderingSource,
			bufferSeconds,
			bufferSource,
		} = sample;
		if (
			previous !== undefined &&
			elapsedMs - previous > maxContinuousIntervalMs
		) {
			points.push({ timestamp: origin + previous + intervalMs, ...gap });
		}
		points.push({
			timestamp: origin + elapsedMs,
			latencyMs,
			videoFps: renderingSource === "video" ? fps : null,
			canvasUpdates: renderingSource === "canvas" ? fps : null,
			legacyFrameRate: renderingSource ? null : fps,
			playerBufferSeconds: bufferSource === "player" ? bufferSeconds : null,
			videoBufferSeconds: bufferSource === "video" ? bufferSeconds : null,
			legacyBufferSeconds: bufferSource ? null : bufferSeconds,
		});
		previous = elapsedMs;
	}
	return points;
}

const liveSampleLimit = 60;

export function appendMoqLiveSample(
	samples: readonly MoqMetricSample[],
	sample: MoqMetricSample,
): readonly MoqMetricSample[] {
	const { elapsedMs } = sample;
	if (
		!Number.isSafeInteger(elapsedMs) ||
		elapsedMs < 0 ||
		elapsedMs <= (samples.at(-1)?.elapsedMs ?? -1)
	) {
		return samples;
	}
	return [...samples.slice(1 - liveSampleLimit), sample];
}
