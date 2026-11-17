import type { MoqObservationSample } from "./observations";

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
		if (previous !== undefined && sample.elapsedMs - previous > 1500)
			points.push({
				timestamp: origin + previous + 1000,
				seconds: (previous + 1000) / 1000,
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
