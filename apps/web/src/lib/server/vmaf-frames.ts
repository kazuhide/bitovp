import "server-only";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import {
	type BandingFrame,
	bandingFrameSchema,
	qcFramesEnvelopeSchema,
	type VmafFrame,
} from "@bitovp/core";
import Assembler from "stream-json/assembler.js";
import { parser, type Token } from "stream-json/parser.js";
import { streamArray } from "stream-json/streamers/stream-array.js";

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

/** Retain one frame at a time; cancellation also stops the gzip/parser pipeline. */
export async function* iterateFrames(
	blob: Uint8Array,
	signal?: AbortSignal,
): AsyncGenerator<VmafFrame> {
	for await (const value of iterateMetricFrames(blob, "vmaf", signal))
		yield value as VmafFrame;
}

export async function* iterateBandingFrames(
	blob: Uint8Array,
	signal?: AbortSignal,
): AsyncGenerator<BandingFrame> {
	let previous: BandingFrame | undefined;
	let frameIndex = 0;
	for await (const value of iterateMetricFrames(blob, "banding", signal)) {
		const frame = value as BandingFrame;
		if (
			frame.frameNum !== frameIndex++ ||
			(previous &&
				(frame.timestampSeconds <= previous.timestampSeconds ||
					frame.timestampSeconds + 1e-7 <
						previous.timestampSeconds + previous.durationSeconds))
		)
			throw new Error("Banding frame coverage is incomplete or unordered");
		previous = frame;
		yield frame;
	}
}

/** Select one metric without buffering either series. The envelope is checked
 * through its closing token, so key ordering cannot bypass version validation. */
function metricTokens(metric: "vmaf" | "banding"): Transform {
	let depth = 0;
	let root: "legacy" | "envelope" | undefined;
	let key: string | undefined;
	let selected = false;
	let emitted = false;
	const keys = new Set<string>();
	let kind = false;
	let version = false;
	let frameAssembler: Assembler | undefined;
	const vmafFrameSchema = qcFramesEnvelopeSchema.shape.vmaf.unwrap().element;
	const invalid = () => new Error("Invalid persisted QC frames envelope");
	return new Transform({
		objectMode: true,
		transform(token: Token, _encoding, callback) {
			try {
				if (depth === 0) {
					if (root) throw invalid();
					if (token.name === "startArray") root = "legacy";
					else if (token.name === "startObject") root = "envelope";
					else throw invalid();
				} else if (root === "envelope" && depth === 1) {
					if (token.name === "keyValue") {
						key = token.value;
						if (
							!["kind", "version", "vmaf", "banding"].includes(key) ||
							keys.has(key)
						)
							throw invalid();
						keys.add(key);
					} else if (token.name === "endObject") {
						if (!kind || !version || !keys.has("banding")) throw invalid();
					} else if (key === "kind") {
						if (token.name !== "stringValue" || token.value !== "QC_FRAMES")
							throw invalid();
						kind = true;
					} else if (key === "version") {
						if (token.name !== "numberValue" || Number(token.value) !== 1)
							throw invalid();
						version = true;
					} else if (key === "vmaf" || key === "banding") {
						if (token.name !== "startArray") throw invalid();
						selected = key === metric;
					} else throw invalid();
				}
				if (root === "envelope" && depth === 2 && token.name !== "endArray") {
					if (token.name !== "startObject") throw invalid();
					frameAssembler = new Assembler();
				}
				if (frameAssembler) {
					frameAssembler.consume(token);
					if (frameAssembler.done) {
						(key === "banding" ? bandingFrameSchema : vmafFrameSchema).parse(
							frameAssembler.current,
						);
						frameAssembler = undefined;
					}
				}
				if ((root === "legacy" && metric === "vmaf") || selected) {
					this.push(token);
					emitted = true;
				}
				if (token.name === "startArray" || token.name === "startObject")
					depth++;
				else if (token.name === "endArray" || token.name === "endObject") {
					depth--;
					if (root === "envelope" && depth === 1) selected = false;
				}
				callback();
			} catch (err) {
				callback(err as Error);
			}
		},
		flush(callback) {
			if (!root || depth !== 0) return callback(invalid());
			if (!emitted) {
				this.push({ name: "startArray" });
				this.push({ name: "endArray" });
			}
			callback();
		},
	});
}

async function* iterateMetricFrames(
	blob: Uint8Array,
	metric: "vmaf" | "banding",
	signal?: AbortSignal,
): AsyncGenerator<unknown> {
	signal?.throwIfAborted();
	const controller = new AbortController();
	const combined = signal
		? AbortSignal.any([signal, controller.signal])
		: controller.signal;
	const options = {
		packKeys: true,
		streamKeys: false,
		streamStrings: false,
		streamNumbers: false,
		decodeStrings: false,
	};
	const frames = streamArray.asStream();
	const decode =
		blob[0] === 0x1f && blob[1] === 0x8b
			? createGunzip({ chunkSize: 65_536 })
			: new Transform({
					transform(chunk, _encoding, callback) {
						callback(null, chunk);
					},
				});
	decode.setEncoding("utf8");
	const completed = pipeline(
		Readable.from([blob]),
		decode,
		parser.asStream(options),
		metricTokens(metric),
		frames,
		{
			signal: combined,
		},
	);
	// Iteration observes the original error; attach a handler before the first pull.
	void completed.catch(() => {});
	try {
		for await (const item of frames) {
			combined.throwIfAborted();
			yield item.value;
		}
		await completed;
	} finally {
		controller.abort();
		await completed.catch(() => {});
	}
}

export type BandingChartFrame = BandingFrame & { worst?: true };

/** CAMBI is worse when higher; retain every bucket's peak at its original PTS. */
export async function downsampleBandingFrameBlob(
	blob: Uint8Array,
	cap: number = DOWNSAMPLE_CAP,
	signal?: AbortSignal,
): Promise<{ frames: BandingChartFrame[]; frameCount: number }> {
	if (!Number.isInteger(cap) || cap < 1)
		throw new Error("Banding downsample cap must be >= 1");
	let frameCount = 0;
	for await (const _frame of iterateBandingFrames(blob, signal)) frameCount++;
	const bucketCount = Math.min(frameCount, cap);
	const selected: BandingFrame[] = [];
	let index = 0;
	let bucket = -1;
	let worst: BandingFrame | undefined;
	for await (const frame of iterateBandingFrames(blob, signal)) {
		const next = Math.min(
			bucketCount - 1,
			Math.floor((index * bucketCount) / frameCount),
		);
		if (next !== bucket) {
			selected.push(frame);
			bucket = next;
		} else if (frame.cambi > (selected.at(-1) as BandingFrame).cambi)
			selected[selected.length - 1] = frame;
		if (!worst || frame.cambi > worst.cambi) worst = frame;
		index++;
	}
	return {
		frames: selected.map((frame) =>
			frame === worst ? { ...frame, worst: true } : frame,
		),
		frameCount,
	};
}

/** Counts and extrema are exact; histogram positions represent fixed-width bins. */
export type VmafScoreDistribution = {
	frameCount: number;
	min: number;
	max: number;
	mean: number;
	binWidth: number;
	bins: { score: number; count: number }[];
};

const DISTRIBUTION_BIN_COUNT = 64;

/** Two streaming passes produce the line's bucket minima and the distribution
 * of ALL measured frames. Retain at most `cap` line points plus 64 counters;
 * never use the deliberately pessimistic line samples as a distribution. */
export async function readVmafChartData(
	blob: Uint8Array,
	cap: number = DOWNSAMPLE_CAP,
	signal?: AbortSignal,
): Promise<{
	frames: ChartFrame[];
	frameCount: number;
	distribution: VmafScoreDistribution | null;
}> {
	if (cap < 1) throw new Error("downsampleFrames cap must be >= 1");
	let frameCount = 0;
	let min = Number.POSITIVE_INFINITY;
	let max = Number.NEGATIVE_INFINITY;
	let mean = 0;
	for await (const frame of iterateFrames(blob, signal)) {
		if (typeof frame.vmaf !== "number" || !Number.isFinite(frame.vmaf))
			throw new Error("Invalid persisted VMAF score");
		frameCount++;
		min = Math.min(min, frame.vmaf);
		max = Math.max(max, frame.vmaf);
		const delta = frame.vmaf - mean;
		mean = Number.isFinite(delta)
			? mean + delta / frameCount
			: mean * (1 - 1 / frameCount) + frame.vmaf / frameCount;
	}
	if (!frameCount) return { frames: [], frameCount: 0, distribution: null };
	const constant = min === max;
	const binWidth = constant
		? 0
		: max / DISTRIBUTION_BIN_COUNT - min / DISTRIBUTION_BIN_COUNT;
	const distribution: VmafScoreDistribution = {
		frameCount,
		min,
		max,
		mean,
		binWidth,
		bins: Array.from(
			{ length: constant ? 1 : DISTRIBUTION_BIN_COUNT },
			(_, index) => {
				const fraction = (index + 0.5) / DISTRIBUTION_BIN_COUNT;
				return {
					score: constant ? min : min * (1 - fraction) + max * fraction,
					count: 0,
				};
			},
		),
	};
	const countScore = (score: number) => {
		const range = max - min;
		const fraction = constant
			? 0
			: Number.isFinite(range)
				? (score - min) / range
				: (score / 2 - min / 2) / (max / 2 - min / 2);
		const index = Math.max(
			0,
			Math.min(
				distribution.bins.length - 1,
				Math.floor(fraction * DISTRIBUTION_BIN_COUNT),
			),
		);
		const bin = distribution.bins[index];
		if (!bin) throw new Error("Invalid persisted VMAF histogram position");
		bin.count++;
	};
	if (frameCount <= cap) {
		const frames: VmafFrame[] = [];
		for await (const frame of iterateFrames(blob, signal)) {
			frames.push(frame);
			countScore(frame.vmaf);
		}
		return { frames: downsampleFrames(frames, cap), frameCount, distribution };
	}
	const buckets = Math.max(1, cap - 1);
	const size = frameCount / buckets;
	const selected: { frame: VmafFrame; index: number }[] = [];
	let index = 0;
	let bucket = 0;
	let minimum: { frame: VmafFrame; index: number } | undefined;
	let worst: { frame: VmafFrame; index: number } | undefined;
	for await (const frame of iterateFrames(blob, signal)) {
		countScore(frame.vmaf);
		if (index >= Math.floor((bucket + 1) * size)) {
			if (minimum) selected.push(minimum);
			minimum = undefined;
			bucket++;
		}
		// The final floor endpoint may exclude a tail frame; only worst pinning scans it.
		if (bucket < buckets && (!minimum || frame.vmaf < minimum.frame.vmaf))
			minimum = { frame, index };
		if (!worst || frame.vmaf < worst.frame.vmaf) worst = { frame, index };
		index++;
	}
	if (minimum) selected.push(minimum);
	const frames: ChartFrame[] = selected.map(({ frame, index }) =>
		index === worst?.index ? { ...frame, worst: true } : { ...frame },
	);
	if (
		worst &&
		!frames.some((frame) => frame.frameNum === worst.frame.frameNum)
	) {
		frames.push({ ...worst.frame, worst: true });
		frames.sort((a, b) => a.frameNum - b.frameNum);
	}
	return { frames, frameCount, distribution };
}

/** Preserve the established helper shape for callers needing only line data. */
export async function downsampleFrameBlob(
	blob: Uint8Array,
	cap: number = DOWNSAMPLE_CAP,
	signal?: AbortSignal,
): Promise<{ frames: ChartFrame[]; frameCount: number }> {
	const { frames, frameCount } = await readVmafChartData(blob, cap, signal);
	return { frames, frameCount };
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
