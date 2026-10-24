import { projectIntegerBitrateSlots } from "./per-title-output-count";

// The model bounds the initial search width by 2^31. Ninety-six bisections
// also cover the 53-bit significand when narrowing a finite step above one.
const MAX_SEARCH_STEPS = 96;

/**
 * Find a maximum ratio allowing an integer chain from the first rate to the cap.
 * This checks a conditional placement, not output count, quality, or API validity.
 */
export function findCapReachingMaximumStep(input: {
	minimumBitrate: number;
	maximumBitrate: number;
	minimumStep: number;
	count: number;
}): number | null {
	if (
		!Number.isSafeInteger(input.count) ||
		input.count < 2 ||
		input.count > 256
	)
		return null;
	const reachesCap = (maximumStep: number) => {
		const projection = projectIntegerBitrateSlots({
			minimumBitrate: input.minimumBitrate,
			ceiling: input.maximumBitrate,
			minimumStep: input.minimumStep,
			maximumStep,
			count: input.count,
		});
		return (
			projection.status === "conditional" &&
			projection.slots.at(-1)?.maximum === input.maximumBitrate
		);
	};
	let lower = input.minimumStep;
	let upper = Math.max(
		input.minimumStep,
		input.maximumBitrate / input.minimumBitrate + 1,
	);
	// If any minimum-step chain fits, replacing its last point with the cap
	// fits this upper bound. The projection also validates every input.
	if (!reachesCap(upper)) return null;
	if (reachesCap(lower)) return lower;
	for (let index = 0; index < MAX_SEARCH_STEPS; index++) {
		const midpoint = lower + (upper - lower) / 2;
		if (midpoint <= lower || midpoint >= upper) break;
		if (reachesCap(midpoint)) upper = midpoint;
		else lower = midpoint;
	}
	// The predicate uses the exact decimal sent in JSON, including at boundaries
	// where a floating-point ratio would round below the required integer gap.
	return reachesCap(upper) ? upper : null;
}
