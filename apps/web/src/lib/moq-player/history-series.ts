import {
	MOQ_OBSERVATION_LIMITS,
	type MoqObservationSample,
} from "./observations";

// The writer skips callbacks less than one second apart. Ordinary timer jitter
// can therefore leave about two seconds between saved points. Break the chart
// beyond that bounded cadence; explicit metric nulls remain gaps at any interval.
const maxContinuousIntervalMs = MOQ_OBSERVATION_LIMITS.sampleIntervalMs * 2.5;

type Point = {
	timestamp: number;
	seconds: number;
	latencyMs: number | null;
	fps: number | null;
	bufferSeconds: number | null;
};
export function moqHistorySeries(
	samples: MoqObservationSample[],
	startedAt: string,
): Point[] {
	const origin = Date.parse(startedAt);
	if (!Number.isFinite(origin)) return [];
	const points: Point[] = [];
	let previous: number | undefined;
	for (const sample of samples) {
		if (
			previous !== undefined &&
			sample.elapsedMs - previous > maxContinuousIntervalMs
		)
			points.push({
				timestamp: origin + previous + MOQ_OBSERVATION_LIMITS.sampleIntervalMs,
				seconds: (previous + MOQ_OBSERVATION_LIMITS.sampleIntervalMs) / 1000,
				latencyMs: null,
				fps: null,
				bufferSeconds: null,
			});
		points.push({
			timestamp: origin + sample.elapsedMs,
			seconds: sample.elapsedMs / 1000,
			latencyMs: sample.latencyMs,
			fps: sample.fps,
			bufferSeconds: sample.bufferSeconds,
		});
		previous = sample.elapsedMs;
	}
	return points;
}
