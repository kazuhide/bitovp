import { z } from "zod";

/**
 * Pure VMAF result parsing + pooling (P4 — our own libvmaf pipeline; the
 * Bitmovin QC API yields PSNR only). No I/O here: the worker (PR3) reads
 * the libvmaf JSON log off disk and feeds it to `parseVmafJson`, then
 * `computePooled` derives the headline metrics we persist on VmafResult.
 */

/**
 * Largest PSNR (dB) we record. libvmaf reports `inf` for identical frames
 * (and ffmpeg's JSON formatter can serialize that as a huge finite number or
 * the literal `Infinity` — which `JSON.stringify` then turns into `null`,
 * corrupting the persisted blob). We CAP at this value so every psnr is a
 * finite, JSON-safe number: 100 dB is already far beyond visually-lossless
 * (a perfect match is effectively ∞; 100 reads as "no measurable error").
 */
export const PSNR_MAX_DB = 100;

/**
 * Clamp a raw PSNR into [0, PSNR_MAX_DB]. +∞ (identical frames — what libvmaf
 * actually emits) and over-cap → PSNR_MAX_DB; −∞ / negatives → 0 (worst); NaN
 * → 0. Keeps every value finite + JSON-safe.
 */
function capPsnr(value: number): number {
	if (Number.isNaN(value)) {
		return 0;
	}
	if (value > PSNR_MAX_DB) {
		return PSNR_MAX_DB;
	}
	return value < 0 ? 0 : value;
}

/**
 * One scored frame: libvmaf's frame index + its VMAF score, plus the optional
 * PSNR (dB) when the run enabled libvmaf's `psnr` feature (P4-PR5). VMAF-only
 * runs leave `psnr` absent so their persisted frames stay `{frameNum, vmaf}`.
 */
export type VmafFrame = {
	frameNum: number;
	vmaf: number;
	psnr?: number;
};

/**
 * libvmaf's own pooled block (pooled_metrics.vmaf). Parsed when present so
 * we can cross-check our `computePooled` against the runner, but our
 * PooledMetrics is the source of truth (it adds percentiles + low-1%).
 */
export type VmafPooled = {
	min: number;
	max: number;
	mean: number;
	harmonicMean: number;
};

export type ParsedVmaf = {
	frames: VmafFrame[];
	pooled?: VmafPooled;
};

/**
 * Headline VMAF metrics over a run's per-frame scores. Every value is in
 * VMAF score units (0–100, higher = better) unless noted.
 *
 * - `mean`         arithmetic mean of all frame scores.
 * - `harmonicMean` harmonic mean (n / Σ(1/score)); penalizes low frames
 *                  harder than the arithmetic mean — the standard VMAF
 *                  aggregate for perceived quality.
 * - `min` / `max`  worst / best single-frame score.
 * - `percentiles`  linearly-interpolated percentiles of the sorted scores
 *                  (rank = p/100·(n−1), interpolate between neighbours):
 *                  p1/p5/p10/p25/p50 — the low tail that drives QoE.
 * - `low1Percent`  mean of the lowest 1% of frames (ceil, ≥1 frame) — the
 *                  "VMAF 1% low" sustained-worst-case number.
 * - `worstFrame`   the single lowest-scoring frame (its frameNum + score).
 * - `psnr`         OPTIONAL PSNR summary (dB), present only when the run
 *                  enabled libvmaf's psnr feature. PSNR is a different scale
 *                  and semantics than VMAF (log-domain dB, not a 0–100
 *                  perceptual score), so it carries only mean/min/max — the
 *                  VMAF-style percentiles/harmonic-mean would be misleading.
 */
export type PsnrPooled = {
	mean: number;
	min: number;
	max: number;
};

export type PooledMetrics = {
	mean: number;
	harmonicMean: number;
	min: number;
	max: number;
	percentiles: {
		p1: number;
		p5: number;
		p10: number;
		p25: number;
		p50: number;
	};
	low1Percent: number;
	worstFrame: VmafFrame;
	/** Present only on PSNR-enabled runs (additive — VMAF-only runs omit it). */
	psnr?: PsnrPooled;
};

/**
 * Tolerant schema for the libvmaf JSON log. Unknown keys (other metrics —
 * ssim, ms_ssim…) are ignored; the vmaf score per frame, the optional
 * `psnr_y` per frame (P4-PR5, present when the psnr feature ran), and the
 * optional pooled vmaf block are lifted. A frame missing metrics.vmaf is
 * dropped rather than failing the whole parse.
 *
 * `psnr_y` allows ±Infinity here (libvmaf emits inf for identical frames and
 * ffmpeg's JSON formatter can serialize it); parseVmafJson caps it to a
 * finite, JSON-safe value via capPsnr.
 */
const frameSchema = z
	.object({
		frameNum: z.number().optional(),
		// vmaf optional so a frame carrying only other metrics (psnr/ssim)
		// parses and is then dropped in code rather than failing the whole log.
		// psnr_y uses a permissive number predicate (NOT z.number, which
		// rejects non-finite values in zod v4) because libvmaf emits inf for
		// identical frames; capPsnr clamps it downstream.
		metrics: z
			.object({
				vmaf: z.number().optional(),
				psnr_y: z.custom<number>((v) => typeof v === "number").optional(),
			})
			.loose()
			.optional(),
	})
	.loose();

const pooledVmafSchema = z
	.object({
		min: z.number(),
		max: z.number(),
		mean: z.number(),
		harmonic_mean: z.number(),
	})
	.loose();

const libvmafJsonSchema = z
	.object({
		frames: z.array(frameSchema).optional(),
		pooled_metrics: z
			.object({ vmaf: pooledVmafSchema.optional() })
			.loose()
			.optional(),
	})
	.loose();

/**
 * Parses raw libvmaf JSON (already JSON.parse'd) into typed frames + the
 * optional pooled block. Frames without a vmaf metric are skipped; a frame
 * with no explicit frameNum is indexed by its position (libvmaf normally
 * emits frameNum, but the field is treated as best-effort).
 *
 * When the psnr feature ran, each surviving frame also carries `psnr`
 * (capped to [0, PSNR_MAX_DB] — see capPsnr; an identical-frame inf becomes
 * PSNR_MAX_DB). VMAF-only logs leave `psnr` absent on every frame.
 */
export function parseVmafJson(raw: unknown): ParsedVmaf {
	const parsed = libvmafJsonSchema.parse(raw);
	const frames: VmafFrame[] = [];
	(parsed.frames ?? []).forEach((f, index) => {
		const vmaf = f.metrics?.vmaf;
		if (typeof vmaf === "number") {
			const psnr = f.metrics?.psnr_y;
			frames.push({
				frameNum: f.frameNum ?? index,
				vmaf,
				...(typeof psnr === "number" ? { psnr: capPsnr(psnr) } : {}),
			});
		}
	});
	const p = parsed.pooled_metrics?.vmaf;
	return {
		frames,
		...(p
			? {
					pooled: {
						min: p.min,
						max: p.max,
						mean: p.mean,
						harmonicMean: p.harmonic_mean,
					},
				}
			: {}),
	};
}

/**
 * Linearly-interpolated percentile of an ascending-sorted array. Uses the
 * (n−1) rank convention (matches numpy's default "linear"): rank =
 * p/100·(n−1); interpolate between floor and ceil neighbours.
 */
function interpolatedPercentile(sortedAsc: number[], p: number): number {
	const n = sortedAsc.length;
	if (n === 1) {
		return sortedAsc[0] as number;
	}
	const rank = (p / 100) * (n - 1);
	const lo = Math.floor(rank);
	const hi = Math.min(lo + 1, n - 1);
	const frac = rank - lo;
	const loValue = sortedAsc[lo] as number;
	const hiValue = sortedAsc[hi] as number;
	return loValue + (hiValue - loValue) * frac;
}

/**
 * Pools per-frame VMAF scores into the headline metrics (see PooledMetrics).
 * Takes the parsed frames (NOT bare scores) so `worstFrame.frameNum` reports
 * libvmaf's true frame index even when parsing dropped frames — feed it
 * `parseVmafJson(raw).frames` directly. Throws on an empty array (pooling
 * zero frames is a caller bug).
 */
export function computePooled(frames: VmafFrame[]): PooledMetrics {
	const n = frames.length;
	if (n === 0) {
		throw new Error("computePooled requires at least one frame");
	}

	const frameScores = frames.map((f) => f.vmaf);
	const sortedAsc = [...frameScores].sort((a, b) => a - b);
	const sum = frameScores.reduce((acc, v) => acc + v, 0);
	const mean = sum / n;

	// Harmonic mean: n / Σ(1/score). Guard a non-positive score (VMAF is
	// 0–100, but a 0 would divide-by-zero) by clamping the reciprocal term —
	// a 0-score frame already dominates the harmonic mean toward 0.
	const reciprocalSum = frameScores.reduce(
		(acc, v) => acc + (v > 0 ? 1 / v : Number.POSITIVE_INFINITY),
		0,
	);
	const harmonicMean =
		reciprocalSum === Number.POSITIVE_INFINITY ? 0 : n / reciprocalSum;

	const min = sortedAsc[0] as number;
	const max = sortedAsc[n - 1] as number;

	// Lowest 1% of frames, at least one. ceil so even short clips contribute a
	// frame, and a 200-frame clip uses its worst 2.
	const lowCount = Math.max(1, Math.ceil(n * 0.01));
	const low1Percent =
		sortedAsc.slice(0, lowCount).reduce((acc, v) => acc + v, 0) / lowCount;

	// worstFrame: the lowest-scoring frame, preserving libvmaf's frameNum
	// (reduce keeps the earlier frame on ties — first occurrence of the min).
	const worstFrame: VmafFrame = frames.reduce((w, f) =>
		f.vmaf < w.vmaf ? f : w,
	);

	return {
		mean,
		harmonicMean,
		min,
		max,
		percentiles: {
			p1: interpolatedPercentile(sortedAsc, 1),
			p5: interpolatedPercentile(sortedAsc, 5),
			p10: interpolatedPercentile(sortedAsc, 10),
			p25: interpolatedPercentile(sortedAsc, 25),
			p50: interpolatedPercentile(sortedAsc, 50),
		},
		low1Percent,
		worstFrame,
	};
}

/**
 * Pools per-frame PSNR (dB) into a mean/min/max summary — the right aggregate
 * for a log-domain fidelity metric (VMAF's percentiles/harmonic-mean don't
 * carry over). Values are assumed already capped via capPsnr (parseVmafJson
 * does this). Returns undefined for an empty array so a VMAF-only run (no
 * PSNR frames) folds to an absent `pooled.psnr` rather than throwing — unlike
 * computePooled, pooling zero PSNR samples is the normal "feature off" case,
 * not a caller bug.
 */
export function computePsnrPooled(values: number[]): PsnrPooled | undefined {
	const n = values.length;
	if (n === 0) {
		return undefined;
	}
	let min = values[0] as number;
	let max = values[0] as number;
	let sum = 0;
	for (const v of values) {
		if (v < min) {
			min = v;
		}
		if (v > max) {
			max = v;
		}
		sum += v;
	}
	return { mean: sum / n, min, max };
}

/** {@link poolFrames}'s answer: the pooled metrics over the kept frames, and how many were left out. */
export type PooledFramesResult = {
	pooled: PooledMetrics;
	/** SCORED frames that were pooled (under `n_subsample` fewer than the output frames they stand for). */
	includedFrames: number;
	/** SCORED frames left out by `include`. */
	excludedFrames: number;
	/** Output-grid frames libvmaf never scored: `include.length − (included + excluded)`. */
	unscoredFrames: number;
};

/**
 * : pools only the frames whose OUTPUT frame is included —
 * `include` is per output frame (length W, the capture's frame grid) and each
 * scored frame is looked up by its `frameNum` (rev427 R4: under libvmaf's
 * `n_subsample` only every Nth frame is scored, with its ORIGINAL frameNum,
 * so `frames.length ≠ W` and an index alignment would mis-attribute). A frame
 * in a loop hole (no true reference) or in a low-confidence segment must
 * never reach the harmonic mean, where a single 0 dominates the window.
 * Throws on a frameNum outside the grid or when nothing is included (caller
 * bugs, like `computePooled` on an empty array). `computePooled` is untouched.
 */
export function poolFrames(
	frames: VmafFrame[],
	include: readonly boolean[],
): PooledFramesResult {
	const kept: VmafFrame[] = [];
	const seen = new Set<number>();
	for (const frame of frames) {
		const n = frame.frameNum;
		if (!Number.isInteger(n) || n < 0 || n >= include.length) {
			throw new Error(
				`poolFrames: frameNum ${n} is outside the ${include.length}-frame window`,
			);
		}
		// libvmaf never repeats a frame; a concatenated log would, and a
		// duplicate would count twice in every mean.
		if (seen.has(n)) {
			throw new Error(`poolFrames: frameNum ${n} appears twice`);
		}
		seen.add(n);
		if (include[n] === true) {
			kept.push(frame);
		}
	}
	if (kept.length === 0) {
		throw new Error("poolFrames: every frame is excluded — nothing to pool");
	}
	return {
		pooled: computePooled(kept),
		includedFrames: kept.length,
		excludedFrames: frames.length - kept.length,
		unscoredFrames: include.length - frames.length,
	};
}
