/**
 * Picture sizes that libvmaf cannot score with a "VMAF v1" model
 * (`vmaf_v1.0.16_*`), and the sentences that say so.
 *
 * These models hold two features that the `vmaf_v0.6.1` family lacks, and each
 * has a smallest picture. libvmaf reports neither in a way that helps:
 *
 * - CAMBI refuses pictures whose width and height are both below 216. When the
 *   command declares the encode's own size to it (the frame-index method
 *   does), each declared side must be from 144 to 7680, and CAMBI applies the
 *   216 to the declared size, unless that size exceeds the compared pictures
 *   on a side: then it takes the size of the pictures. FFmpeg ends with status
 *   234 and "Invalid argument", or, where libvmaf runs with worker threads and
 *   the refusal is not that of the options' range, with status 0 and no score.
 * - SpEED takes the chroma planes, reduces them by the model's
 *   `speed_prescale` and then by 16, and needs 5 samples of the result in each
 *   direction. For smaller pictures libvmaf logs "SpEED: image too small" and
 *   then ends with a segmentation fault.
 *
 * Both were read in the source of the libvmaf revision that the worker image
 * pins (`cambi.c`, `speed.c`) and measured at their edges with the image's
 * FFmpeg; "libvmaf and small pictures" in docs/FFMPEG-BUILD.md holds the
 * measurements. The numbers belong to that revision. `size-limits.ffmpeg.test.ts`
 * runs the image's FFmpeg at every edge and fails when a number no longer
 * holds.
 *
 * This file knows pictures that are too small, and nothing else that libvmaf
 * refuses. CAMBI also refuses pictures whose width and height add up to more
 * than 6092 (12092 where the encode has the pixels of 1920x1080 or more), and
 * it can crash on pictures more than ten times as wide as high; "libvmaf and
 * large or very wide pictures" in the same document holds both.
 *
 * The owned GPU scorer (`native/vmaf-gpu`) is not libvmaf, and it refuses the
 * same small pictures in words of its own, which name no limit. It compares
 * every pair in 4:2:0, always declares the encode's size to CAMBI, and holds
 * SpEED's and CAMBI's rules in its own code. `vmafNativeSizeLimitFailureMessage`
 * names the limit after such a refusal; "The GPU scorer and small pictures" in
 * the same document holds what was measured.
 */

/** CAMBI: one side of the pictures, and of a declared encode, must reach this. */
const CAMBI_ONE_SIDE = 216;
/** CAMBI: the range of its options `enc_width` and `enc_height`. */
const CAMBI_DECLARED_MIN = 144;
const CAMBI_DECLARED_MAX = 7680;
/** SpEED: it halves the planes this many times and then needs this many samples. */
const SPEED_SCALES = 4;
const SPEED_BLOCK = 5;

/**
 * The VMAF v1 models that the worker image bundles, each with the
 * `speed_prescale` of its SpEED chroma feature (1 where the model file names
 * none). The limits are known for these models and for no other.
 */
export const VMAF_SPEED_CHROMA_PRESCALE: ReadonlyMap<string, number> = new Map([
	["vmaf_v1.0.16_3d0h", 1],
	["vmaf_v1.0.16_hfr_3d0h", 1],
	["vmaf_v1.0.16_1d5h_2160", 1],
	["vmaf_v1.0.16_hfr_1d5h_2160", 1],
	["vmaf_v1.0.16_5d0h", 0.6],
	["vmaf_v1.0.16_hfr_5d0h", 0.6],
	["vmaf_v1.0.16_3d0h_2160", 0.5],
	["vmaf_v1.0.16_hfr_3d0h_2160", 0.5],
]);

/** How the chroma planes of the compared pictures are sampled. */
export type VmafChromaLayout = "4:2:0" | "4:2:2" | "4:4:4";

/**
 * The chroma layout of a pixel format that FFmpeg's libvmaf filter takes as it
 * is, by the name that ffprobe gives it; `undefined` for every other format.
 *
 * The ordinary method compares in the reference's pixel format when it is one
 * of these: the worker's command conforms the encode to the reference with a
 * scale filter, whatever the two sizes are, and FFmpeg lets that filter give
 * the encode the reference's format. Otherwise FFmpeg converts the reference,
 * and the format that it converts to follows from the encode:
 * `vmafConvertedChromaLayout`.
 */
export function vmafChromaLayout(
	pixelFormat: unknown,
): VmafChromaLayout | undefined {
	if (typeof pixelFormat !== "string") return undefined;
	const sampling = /^yuv(420|422|444)p(?:1[026]le)?$/.exec(pixelFormat)?.[1];
	return sampling === "420"
		? "4:2:0"
		: sampling === "422"
			? "4:2:2"
			: sampling === "444"
				? "4:4:4"
				: undefined;
}

/**
 * The chroma layout in which the ordinary method compares when the reference
 * is in none of the formats above, from the encode's pixel format by the name
 * that ffprobe gives it; `undefined` for an encode of which it is not known.
 *
 * FFmpeg then converts the reference to the format that the scale filter
 * gives the encode: the encode's own when libvmaf takes it, and the
 * limited-range format of the same layout for a full-range encode
 * (`yuvj420p`, `yuvj422p`, `yuvj444p`).
 */
export function vmafConvertedChromaLayout(
	encodePixelFormat: unknown,
): VmafChromaLayout | undefined {
	return typeof encodePixelFormat === "string"
		? vmafChromaLayout(
				encodePixelFormat.replace(/^yuvj(?=(?:420|422|444)p$)/, "yuv"),
			)
		: undefined;
}

export type VmafComparedPictures = {
	/** The model's name, as the plan holds it. */
	model: string;
	/** The size at which libvmaf compares the two pictures: the reference's. */
	width: number;
	height: number;
	/**
	 * The chroma layout in which it compares them. Unknown: SpEED's limit is
	 * taken for 4:4:4, the smallest, so that nothing is refused that libvmaf can
	 * score.
	 */
	chroma?: VmafChromaLayout;
	/** The encode's own size, when the command declares it to CAMBI. */
	declaredEncode?: { width: number; height: number };
};

/** The smallest chroma side that SpEED takes with a prescale, by the arithmetic of `speed.c`. */
function smallestChromaSide(prescale: number): number {
	let side = 1;
	while (Math.trunc(side * prescale + 0.5) >> SPEED_SCALES < SPEED_BLOCK)
		side += 1;
	return side;
}

const OTHER_MODEL = "Use a model of the vmaf_v0.6.1 family";
const COMPARED = "The two pictures are compared at the size of the reference.";

/**
 * Why libvmaf cannot score these pictures with this model: the limit and what
 * to do about it, or `undefined` when no limit that this file knows is in the
 * way. A caller asks before it starts FFmpeg and gives the answer as the
 * measurement's error.
 */
export function vmafSizeLimitMessage(
	pictures: VmafComparedPictures,
): string | undefined {
	const { model, width, height, chroma } = pictures;
	const prescale = VMAF_SPEED_CHROMA_PRESCALE.get(model);
	if (prescale === undefined) return undefined;
	const start = `VMAF model "${model}" cannot score`;

	// The declared size first: libvmaf reads its options before any picture.
	const encode = pictures.declaredEncode;
	if (encode) {
		const sides = [encode.width, encode.height];
		const refused = sides.some((side) => side < CAMBI_DECLARED_MIN)
			? `it takes no encode below ${CAMBI_DECLARED_MIN} pixels in width or in height. ${OTHER_MODEL}, which scores smaller pictures.`
			: sides.some((side) => side > CAMBI_DECLARED_MAX)
				? `it takes no encode above ${CAMBI_DECLARED_MAX} pixels in width or in height. ${OTHER_MODEL}.`
				: // An encode that exceeds the pictures on a side counts as the
					// pictures, which the rule below covers.
					encode.width <= width &&
						encode.height <= height &&
						sides.every((side) => side < CAMBI_ONE_SIDE)
					? `it needs an encode of at least ${CAMBI_ONE_SIDE} pixels in width or in height. ${OTHER_MODEL}, which scores smaller pictures.`
					: undefined;
		if (refused)
			return `${start} an encode of ${encode.width}x${encode.height}: ${refused}`;
	}

	const side = smallestChromaSide(prescale);
	const minimumWidth =
		chroma === "4:2:0" || chroma === "4:2:2" ? side * 2 : side;
	const minimumHeight = chroma === "4:2:0" ? side * 2 : side;
	if (
		width >= minimumWidth &&
		height >= minimumHeight &&
		(width >= CAMBI_ONE_SIDE || height >= CAMBI_ONE_SIDE)
	)
		return undefined;

	// Everything that the pictures need, so that a size which passes one limit
	// does not then fail at the other.
	const speed = chroma
		? minimumWidth === minimumHeight
			? `at least ${minimumWidth} pixels in width and in height`
			: `at least ${minimumWidth} pixels in width and ${minimumHeight} in height`
		: `chroma planes of at least ${side} samples in width and in height`;
	const cambi =
		Math.max(minimumWidth, minimumHeight) >= CAMBI_ONE_SIDE
			? ""
			: chroma
				? `, and at least ${CAMBI_ONE_SIDE} in one of the two`
				: `, and at least ${CAMBI_ONE_SIDE} pixels in width or in height`;
	return `${start} ${chroma ? `${chroma} ` : ""}pictures of ${width}x${height}: it needs ${speed}${cambi}. ${COMPARED} ${OTHER_MODEL}, which scores smaller pictures, or a larger reference.`;
}

/**
 * The same for a run that has failed: a sentence when FFmpeg's output holds
 * the message with which libvmaf's SpEED feature refuses small pictures before
 * it crashes, `undefined` for every other failure. `vmafSizeLimitMessage`
 * leaves such a run through only when it does not know the chroma layout.
 */
export function vmafSizeLimitFailureMessage(
	stderr: string,
	pictures: { model: string; width: number; height: number },
): string | undefined {
	if (!stderr.includes("SpEED: image too small")) return undefined;
	return `VMAF model "${pictures.model}" cannot score pictures of ${pictures.width}x${pictures.height}: libvmaf reports that they are too small for its SpEED feature. ${COMPARED} ${OTHER_MODEL}, which scores smaller pictures, or a larger reference.`;
}

/**
 * The words with which the owned GPU scorer refuses pictures or an encode that
 * a model cannot score (`native/vmaf-gpu/src`): its check before libvmaf's
 * SpEED, its own SpEED and CAMBI parameters, and libvmaf's CAMBI, which
 * refuses the declared size of the encode with its error -22. The first also
 * says "too large", and the last two say nothing of a size, so none of them
 * alone tells that the pictures were too small. `size-limits.test.ts` holds
 * the words against the scorer's source.
 */
export const VMAF_NATIVE_SIZE_REFUSALS: readonly string[] = [
	"input is too small or too large for official SpEED chroma blocks",
	"SPEED chroma is too small for its 5 by 5 block after prescale and decimation",
	"invalid Vulkan CAMBI encoding geometry",
	"override official extractor cambi failed (libvmaf -22)",
];

/**
 * The same for a run of the owned GPU scorer that has failed: the sentence of
 * `vmafSizeLimitMessage` when the scorer's output holds one of its refusals
 * and the sizes are below a limit that this file knows, `undefined` for every
 * other failure, which keeps the scorer's own words.
 *
 * The scorer compares in 4:2:0 whatever the reference's layout is, and it
 * declares the encode's size to CAMBI in every run, as the frame-index method
 * does. With these two the rules of this file said, for each of 71 comparisons
 * on an NVIDIA GPU, whether the scorer scored it. Nothing is refused before
 * the run: the scorer decides, and this only puts its refusal into words.
 */
export function vmafNativeSizeLimitFailureMessage(
	stderr: string,
	pictures: {
		model: string;
		width: number;
		height: number;
		declaredEncode: { width: number; height: number };
	},
): string | undefined {
	if (!VMAF_NATIVE_SIZE_REFUSALS.some((refusal) => stderr.includes(refusal)))
		return undefined;
	return vmafSizeLimitMessage({ ...pictures, chroma: "4:2:0" });
}
