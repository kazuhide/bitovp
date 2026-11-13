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
 * Measured on 2026-11-13 with the worker image's FFmpeg and the scorer's CPU
 * reference, against which every GPU run is checked: the two scores were equal
 * to the sixth decimal in the 89 comparisons that these rules let through, and
 * differed by 0.00003 to 13.2 in the 22 that they refuse.
 * `native-comparison.test.ts` holds the rules against these measurements, and
 * "GPU scoring and libvmaf through FFmpeg" in docs/FFMPEG-BUILD.md records
 * them.
 */

import { vmafConvertedChromaLayout } from "./size-limits";

/** A video stream by the names that ffprobe's `-show_streams` gives. */
export type VmafProbedVideo = {
	pix_fmt?: unknown;
	color_range?: unknown;
	color_space?: unknown;
};

export type VmafNativeComparison =
	/** The bit depth at which the scorer has to compare: the reference's. */
	| { bitDepth: 8 | 10 }
	/** Why it cannot give the score of libvmaf through FFmpeg, and what to do. */
	| { refusal: string };

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

const refuse = (reason: string): VmafNativeComparison => ({
	refusal: `GPU scoring cannot compare this pair as libvmaf through FFmpeg does: ${reason}. Use Local CPU for this pair.`,
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
			referenceFormat === "yuvj420p"
				? `the reference's pixel format is yuvj420p and the encode's is ${encodeFormat ?? "not known"}, and FFmpeg converts such a reference to the encode's format, which GPU scoring compares for an 8-bit 4:2:0 encode only`
				: `the reference's pixel format is ${referenceFormat ?? "not known"}, and GPU scoring compares 8-bit and 10-bit 4:2:0 pictures only, for references in yuv420p and yuv420p10le`,
		);
	if (!vmafConvertedChromaLayout(encodeFormat))
		return refuse(
			encodeFormat
				? `GPU scoring takes no encode in the pixel format ${encodeFormat}`
				: "the encode's pixel format is not known",
		);
	if (fullRange(reference) !== fullRange(encode))
		return refuse(
			`the reference is ${range(reference)} and the encode is ${range(encode)}, and FFmpeg converts one of the two before libvmaf compares them`,
		);
	if (named(reference.color_space) !== named(encode.color_space))
		return refuse(
			`the reference ${matrix(reference)} and the encode ${matrix(encode)}, and FFmpeg, which takes a file that names none for BT.601, converts the encode to the reference's matrix before libvmaf compares them`,
		);
	return { bitDepth };
}
