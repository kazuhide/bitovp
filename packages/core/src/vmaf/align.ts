/**
 * Pseudo-live VMAF alignment engine (P4 — the novel core of live VMAF).
 *
 * THE PROBLEM (ARCHITECTURE.md §6, live/pseudo-live). A pseudo-live channel
 * pushes a SOURCE MP4 of `F` frames on an infinite loop (ffmpeg
 * `-stream_loop -1`). We later capture a window of OUTPUT frames and must
 * know, for each captured output frame `i`, WHICH source frame it shows so we
 * can run libvmaf reference-vs-distorted. Because the source is periodic the
 * mapping is
 *
 *     source_index(i) = (i + offset) mod F
 *
 * where `offset` is unknown — it depends on where in the loop the capture
 * began — and may DRIFT slowly over a long capture (encoder / clock skew). The
 * feeder records loop boundaries ([{ loopIndex, wallClock, streamTimeSec }],
 * ~0.5 s granularity), from which a later integration PR derives a COARSE
 * frame offset; THIS module refines that to frame accuracy by cross-correlating
 * per-frame signatures, and reports a CONFIDENCE so a caller can warn instead
 * of trusting a bogus alignment.
 *
 * PURITY. This file is pure math: it takes already-extracted numeric
 * signatures (one discriminative scalar per frame — average luma in the real
 * pipeline) and returns the alignment. Frame capture, segment concat, real
 * signature extraction via ffmpeg, and the windowed-libvmaf report are a later
 * PR (PR6b); none of that is here.
 *
 * ±1-FRAME CAVEAT. Alignment is best-effort to within ±1 frame. B-frame
 * reordering and encoder pipeline latency mean the output frame that visually
 * matches source frame N may be emitted as N−1 or N+1; a one-frame-off
 * alignment still yields a near-correct VMAF (adjacent frames are highly
 * similar) but is not provably exact. Callers should treat `offset` as
 * accurate to ±1 and rely on `confidence` to gate the result.
 */

/** Where one source-loop wrap (`(i+offset) mod F` returns to 0) falls in the captured window. */
export type LoopMapEntry = {
	/** Output-frame index (into `distortedSignatures`) where this loop begins. */
	outputFrameStart: number;
	/** Source-frame index at that output frame — always 0 except possibly the first (partial) entry. */
	sourceFrameStart: number;
	/** 0 for the loop in progress at capture start, incrementing by 1 at each wrap. */
	loopIndex: number;
};

/** Per-window drift verdict (constant offset ⇒ not detected). */
export type DriftReport = {
	/** True when the per-segment offset spread exceeds ±1 frame across the window. */
	detected: boolean;
	/**
	 * max − min of the per-segment offsets, in frames (0 when constant). For
	 * `alignLoopedSegments` the span covers the INCLUDED segments only, while
	 * `perSegmentOffsets` still lists every segment.
	 */
	maxDriftFrames: number;
	/** Best offset estimated independently per window segment, in capture order (unwrapped: may be negative or ≥ F). */
	perSegmentOffsets: number[];
};

/** Result of aligning a captured output window to a looping source. */
export type AlignmentResult = {
	/**
	 * Recovered frame offset: `source_index(i) = (i + offset) mod F`. Normalized
	 * into [0, F). Accurate to ±1 frame (see the module ±1-frame caveat).
	 */
	offset: number;
	/**
	 * 0–1 alignment confidence. ~1 when the best offset is both a strong match
	 * (high normalized cross-correlation) AND a sharp, unambiguous peak (clearly
	 * beats the runner-up); ~0 when the distorted window is noise / unrelated.
	 * Gate downstream VMAF on this — a low value means "do not trust `offset`".
	 */
	confidence: number;
	/** Slow-drift verdict over the window (split into `segmentCount` chunks). */
	drift: DriftReport;
	/**
	 * Compact source-loop wrap map for the captured window: one entry per loop
	 * boundary, `loopIndex` incrementing at each wrap. A ≥3-loop capture yields
	 * ≥3 entries. Use it to slice the window into per-loop libvmaf runs.
	 */
	loopMap: LoopMapEntry[];
	/**
	 * Source frame shown at output frame `i`: `(i + offset) mod F`. Bound to the
	 * recovered (constant) `offset` — drift is reported separately, not folded
	 * in, so this stays the simple periodic map the caller can trust to ±1.
	 */
	sourceIndexAt(i: number): number;
};

/** Options for {@link alignLoopedSignatures}. */
export type AlignOptions = {
	/**
	 * Feeder-anchor offset estimate (frames). When given, the search is centered
	 * here within ±`searchRadius`; when omitted, the full period [0, F) is
	 * searched (slower but anchor-free — proven by the "no coarse anchor" test).
	 */
	coarseOffset?: number;
	/**
	 * ± frames to search around `coarseOffset`. Default {@link DEFAULT_SEARCH_RADIUS}
	 * (≈3 s @ 30 fps). Ignored when `coarseOffset` is omitted (full search).
	 */
	searchRadius?: number;
	/**
	 * Number of equal chunks to split the window into for drift estimation.
	 * Default {@link DEFAULT_SEGMENT_COUNT}. Clamped to the number of frames.
	 */
	segmentCount?: number;
};

/** Default ± search radius around a coarse anchor: ≈3 s at 30 fps. */
export const DEFAULT_SEARCH_RADIUS = 90;

/** Default number of window segments used to estimate drift. */
export const DEFAULT_SEGMENT_COUNT = 4;

/**
 * Drift threshold: per-segment offsets spanning MORE than this many frames mark
 * `drift.detected`. 1 frame absorbs the ±1-frame estimation jitter — a truly
 * constant offset can wobble by a frame between segments under noise, so only a
 * span strictly greater than 1 is real drift.
 */
const DRIFT_THRESHOLD_FRAMES = 1;

/**
 * A rival offset (for confidence sharpness) must be at least this far from the
 * winner on the ring, so the true peak's ±1 neighbours never count as rivals.
 * Decoupled from DRIFT_THRESHOLD_FRAMES on purpose — they share the value 2-vs-1
 * by coincidence, not meaning.
 */
const RIVAL_MIN_RING = 2;

/**
 * The fewest comparable frames a candidate may rank on, whatever the slice
 * (rev427 round 4): two zero-meaned points always correlate ±1 and a three
 * or four-frame tail still aligned on its own in the reviewer's census —
 * on the UNMASKED path too, where a normalized source has no hole and a
 * short tail segment is the normal case. Applied in both scorer branches.
 */
const MIN_COMPARABLE_FRAMES = 5;

/** The comparable-frame floor for a slice: never below the absolute minimum, at least a quarter of the slice. */
function comparableFloor(slice: number): number {
	return Math.max(MIN_COMPARABLE_FRAMES, Math.ceil(slice / 4));
}

/** Euclidean modulo: result always in [0, m) even for negative `n`. */
function mod(n: number, m: number): number {
	return ((n % m) + m) % m;
}

/**
 * Mean of a slice of `values` (indices [start, end)). Caller guarantees a
 * non-empty range.
 */
function meanOf(values: number[], start: number, end: number): number {
	let sum = 0;
	for (let i = start; i < end; i++) {
		sum += values[i] as number;
	}
	return sum / (end - start);
}

/**
 * Score one candidate `offset` against a [start, end) slice of the distorted
 * window. Returns BOTH:
 *  - `dist`: mean absolute difference between zero-meaned distorted and
 *    zero-meaned source `(i+offset) mod F` — the quantity we MINIMIZE to pick
 *    the offset. Zero-meaning each side independently makes the match invariant
 *    to a DC / brightness level shift between source and encode.
 *  - `ncc`: normalized cross-correlation of the same two zero-meaned vectors,
 *    in roughly [−1, 1] (1 = identical shape). Feeds the confidence metric —
 *    it is scale-invariant where `dist` is not, so it reads "how much like the
 *    source is this, regardless of contrast" for free from the same loop.
 *
 * Both reductions zero-mean using the slice means so a partial-loop window is
 * still centred correctly.
 */
function scoreOffset(
	distorted: number[],
	source: number[],
	offset: number,
	start: number,
	end: number,
	mask?: readonly boolean[],
): { dist: number; ncc: number; comparable: number } {
	const f = source.length;
	if (!mask) {
		// No floor here: this branch is the legacy `alignLoopedSignatures` path
		// too, whose drift chunks may be a few frames on a sub-second window.
		// The segment aligner applies MIN_COMPARABLE_FRAMES to its own slices.
		return {
			...scoreOffsetUnmasked(distorted, source, offset, start, end),
			comparable: end - start,
		};
	}
	// : a source frame inside a loop hole has no true reference, so
	// the output frames that map onto it are left out of both reductions.
	// A candidate that leaves fewer than a QUARTER of the slice (and never
	// fewer than 5 frames) comparable cannot rank (rev427 C1, tuned in the
	// re-review): `dist` is a mean over a per-candidate `n`, so the argmin is
	// biased toward tiny `n`, and two zero-meaned points always correlate ±1
	// — with a hole longer than the segment, a wrong offset with exactly two
	// comparable frames won with confidence 1.000. A census over hole sizes
	// 30…150 on 60-frame segments: a floor of 3–5 already stops every
	// spurious win; the half-slice floor tried first put the  sample
	// (hole 30) on a cliff where a hole of 31 dropped a fifth of every
	// window. A quarter keeps full coverage down to a 45-frame hole and
	// still excludes a segment that is mostly hole.
	const floor = comparableFloor(end - start);
	let n = 0;
	let distSum = 0;
	let srcSum = 0;
	for (let i = start; i < end; i++) {
		const idx = mod(i + offset, f);
		if (mask[idx]) {
			continue;
		}
		n += 1;
		distSum += distorted[i] as number;
		srcSum += source[idx] as number;
	}
	if (n < floor) {
		return { dist: Number.POSITIVE_INFINITY, ncc: 0, comparable: n };
	}
	const distMean = distSum / n;
	const srcMean = srcSum / n;
	let absSum = 0;
	let dot = 0;
	let distEnergy = 0;
	let srcEnergy = 0;
	for (let i = start; i < end; i++) {
		const idx = mod(i + offset, f);
		if (mask[idx]) {
			continue;
		}
		const d = (distorted[i] as number) - distMean;
		const s = (source[idx] as number) - srcMean;
		absSum += Math.abs(d - s);
		dot += d * s;
		distEnergy += d * d;
		srcEnergy += s * s;
	}
	const denom = Math.sqrt(distEnergy * srcEnergy);
	const ncc = denom === 0 ? 0 : dot / denom;
	return { dist: absSum / n, ncc, comparable: n };
}

function scoreOffsetUnmasked(
	distorted: number[],
	source: number[],
	offset: number,
	start: number,
	end: number,
): { dist: number; ncc: number } {
	const f = source.length;
	const distMean = meanOf(distorted, start, end);
	// Mean of the source samples actually visited, so NCC is correctly centred
	// even when the slice covers a fraction of the period.
	let srcVisitedSum = 0;
	for (let i = start; i < end; i++) {
		srcVisitedSum += source[mod(i + offset, f)] as number;
	}
	const srcMean = srcVisitedSum / (end - start);

	let absSum = 0;
	let dot = 0;
	let distEnergy = 0;
	let srcEnergy = 0;
	for (let i = start; i < end; i++) {
		const d = (distorted[i] as number) - distMean;
		const s = (source[mod(i + offset, f)] as number) - srcMean;
		absSum += Math.abs(d - s);
		dot += d * s;
		distEnergy += d * d;
		srcEnergy += s * s;
	}
	const n = end - start;
	const denom = Math.sqrt(distEnergy * srcEnergy);
	// denom 0 ⇒ one side is perfectly flat (no discriminative content); NCC is
	// undefined, report 0 (no correlation) rather than NaN.
	const ncc = denom === 0 ? 0 : dot / denom;
	return { dist: absSum / n, ncc };
}

/**
 * Candidate offsets to evaluate, derived from the options. With a coarse anchor
 * we scan a window of width 2·radius+1 centred on it (each candidate later
 * normalized mod F); without one we scan the full period [0, F). Returned as a
 * de-duplicated, in-range (mod F) sorted list so the full-search and
 * anchored-search paths share the same evaluation/argmin code.
 */
function candidateOffsets(
	f: number,
	coarseOffset: number | undefined,
	searchRadius: number,
): number[] {
	if (coarseOffset === undefined) {
		return Array.from({ length: f }, (_, k) => k);
	}
	const center = Math.round(coarseOffset);
	const seen = new Set<number>();
	for (let delta = -searchRadius; delta <= searchRadius; delta++) {
		seen.add(mod(center + delta, f));
	}
	return [...seen].sort((a, b) => a - b);
}

/**
 * Best offset over a [start, end) slice, with the data the confidence metric
 * needs. Used both for the global estimate and for each drift segment.
 *
 * "Best" = minimum zero-mean mean-abs distance (the offset we report); ties
 * keep the smaller offset (deterministic). Alongside it we capture:
 *  - `ncc`:       the winner's normalized cross-correlation (scale-invariant
 *                 match strength).
 *  - `secondNcc`: the HIGHEST ncc among RIVAL offsets — offsets ≥2 frames from
 *                 the winner on the ring (a peak one frame wide is still "the
 *                 same" alignment to ±1, so near-neighbours never count as
 *                 rivals). The gap (ncc − secondNcc) is the peak SHARPNESS, and
 *                 because both terms are NCC it stays robust to a contrast/gain
 *                 shift between source and encode (where raw distances compress).
 */
function bestOffsetOverSlice(
	distorted: number[],
	source: number[],
	offsets: number[],
	start: number,
	end: number,
	mask?: readonly boolean[],
): {
	offset: number;
	dist: number;
	ncc: number;
	secondNcc: number;
	comparable: number;
} {
	const f = source.length;
	// Score every candidate once; the rival pass reads the cache (rev427 O1).
	const scores = offsets.map((off) =>
		scoreOffset(distorted, source, off, start, end, mask),
	);
	let bestIndex = 0;
	let bestDist = Number.POSITIVE_INFINITY;
	for (let k = 0; k < offsets.length; k++) {
		const dist = (scores[k] as { dist: number }).dist;
		if (dist < bestDist) {
			bestDist = dist;
			bestIndex = k;
		}
	}
	const bestOffset = offsets[bestIndex] as number;
	const best = scores[bestIndex] as { ncc: number; comparable: number };
	// Runner-up correlation: the strongest ncc among offsets ≥2 frames from the
	// winner on the ring. −Infinity when there is no rival (e.g. F is tiny or the
	// search produced only the winner + neighbours) → an unambiguous lone peak.
	let secondNcc = Number.NEGATIVE_INFINITY;
	for (let k = 0; k < offsets.length; k++) {
		const off = offsets[k] as number;
		const ring = Math.min(mod(off - bestOffset, f), mod(bestOffset - off, f));
		if (ring < RIVAL_MIN_RING) {
			continue;
		}
		const ncc = (scores[k] as { ncc: number }).ncc;
		if (ncc > secondNcc) {
			secondNcc = ncc;
		}
	}
	return {
		offset: bestOffset,
		dist: bestDist,
		ncc: Number.isFinite(bestDist) ? best.ncc : 0,
		secondNcc,
		comparable: best.comparable,
	};
}

/**
 * Build the loop-wrap map for the recovered offset over `[0, windowLength)`.
 * Output frame `i` shows source `(i+offset) mod F`; a new loop begins wherever
 * that value is 0. The first entry covers the partial loop in progress at
 * capture start (loopIndex 0, sourceFrameStart = offset mod F); each subsequent
 * 0-crossing increments loopIndex. A ≥3-loop window therefore yields ≥3
 * entries.
 */
function buildLoopMap(
	offset: number,
	f: number,
	windowLength: number,
): LoopMapEntry[] {
	const map: LoopMapEntry[] = [];
	if (windowLength <= 0) {
		return map;
	}
	const firstSource = mod(offset, f);
	map.push({
		outputFrameStart: 0,
		sourceFrameStart: firstSource,
		loopIndex: 0,
	});
	let loopIndex = 1;
	// The in-progress loop wraps after (F − firstSource) output frames; thereafter
	// every F frames. Emit each wrap that lands strictly inside the window.
	for (let out = f - firstSource; out < windowLength; out += f, loopIndex++) {
		map.push({ outputFrameStart: out, sourceFrameStart: 0, loopIndex });
	}
	return map;
}

/**
 * Aligns a captured pseudo-live OUTPUT window to its looping SOURCE by
 * cross-correlating per-frame signatures, recovering the frame offset, a
 * confidence, a slow-drift verdict, and the source-loop wrap map.
 *
 * @param sourceSignatures   length-F discriminative scalar per SOURCE frame.
 * @param distortedSignatures captured window's per-frame scalars (length W;
 *   typically W can exceed F since the source loops).
 * @param options            coarse anchor / search radius / drift segment count.
 *
 * Algorithm:
 *  1. OFFSET — for each candidate offset (full [0,F) or ±radius around the
 *     coarse anchor) compute the zero-mean mean-abs distance between distorted
 *     and source `(i+offset) mod F`; pick the minimizer. Zero-meaning makes it
 *     robust to a DC/level shift; `mod F` handles W ≠ F and wrap.
 *  2. CONFIDENCE — combine the winner's normalized cross-correlation (absolute
 *     match strength, ~0 for noise) with its peak SHARPNESS (how much its
 *     distance beats the runner-up that is ≥2 frames away). See `confidence`.
 *  3. DRIFT — re-estimate the offset on each of `segmentCount` window chunks
 *     (searching a bounded ±window around the global offset); if the per-segment
 *     offsets span more than ±1 frame, flag drift with the spread.
 *  4. LOOP MAP — walk `(i+offset) mod F` recording each return-to-0 wrap.
 *
 * Throws on an empty source or distorted array (nothing to align).
 */
export function alignLoopedSignatures(
	sourceSignatures: number[],
	distortedSignatures: number[],
	options: AlignOptions = {},
): AlignmentResult {
	const f = sourceSignatures.length;
	const w = distortedSignatures.length;
	if (f === 0) {
		throw new Error("alignLoopedSignatures requires a non-empty source");
	}
	if (w === 0) {
		throw new Error(
			"alignLoopedSignatures requires a non-empty distorted window",
		);
	}

	const searchRadius = options.searchRadius ?? DEFAULT_SEARCH_RADIUS;
	const offsets = candidateOffsets(f, options.coarseOffset, searchRadius);

	// ── 1. global offset over the whole window ───────────────────────────────
	const global = bestOffsetOverSlice(
		distortedSignatures,
		sourceSignatures,
		offsets,
		0,
		w,
	);
	const offset = mod(global.offset, f);

	// ── 2. confidence ────────────────────────────────────────────────────────
	const confidence = computeConfidence(global.ncc, global.secondNcc);

	// ── 3. drift over segments ───────────────────────────────────────────────
	const drift = estimateDrift(
		distortedSignatures,
		sourceSignatures,
		offset,
		options.segmentCount ?? DEFAULT_SEGMENT_COUNT,
	);

	// ── 4. loop-wrap map ─────────────────────────────────────────────────────
	const loopMap = buildLoopMap(offset, f, w);

	return {
		offset,
		confidence,
		drift,
		loopMap,
		sourceIndexAt: (i: number) => mod(i + offset, f),
	};
}

/**
 * Maps the winner's correlation and its nearest rival's correlation into a 0–1
 * confidence. Both inputs are normalized cross-correlations, so the whole
 * metric is invariant to a contrast/gain shift between source and encode (unlike
 * the raw distances used to PICK the offset).
 *
 * Two independent signals, multiplied so BOTH must hold:
 *  - `strength` = clamp(ncc, 0, 1): the absolute correlation of the best
 *    alignment. ~1 when the distorted window really is the source (shape
 *    matches); ~0 for unrelated/noise signatures (the "low confidence" case).
 *    A negative correlation is no evidence of alignment → 0.
 *  - `sharpness` = (ncc − secondNcc) / (1 − secondNcc): how decisively the
 *    winner out-correlates the best RIVAL offset (≥2 frames away), measured as a
 *    fraction of the headroom above that rival. ~1 when the peak is sharp and
 *    unique; ~0 when some other offset correlates almost as well (ambiguous /
 *    self-similar signal). When there is no rival (secondNcc = −∞, e.g. F tiny)
 *    sharpness is 1: a lone valid peak is unambiguous by construction. Clamped
 *    to [0, 1]; a rival with ncc ≥ winner (degenerate) → 0.
 *
 * confidence = strength · sharpness, clamped to [0, 1]. Multiplying (not
 * averaging) means a strong-but-ambiguous OR sharp-but-weak match still scores
 * low — exactly when a caller should distrust the offset.
 */
function computeConfidence(ncc: number, secondNcc: number): number {
	const strength = ncc > 1 ? 1 : ncc > 0 ? ncc : 0;
	let sharpness: number;
	if (!Number.isFinite(secondNcc)) {
		// No rival offset ⇒ a lone valid peak is unambiguous; strength still gates
		// noise out.
		sharpness = 1;
	} else {
		const headroom = 1 - secondNcc;
		// headroom ≤ 0 means the rival already correlates ≥1 (perfect) — there is
		// no room for the winner to be sharper, so the peak is not distinguishable.
		sharpness = headroom <= 0 ? 0 : (ncc - secondNcc) / headroom;
		if (sharpness < 0) {
			sharpness = 0;
		} else if (sharpness > 1) {
			sharpness = 1;
		}
	}
	const c = strength * sharpness;
	if (c < 0) {
		return 0;
	}
	return c > 1 ? 1 : c;
}

/**
 * Splits the window into `segmentCount` equal chunks and re-estimates the
 * offset on each, searching a bounded ±window AROUND the global offset. Reports
 * the per-segment offsets and whether their span exceeds the ±1-frame threshold.
 *
 * Anchoring on the global offset is what makes a CONSTANT offset read as zero
 * spread (every segment re-finds the same minimum) while a real ramp shows up
 * as a monotone shift. The radius is DEFAULT_SEARCH_RADIUS (≈3 s @ 30 fps),
 * floored at DRIFT_THRESHOLD_FRAMES+2 so even a tiny source still has room to
 * register a 1-frame step, and capped at F−1: wide enough to follow any
 * plausible slow drift (sub-second over a capture) yet still anchored, so a
 * short noisy segment cannot latch onto a far-away unrelated minimum. Segment
 * offsets are expressed RELATIVE to the global offset (wrap-unwrapped into
 * (−F/2, F/2]) so a window straddling the F−1→0 boundary does not report a
 * spurious ~F drift.
 */
function estimateDrift(
	distorted: number[],
	source: number[],
	globalOffset: number,
	segmentCount: number,
): DriftReport {
	const f = source.length;
	const w = distorted.length;
	// Bounded per-segment search radius around the global anchor (see doc above).
	const localRadius = Math.min(
		f - 1,
		Math.max(DRIFT_THRESHOLD_FRAMES + 2, DEFAULT_SEARCH_RADIUS),
	);
	const localOffsets = candidateOffsets(f, globalOffset, localRadius);

	const segs = Math.max(1, Math.min(segmentCount, w));
	const perSegmentOffsets: number[] = [];
	for (let s = 0; s < segs; s++) {
		const start = Math.floor((s * w) / segs);
		const end = Math.floor(((s + 1) * w) / segs);
		if (end <= start) {
			continue;
		}
		const best = bestOffsetOverSlice(
			distorted,
			source,
			localOffsets,
			start,
			end,
		);
		// Unwrap relative to the global offset into (−F/2, F/2] so a wrap boundary
		// inside the window doesn't masquerade as drift, then re-add globalOffset.
		let rel = mod(best.offset - globalOffset, f);
		if (rel > f / 2) {
			rel -= f;
		}
		perSegmentOffsets.push(globalOffset + rel);
	}

	if (perSegmentOffsets.length === 0) {
		return { detected: false, maxDriftFrames: 0, perSegmentOffsets: [] };
	}
	let lo = perSegmentOffsets[0] as number;
	let hi = lo;
	for (const o of perSegmentOffsets) {
		if (o < lo) {
			lo = o;
		}
		if (o > hi) {
			hi = o;
		}
	}
	const maxDriftFrames = hi - lo;
	return {
		detected: maxDriftFrames > DRIFT_THRESHOLD_FRAMES,
		maxDriftFrames,
		perSegmentOffsets,
	};
}

// ── : per-segment alignment over the FULL period ───────────────────

/** Segments below this confidence are excluded from the window estimate and from pooling. */
export const DEFAULT_INCLUDE_CONFIDENCE = 0.5;

/** One captured segment's own alignment. */
export type SegmentAlignment = {
	index: number;
	/** Output-frame range `[frameStart, frameEnd)` of the segment. */
	frameStart: number;
	frameEnd: number;
	/** Best offset for this segment alone, in [0, F). */
	offset: number;
	confidence: number;
	/**
	 * Output frames of this segment that had a reference (unmasked) at the
	 * segment's OWN winning offset — meaningful for an included segment; for
	 * an excluded one it is whatever the least-bad candidate saw.
	 */
	comparableFrames: number;
	/**
	 * Output frames of this segment that have a reference at the WINDOW
	 * offset — the number that explains an exclusion (a mostly-hole segment
	 * reads a small value here whatever its own candidate saw).
	 */
	comparableAtWindowOffset: number;
	/** `confidence >= includeThreshold`: counts toward the window offset and is scored. */
	included: boolean;
};

export type SegmentAlignOptions = {
	/** Output frames per segment — the encoder's segment length × fps. ≥ 1. */
	segmentFrames: number;
	/**
	 * Per SOURCE frame (length F): true where the source has no true reference
	 * (a loop hole, see `loop-timeline.ts`). Such frames never enter scoring.
	 */
	mask?: readonly boolean[];
	/** Default {@link DEFAULT_INCLUDE_CONFIDENCE}. */
	includeThreshold?: number;
};

export type SegmentAlignmentResult = AlignmentResult & {
	segments: SegmentAlignment[];
	includedSegments: number;
	/**
	 * Included segments whose offset is within the drift threshold (±1) of
	 * the window offset. The window `confidence` is the median segment
	 * confidence scaled by `agreeingSegments / includedSegments`: it reads
	 * "how well ONE offset explains the window", so a slow 5-frame drift and
	 * a 2-vs-2 bimodal window BOTH read ≈ 0.5 — only `drift.maxDriftFrames`
	 * tells them apart (a few frames vs ≈ F/2). A noise-free 2-vs-2 window
	 * is exactly 0.5, so gate on an agreeing MAJORITY
	 * (`agreeingSegments * 2 > includedSegments`) rather than on 0.5 alone.
	 */
	agreeingSegments: number;
	/** Output frames inside included segments. */
	includedFrames: number;
};

/** Unwrap a ring difference into (−F/2, F/2]. */
function unwrap(delta: number, f: number): number {
	let rel = mod(delta, f);
	if (rel > f / 2) {
		rel -= f;
	}
	return rel;
}

/** Lower-middle element of the sorted values (an integer input stays an integer). */
function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor((sorted.length - 1) / 2)] as number;
}

/**
 * Aligns a captured window SEGMENT BY SEGMENT, each over the FULL period
 * [0, F) — no anchor, so a wrong coarse estimate cannot push the true offset
 * out of reach (F × W is cheap: 301 × 1800 ≈ 0.5 M comparisons). The window
 * offset is the ring-median of the segments whose confidence clears the
 * threshold, the drift verdict is their spread, and every segment reports
 * whether it is INCLUDED — a caller scores only included, unmasked frames, so
 * one broken segment costs one segment, not the window .
 *
 * Throws on an empty source or window, a non-positive `segmentFrames`, a mask
 * whose length is not F, or a mask that leaves no source frame.
 */
export function alignLoopedSegments(
	sourceSignatures: number[],
	distortedSignatures: number[],
	options: SegmentAlignOptions,
): SegmentAlignmentResult {
	const f = sourceSignatures.length;
	const w = distortedSignatures.length;
	if (f === 0) {
		throw new Error("alignLoopedSegments requires a non-empty source");
	}
	if (w === 0) {
		throw new Error(
			"alignLoopedSegments requires a non-empty distorted window",
		);
	}
	const segmentFrames = Math.floor(options.segmentFrames);
	if (!(segmentFrames >= 1)) {
		throw new Error(
			`alignLoopedSegments: segmentFrames must be ≥ 1 (${options.segmentFrames})`,
		);
	}
	const mask = options.mask;
	if (mask && mask.length !== f) {
		throw new Error(
			`alignLoopedSegments: mask has ${mask.length} entries for ${f} source frames`,
		);
	}
	if (mask?.every((m) => m)) {
		throw new Error("alignLoopedSegments: every source frame is masked");
	}
	const threshold = options.includeThreshold ?? DEFAULT_INCLUDE_CONFIDENCE;
	const offsets = candidateOffsets(f, undefined, 0);

	const segments: SegmentAlignment[] = [];
	for (let start = 0, index = 0; start < w; start += segmentFrames, index++) {
		const end = Math.min(w, start + segmentFrames);
		// A slice shorter than the absolute floor (a 3-frame tail) never
		// aligns on its own, masked or not — see MIN_COMPARABLE_FRAMES.
		const best =
			end - start < MIN_COMPARABLE_FRAMES
				? {
						offset: 0,
						dist: Number.POSITIVE_INFINITY,
						ncc: 0,
						secondNcc: Number.NEGATIVE_INFINITY,
						comparable: end - start,
					}
				: bestOffsetOverSlice(
						distortedSignatures,
						sourceSignatures,
						offsets,
						start,
						end,
						mask,
					);
		const confidence = Number.isFinite(best.dist)
			? computeConfidence(best.ncc, best.secondNcc)
			: 0;
		segments.push({
			index,
			frameStart: start,
			frameEnd: end,
			offset: mod(best.offset, f),
			confidence,
			comparableFrames: best.comparable,
			comparableAtWindowOffset: 0, // filled once the window offset is known
			included: confidence >= threshold,
		});
	}
	const included = segments.filter((seg) => seg.included);

	let offset: number;
	let confidence: number;
	if (included.length === 0) {
		// Nothing clears the bar: report the least-bad segment so the caller
		// still sees a number, gated by its (low) confidence.
		const best = segments.reduce((a, b) =>
			b.confidence > a.confidence ? b : a,
		);
		offset = best.offset;
		confidence = best.confidence;
	} else {
		// The unwrap depends on the anchor: around an outlier the cluster splits
		// to ±F/2 and the median lands on the outlier (rev427 R1). Anchor on the
		// included offset that keeps the others closest on the ring.
		let anchor = (included[0] as SegmentAlignment).offset;
		let anchorSpread = Number.POSITIVE_INFINITY;
		for (const candidate of included) {
			const spread = included.reduce(
				(acc, seg) => acc + Math.abs(unwrap(seg.offset - candidate.offset, f)),
				0,
			);
			if (spread < anchorSpread) {
				anchorSpread = spread;
				anchor = candidate.offset;
			}
		}
		offset = mod(
			anchor + median(included.map((seg) => unwrap(seg.offset - anchor, f))),
			f,
		);
		confidence = median(included.map((seg) => seg.confidence));
	}
	// Frames with a reference at the WINDOW offset, per segment.
	for (const seg of segments) {
		let n = 0;
		for (let i = seg.frameStart; i < seg.frameEnd; i++) {
			if (!mask?.[mod(i + offset, f)]) n += 1;
		}
		seg.comparableAtWindowOffset = n;
	}
	// Agreement: included segments within the drift threshold of the window
	// offset. A confident bimodal window is not a confident window.
	const agreeingSegments = included.filter(
		(seg) => Math.abs(unwrap(seg.offset - offset, f)) <= DRIFT_THRESHOLD_FRAMES,
	).length;
	if (included.length > 0) {
		confidence *= agreeingSegments / included.length;
	}

	// Drift: every segment's offset relative to the window offset (unwrapped);
	// the verdict spans the INCLUDED ones only.
	const perSegmentOffsets = segments.map(
		(seg) => offset + unwrap(seg.offset - offset, f),
	);
	let lo = Number.POSITIVE_INFINITY;
	let hi = Number.NEGATIVE_INFINITY;
	for (const seg of included) {
		const rel = offset + unwrap(seg.offset - offset, f);
		if (rel < lo) lo = rel;
		if (rel > hi) hi = rel;
	}
	const maxDriftFrames = included.length === 0 ? 0 : hi - lo;

	return {
		offset,
		confidence,
		drift: {
			detected: maxDriftFrames > DRIFT_THRESHOLD_FRAMES,
			maxDriftFrames,
			perSegmentOffsets,
		},
		loopMap: buildLoopMap(offset, f, w),
		sourceIndexAt: (i: number) => mod(i + offset, f),
		segments,
		includedSegments: included.length,
		agreeingSegments,
		includedFrames: included.reduce(
			(acc, seg) => acc + (seg.frameEnd - seg.frameStart),
			0,
		),
	};
}
