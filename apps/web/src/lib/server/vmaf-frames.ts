import "server-only";
import { gunzipSync } from "node:zlib";
import type { VmafFrame } from "@bitovp/core";

/**
 * Server-side helpers for the persisted per-frame VMAF blob.
 *
 * Storage contract (PR3/PR5): `VmafResult.framesGzip` is
 * `gzip(JSON.stringify([{ frameNum, vmaf, psnr? }]))` over the full per-frame
 * series (the `frames` JSON column stays null). `psnr` is present only on
 * PSNR-enabled runs (P4-PR5). A 3h clip ≈ 270k frames, so the raw blob never
 * crosses to the browser — the detail route gunzips here and downsamples
 * before serializing. Downsampling keeps each bucket's WORST VMAF frame as the
 * anchor (psnr rides that frame untouched via the object spread).
 */

/** Decode `framesGzip` back into the ordered per-frame series. */
export function decodeFrames(blob: Uint8Array | Buffer): VmafFrame[] {
	const json = gunzipSync(blob).toString("utf8");
	const parsed = JSON.parse(json) as VmafFrame[];
	return parsed;
}

/** A frame plus a flag marking it the run's worst (pinned through downsampling). */
export type ChartFrame = VmafFrame & { worst?: true };

/** Default chart resolution — enough to read dips, small enough to ship. */
export const DOWNSAMPLE_CAP = 1500;

/**
 * Bucket-downsample a per-frame series to at most `cap` points for charting.
 *
 * VMAF dips are the entire point of the report, so each bucket keeps its
 * MINIMUM frame (not the mean) — a single bad frame survives a 200:1
 * reduction instead of being averaged away. The bucket's representative
 * frameNum is the position of that minimum, so the x-axis stays truthful
 * about *where* the dip is. The global worst frame is located up front and
 * force-included (and flagged `worst`) even if bucketing would round past it.
 *
 * Series of `cap` frames or fewer pass through unchanged (already chartable).
 * Returned points stay in ascending frameNum order.
 */
export function downsampleFrames(
	frames: VmafFrame[],
	cap: number = DOWNSAMPLE_CAP,
): ChartFrame[] {
	if (cap < 1) {
		throw new Error("downsampleFrames cap must be >= 1");
	}
	const n = frames.length;
	if (n === 0) {
		return [];
	}

	// Locate the global worst frame once (first occurrence on ties) so we can
	// guarantee it survives regardless of where bucket boundaries land.
	let worstIdx = 0;
	for (let i = 1; i < n; i++) {
		if ((frames[i] as VmafFrame).vmaf < (frames[worstIdx] as VmafFrame).vmaf) {
			worstIdx = i;
		}
	}
	const worstFrame = frames[worstIdx] as VmafFrame;

	if (n <= cap) {
		return frames.map((f, i) =>
			i === worstIdx ? { ...f, worst: true } : { ...f },
		);
	}

	// Reserve one slot for the pinned worst frame so the output never exceeds
	// `cap` once it is spliced in.
	const buckets = Math.max(1, cap - 1);
	const size = n / buckets;
	const out: ChartFrame[] = [];
	for (let b = 0; b < buckets; b++) {
		const start = Math.floor(b * size);
		const end = Math.min(n, Math.floor((b + 1) * size));
		if (end <= start) {
			continue;
		}
		let minIdx = start;
		for (let i = start + 1; i < end; i++) {
			if ((frames[i] as VmafFrame).vmaf < (frames[minIdx] as VmafFrame).vmaf) {
				minIdx = i;
			}
		}
		const f = frames[minIdx] as VmafFrame;
		out.push(minIdx === worstIdx ? { ...f, worst: true } : { ...f });
	}

	// Ensure the worst frame is present and flagged even if its bucket's min
	// happened to be an equal-scoring earlier frame.
	if (!out.some((f) => f.frameNum === worstFrame.frameNum)) {
		out.push({ ...worstFrame, worst: true });
		out.sort((a, b) => a.frameNum - b.frameNum);
	}
	return out;
}
