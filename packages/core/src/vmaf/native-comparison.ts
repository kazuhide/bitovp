/**
 * What the owned GPU scorer (`native/vmaf-gpu`) has to compare so that its
 * score is the one of libvmaf through FFmpeg, and the pairs for which it
 * cannot give that score.
 *
 * The ordinary method scales the encode to the reference's size, lets FFmpeg
 * give it the reference's pixel format, and libvmaf compares the two as they
 * then are. The scorer converts both files to 4:2:0 pictures of 8 or of 10
 * bits with the same scaler and converts nothing else: each file keeps its
 * range and its colour matrix. The two compare the same pictures where the
 * reference already is such a picture and FFmpeg finds nothing to convert
 * between the two files:
 *
 * - The reference is `yuv420p` or `yuv420p10le`. libvmaf compares in that
 *   format, and the scorer is told its bit depth. It compares every other
 *   reference in a format that the scorer does not hold, in 4:2:2 or 4:4:4 or
 *   with more than 10 bits, with one exception: FFmpeg converts a full-range
 *   8-bit reference, `yuvj420p`, which libvmaf does not take as it is, to the
 *   format that the encode gets, and that is the scorer's 8-bit 4:2:0 picture
 *   when the encode is 8-bit 4:2:0 as well: `yuvj420p`, or `yuv420p`, as
 *   ffprobe names a full-range AV1 or FFV1 file.
 * - Both files are full range, or neither is. Otherwise FFmpeg converts one of
 *   the two to the other's range first.
 * - Both files name the same colour matrix, or neither names one. Otherwise
 *   FFmpeg converts the encode to the reference's matrix first, and it takes a
 *   file that names none for BT.601.
 *
 * Measured on 2026-11-13 with the worker image's FFmpeg, the command of a
 * Local CPU measurement and the scorer's CPU reference, against which every
 * GPU run is checked, in 129 comparisons. These rules let 107 through: the two
 * scores were equal to the sixth decimal in 97, five were too small for the
 * model in both programs, and five, at widths where libvmaf's score depends on
 * its thread count on arm64, were equal with one thread. In the 22 that the
 * rules refuse, the two scores differed by 0.00003 to 13.3. On a machine with
 * an NVIDIA and an AMD GPU, the CUDA and the Vulkan backend then gave FFmpeg's
 * score to within 0.000002 in the 148 comparisons of evenly spaced files that
 * were scored there.
 * `native-comparison.test.ts` holds the rules against these measurements, and
 * "GPU scoring and libvmaf through FFmpeg" in docs/FFMPEG-BUILD.md records
 * them.
 *
 * The ordinary method also gives both files one frame per slot of the
 * reference's frame rate (FFmpeg's `fps` filter, on both inputs since
 * 2026-11-14), repeating and dropping frames, and the scorer pairs the frames
 * of the two files in their order. The two compare the same frames where that
 * filter changes neither file (`vmafNativeFrameTimes`):
 *
 * - Each file has a frame in every slot of its frame rate. ffprobe's
 *   `r_frame_rate` is the rate of the slots, and for an MP4 or QuickTime file
 *   its `avg_frame_rate` is the file's frames over its duration, so the two
 *   are equal for such a file. A file that leaves slots out has fewer frames
 *   than its duration has slots: `r_frame_rate` 24/1 and `avg_frame_rate`
 *   960/47 for one of 40 frames over 47 slots.
 * - Both files have the same frame rate and, where ffprobe counts them, the
 *   same number of frames.
 *
 * Measured on 2026-11-14, on the machine of 2026-11-13 and with the worker
 * image's FFmpeg: in 280 comparisons of evenly spaced files that pass here,
 * 132 of them of files of 12 to 60 frames a second in MP4, fragmented MP4,
 * QuickTime, Matroska, WebM and MPEG-TS, both backends gave the ordinary
 * method's score to within 0.000002. A reference and two encodes that leave
 * out the same slots, which do not pass: the scorer's pairing gave 44.153269
 * and 52.956566 there, and the ordinary method 44.015701 and 52.963515,
 * because it scores the repeated frames as well.
 *
 * The frame rates and the frame count that ffprobe gives do not show
 * everything, and the scorer reads the frames' times itself:
 *
 * - ffprobe gives a Matroska, WebM or MPEG-TS file that leaves frames out
 *   two equal rates and no frame count, 30000/1001 twice for a file with 47
 *   frames in 148 slots. The scorer stops at the first frame whose time is
 *   more than a quarter of a frame apart in the two files, and at the end of
 *   a file that has fewer frames, and the worker takes that for a refusal of
 *   the pair (`NativePairRefusal`). Where both files leave out the same
 *   frames, it scores them, each frame once, where the ordinary method
 *   scores the repeated frames as well. How far the two are apart depends
 *   on which frames are left out and on what the pictures show: the scorer
 *   was 0.009 to 0.023 above the ordinary method in five pairs, three of
 *   which leave out one frame of 150, and from 7.78 below it (a still part
 *   that keeps one frame in 24) to 4.51 above it (every third frame kept) in
 *   six further pairs.
 * - A file of the second kind that `VMAF_SCORING_VERSION` names, whose video
 *   starts later than the file does by about half a slot, or by that plus a
 *   whole number of slots, passes here, and the scorer, which reads each
 *   file's times from its first frame, scores what the ordinary method
 *   scored before the filter: 90.51 where the ordinary method gives 67.84.
 */

import { vmafConvertedChromaLayout } from "./size-limits";

/** A video stream by the names that ffprobe's `-show_streams` gives. */
export type VmafProbedVideo = {
	pix_fmt?: unknown;
	color_range?: unknown;
	color_space?: unknown;
	r_frame_rate?: unknown;
	avg_frame_rate?: unknown;
	nb_frames?: unknown;
};

/**
 * Why GPU scoring does not take a pair, by its kind. A result that Local CPU
 * scored in its place keeps the kind as the reason of its selection
 * (`localExecution.selection.reason`), and the report says it in words.
 * `GPU_PAIR_INPUT` is the worker's, for a file that the scorer does not take
 * whatever the other file is: non-square pixels, a rotation, HDR colour, more
 * than one video stream, or a format or size that it does not hold.
 */
export const VMAF_GPU_PAIR_REASONS = [
	"GPU_PAIR_PIXEL_FORMAT",
	"GPU_PAIR_COLOR_RANGE",
	"GPU_PAIR_COLOR_MATRIX",
	"GPU_PAIR_FRAME_TIMES",
	"GPU_PAIR_INPUT",
] as const;
export type VmafGpuPairReason = (typeof VMAF_GPU_PAIR_REASONS)[number];

/** Why it cannot give the score of libvmaf through FFmpeg, and what to do. */
export type VmafNativeRefusal = { refusal: string; reason: VmafGpuPairReason };

export type VmafNativeComparison =
	/** The bit depth at which the scorer has to compare: the reference's. */
	{ bitDepth: 8 | 10 } | VmafNativeRefusal;

export type VmafNativeFrameTimes =
	/** The frame rate of both files, each with a frame in every slot of it. */
	{ frameRate: number } | VmafNativeRefusal;

const named = (value: unknown): string | undefined =>
	typeof value === "string" &&
	value !== "" &&
	value !== "unknown" &&
	value !== "unspecified"
		? value
		: undefined;

/** ffprobe names a full-range file by `color_range`, and an 8-bit one by its format as well. */
const fullRange = (video: VmafProbedVideo): boolean =>
	video.color_range === "pc" ||
	(typeof video.pix_fmt === "string" && video.pix_fmt.startsWith("yuvj"));

const range = (video: VmafProbedVideo) =>
	fullRange(video) ? "full range" : "limited range";

const matrix = (video: VmafProbedVideo) => {
	const name = named(video.color_space);
	return name ? `names the colour matrix ${name}` : "names no colour matrix";
};

/** The scorer's 8-bit 4:2:0 picture, by either of ffprobe's names for it. */
const eightBit420 = (format: string | undefined): boolean =>
	format === "yuv420p" || format === "yuvj420p";

const refuse = (reason: VmafGpuPairReason, why: string): VmafNativeRefusal => ({
	refusal: `GPU scoring cannot compare this pair as libvmaf through FFmpeg does: ${why}. Use Local CPU for this pair.`,
	reason,
});

/**
 * The comparison for a reference and an encode, each as ffprobe describes its
 * video stream. A caller asks before it starts the scorer, passes the bit
 * depth to it, and gives a refusal as the measurement's error.
 */
export function vmafNativeComparison(
	reference: VmafProbedVideo,
	encode: VmafProbedVideo,
): VmafNativeComparison {
	const referenceFormat = named(reference.pix_fmt);
	const encodeFormat = named(encode.pix_fmt);
	const bitDepth =
		referenceFormat === "yuv420p" ||
		(referenceFormat === "yuvj420p" && eightBit420(encodeFormat))
			? 8
			: referenceFormat === "yuv420p10le"
				? 10
				: undefined;
	if (!bitDepth)
		return refuse(
			"GPU_PAIR_PIXEL_FORMAT",
			referenceFormat === "yuvj420p"
				? `the reference's pixel format is yuvj420p and the encode's is ${encodeFormat ?? "not known"}, and FFmpeg converts such a reference to the encode's format, which GPU scoring compares for an 8-bit 4:2:0 encode only`
				: `the reference's pixel format is ${referenceFormat ?? "not known"}, and GPU scoring compares 8-bit and 10-bit 4:2:0 pictures only, for references in yuv420p and yuv420p10le`,
		);
	if (!vmafConvertedChromaLayout(encodeFormat))
		return refuse(
			"GPU_PAIR_PIXEL_FORMAT",
			encodeFormat
				? `GPU scoring takes no encode in the pixel format ${encodeFormat}`
				: "the encode's pixel format is not known",
		);
	if (fullRange(reference) !== fullRange(encode))
		return refuse(
			"GPU_PAIR_COLOR_RANGE",
			`the reference is ${range(reference)} and the encode is ${range(encode)}, and FFmpeg converts one of the two before libvmaf compares them`,
		);
	if (named(reference.color_space) !== named(encode.color_space))
		return refuse(
			"GPU_PAIR_COLOR_MATRIX",
			`the reference ${matrix(reference)} and the encode ${matrix(encode)}, and FFmpeg, which takes a file that names none for BT.601, converts the encode to the reference's matrix before libvmaf compares them`,
		);
	return { bitDepth };
}

/** "24000/1001" as ffprobe writes a frame rate; "0/0" is one that it does not know. */
const frameRate = (value: unknown): number | undefined => {
	const match =
		typeof value === "string" ? /^(\d+)(?:\/(\d+))?$/.exec(value) : null;
	if (!match) return undefined;
	const rate = Number(match[1]) / Number(match[2] ?? 1);
	return Number.isFinite(rate) && rate > 0 ? rate : undefined;
};

const frameCount = (value: unknown): number | undefined => {
	const count =
		typeof value === "string" || typeof value === "number"
			? Number(value)
			: Number.NaN;
	return Number.isSafeInteger(count) && count > 0 ? count : undefined;
};

/**
 * The frames that a file is taken to have where ffprobe does not count them,
 * as it does not for Matroska, WebM, MPEG-TS and fragmented MP4: 23 hours at
 * 60 frames a second.
 */
const UNCOUNTED_FRAMES = 5_000_000;

/**
 * The frame rate of a file that has a frame in every slot of it, by what
 * ffprobe says of the file; `undefined` for a file that leaves slots out, and
 * for one of which ffprobe does not say both rates.
 *
 * `avg_frame_rate` is the file's frames over its duration for an MP4 or
 * QuickTime file, so the duration's slots are the frames times `r_frame_rate`
 * over `avg_frame_rate`. A file whose frames' times are rounded to the
 * container's clock has that number within a small part of a slot of its
 * frame count, and one that leaves a single slot out has it a whole slot
 * apart: half a slot is the line between the two.
 */
const evenFrameRate = (video: VmafProbedVideo): number | undefined => {
	const slots = frameRate(video.r_frame_rate);
	const average = frameRate(video.avg_frame_rate);
	if (slots === undefined || average === undefined) return undefined;
	const frames = frameCount(video.nb_frames) ?? UNCOUNTED_FRAMES;
	return Math.abs(slots / average - 1) * frames < 0.5 ? slots : undefined;
};

const said = (value: unknown): string =>
	typeof value === "string" || typeof value === "number"
		? String(value)
		: "not given";

const FRAME_SLOTS =
	"and FFmpeg gives each file one frame per slot of the reference's frame rate, repeating and dropping frames, before libvmaf compares them";

/**
 * Whether the scorer, which pairs the frames of the two files in their order,
 * compares the frames that the ordinary method compares, by what ffprobe says
 * of each file's video stream. A caller asks before it starts the scorer and
 * gives a refusal as the measurement's error, or scores the pair with the
 * ordinary method.
 *
 * The two frame rates are held to the scorer's own line, a millionth of a
 * frame a second, because the scorer refuses the pair beyond it: FFmpeg names
 * a Matroska or WebM file of 60000/1001 frames a second 19001/317, so such a
 * file and an MP4 file of that rate are refused here, although the filter
 * changes neither.
 */
export function vmafNativeFrameTimes(
	reference: VmafProbedVideo,
	encode: VmafProbedVideo,
): VmafNativeFrameTimes {
	const rates: number[] = [];
	for (const [name, video] of [
		["reference", reference],
		["encode", encode],
	] as const) {
		const rate = evenFrameRate(video);
		if (rate === undefined)
			return refuse(
				"GPU_PAIR_FRAME_TIMES",
				`the ${name}'s frames are not evenly spaced by what ffprobe says of it (r_frame_rate ${said(video.r_frame_rate)}, avg_frame_rate ${said(video.avg_frame_rate)}), ${FRAME_SLOTS}`,
			);
		rates.push(rate);
	}
	const [referenceRate, encodeRate] = rates as [number, number];
	// The scorer's own line between two frame rates (`main.cpp`).
	if (Math.abs(referenceRate - encodeRate) > 1e-6)
		return refuse(
			"GPU_PAIR_FRAME_TIMES",
			`the reference's frame rate is ${said(reference.r_frame_rate)} and the encode's is ${said(encode.r_frame_rate)}, and GPU scoring takes two files only where FFmpeg names one frame rate for both`,
		);
	const referenceFrames = frameCount(reference.nb_frames);
	const encodeFrames = frameCount(encode.nb_frames);
	if (
		referenceFrames !== undefined &&
		encodeFrames !== undefined &&
		referenceFrames !== encodeFrames
	)
		return refuse(
			"GPU_PAIR_FRAME_TIMES",
			`the reference has ${referenceFrames} frames and the encode ${encodeFrames}, and GPU scoring compares two files of the same number of frames`,
		);
	return { frameRate: referenceRate };
}
