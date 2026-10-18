/**
 * Linear frame alignment for VOD scoring.
 *
 * A bounded cross-correlation over per-frame signatures, answering "by how many
 * frames does the distorted lead or lag the reference?".
 *
 * Written while chasing a real 61-point VMAF loss, on the hypothesis that the
 * clips were a frame apart. They were not — see the note at the bottom, which is
 * the reason this is a diagnostic rather than part of scoring.
 *
 * This is deliberately NOT `align.ts`. That one solves the live problem: a
 * looped feed, where the distorted may wrap around the reference several times
 * and each segment needs its own offset. A VOD mirror is one linear pass over
 * one source, so the answer is a single integer and the search is a plain
 * cross-correlation over a bounded radius.
 *
 * The output is advisory by design: `confident` is false unless the winner is
 * clearly better than the runner-up, and the caller then scores at offset 0
 * rather than shifting on noise. A wrong shift would be worse than no shift —
 * it would move a correct comparison off by a frame.
 *
 * ── WHY THE VOD SCORER DOES NOT CALL THIS ─────────────────────────────────────
 *
 * It was written for the misalignment above and then measured, and the
 * measurement said the clips were NOT misaligned: on the real `vmaf-only-h264`
 * mirror the luma distance at offset 0 was 0.044 against 0.756 at ±1 — this
 * function answered "aligned, and confidently so", correctly. The 61-point loss
 * was a **timestamp** offset: libvmaf pairs frames through ffmpeg's framesync,
 * i.e. by PTS, so a mezzanine with a non-zero first PTS had its frame N scored
 * against the encode's frame N±1 while both files were frame-for-frame aligned.
 * `buildVmafCommand` now re-times both pads and the score went 23.08 → 84.24
 * with no frames dropped.
 *
 * So this stays as the DIAGNOSTIC it proved to be — `scripts/vmaf-offset-sweep.ts`
 * prints its verdict beside the VMAF curve, and that pairing is exactly what
 * separated the two hypotheses. It is deliberately not in the scoring path: a
 * search that fires on nothing is a liability, and it would risk shifting a
 * comparison that is already correct.
 */

export type LinearAlignment = {
	/**
	 * Frames to drop from the head. Positive drops from the REFERENCE (the
	 * reference runs ahead); negative drops from the DISTORTED. Zero means
	 * aligned, or not confidently otherwise.
	 */
	offset: number;
	/** Mean absolute difference at `offset` — lower is a better match. */
	distance: number;
	/** The best distance among all OTHER offsets, for legible confidence. */
	runnerUp: number;
	/** Candidates searched: every offset in [-radius, radius]. */
	radius: number;
	/**
	 * True when the winner beats the runner-up by `minMargin`. When false the
	 * caller must not shift: the signatures do not distinguish the candidates,
	 * and guessing would risk turning a correct comparison into a wrong one.
	 */
	confident: boolean;
	/** Frames compared at the winning offset. */
	overlap: number;
};

export type LinearAlignOptions = {
	/** Half-width of the search, in frames. Default 12. */
	radius?: number;
	/**
	 * The winner must be at most `1 - minMargin` times the runner-up's distance.
	 * Default 0.1 — a 10% improvement, enough to separate a real one-frame shift
	 * (which roughly halves the distance on moving content) from sampling noise
	 * on a static clip, where every offset scores about the same and shifting
	 * would be a coin flip.
	 */
	minMargin?: number;
	/** Fewer overlapping frames than this ⇒ not comparable. Default 24. */
	minOverlap?: number;
};

export const DEFAULT_LINEAR_RADIUS = 12;
const DEFAULT_MIN_MARGIN = 0.1;
const DEFAULT_MIN_OVERLAP = 24;

/** Mean |a-b| over the frames the two series share at this offset. */
function distanceAt(
	reference: readonly number[],
	distorted: readonly number[],
	offset: number,
): { distance: number; overlap: number } {
	// offset > 0 ⇒ reference starts later, so compare ref[i+offset] with dis[i].
	const refFrom = offset > 0 ? offset : 0;
	const disFrom = offset < 0 ? -offset : 0;
	const overlap = Math.min(
		reference.length - refFrom,
		distorted.length - disFrom,
	);
	if (overlap <= 0) {
		return { distance: Number.POSITIVE_INFINITY, overlap: 0 };
	}
	let sum = 0;
	for (let i = 0; i < overlap; i += 1) {
		sum += Math.abs(
			(reference[refFrom + i] ?? 0) - (distorted[disFrom + i] ?? 0),
		);
	}
	return { distance: sum / overlap, overlap };
}

/**
 * Finds the offset that best aligns two per-frame signature series.
 *
 * Ties and near-ties resolve to offset 0 through `confident: false`, and offset
 * 0 is preferred among equal distances — an aligned pair must never be shifted
 * because some other offset happened to score identically.
 */
export function alignLinearSignatures(
	reference: readonly number[],
	distorted: readonly number[],
	options: LinearAlignOptions = {},
): LinearAlignment {
	const radius = Math.max(0, options.radius ?? DEFAULT_LINEAR_RADIUS);
	const minMargin = options.minMargin ?? DEFAULT_MIN_MARGIN;
	const minOverlap = options.minOverlap ?? DEFAULT_MIN_OVERLAP;

	const zero = distanceAt(reference, distorted, 0);
	let best = { offset: 0, ...zero };
	let runnerUp = Number.POSITIVE_INFINITY;

	for (let offset = -radius; offset <= radius; offset += 1) {
		if (offset === 0) {
			continue;
		}
		const at = distanceAt(reference, distorted, offset);
		if (at.overlap < minOverlap) {
			continue;
		}
		if (at.distance < best.distance) {
			runnerUp = best.distance;
			best = { offset, ...at };
		} else if (at.distance < runnerUp) {
			runnerUp = at.distance;
		}
	}

	const comparable = best.overlap >= minOverlap;
	const confident =
		comparable &&
		best.offset !== 0 &&
		Number.isFinite(runnerUp) &&
		best.distance <= runnerUp * (1 - minMargin);

	return {
		offset: confident ? best.offset : 0,
		distance: comparable ? best.distance : Number.POSITIVE_INFINITY,
		runnerUp,
		radius,
		confident,
		overlap: best.overlap,
	};
}
