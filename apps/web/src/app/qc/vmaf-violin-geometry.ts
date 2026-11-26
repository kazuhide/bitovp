import type { VmafScoreDistribution } from "./vmaf-shared";

export function validVmafDistribution(
	value: VmafScoreDistribution | null | undefined,
): value is VmafScoreDistribution {
	return (
		!!value &&
		Number.isSafeInteger(value.frameCount) &&
		value.frameCount > 0 &&
		[value.min, value.max, value.mean, value.binWidth].every(Number.isFinite) &&
		value.min <= value.mean &&
		value.mean <= value.max &&
		value.binWidth >= 0 &&
		Array.isArray(value.bins) &&
		value.bins.length > 0 &&
		value.bins.length <= 64 &&
		value.bins.every(
			(bin) =>
				Number.isFinite(bin.score) &&
				bin.score >= value.min &&
				bin.score <= value.max &&
				Number.isSafeInteger(bin.count) &&
				bin.count >= 0,
		) &&
		value.bins.reduce((count, bin) => count + bin.count, 0) === value.frameCount
	);
}

/** Normalize before subtraction when opposite finite extremes would overflow. */
export function scoreFraction(score: number, min: number, max: number) {
	if (min === max) return 0.5;
	const range = max - min;
	return Number.isFinite(range)
		? (score - min) / range
		: (score / 2 - min / 2) / (max / 2 - min / 2);
}

export function interpolateScore(min: number, max: number, fraction: number) {
	return min * (1 - fraction) + max * fraction;
}

/** Approximate Gaussian density from all 64 histogram bins, not line samples.
 * Bandwidth is two bins (1/32 of the observed range); peak width is normalized
 * independently so different measured frame counts do not imply quality. */
export function violinDensity(distribution: VmafScoreDistribution) {
	const bandwidth = 2 / 64;
	const points = Array.from({ length: 97 }, (_, i) => {
		const position = i / 96;
		const density = distribution.bins.reduce((sum, bin) => {
			const distance =
				(position -
					scoreFraction(bin.score, distribution.min, distribution.max)) /
				bandwidth;
			return (
				sum +
				(bin.count / distribution.frameCount) *
					Math.exp(-0.5 * distance * distance)
			);
		}, 0);
		return {
			score: interpolateScore(distribution.min, distribution.max, position),
			density,
		};
	});
	const peak = Math.max(...points.map((point) => point.density));
	return points.map((point) => ({
		...point,
		density: peak > 0 ? point.density / peak : 0,
	}));
}
