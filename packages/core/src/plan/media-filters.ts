import { z } from "zod";
import {
	AUDIO_MIX_LAYOUTS,
	audioMixChannelSchema,
	validateMixSourceChannelTypes,
} from "./audio-mix";

const key = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[a-zA-Z0-9_-]+$/);
const unit = z.enum(["PIXELS", "PERCENTS"]);
const distance = z.number().int().min(0);
const edges = {
	left: distance.optional(),
	right: distance.optional(),
	top: distance.optional(),
	bottom: distance.optional(),
	unit: unit.optional(),
};
export const SCALING_ALGORITHMS = [
	"FAST_BILINEAR",
	"BILINEAR",
	"BICUBIC",
	"EXPERIMENTAL",
	"NEAREST_NEIGHBOR",
	"AVERAGING_AREA",
	"BICUBIC_LUMA_BILINEAR_CHROMA",
	"GAUSS",
	"SINC",
	"LANCZOS",
	"SPLINE",
] as const;
const positiveInt32 = z.number().int().positive().max(2147483647);
export const scaleFilterSchema = z
	.strictObject({
		key,
		kind: z.literal("SCALE"),
		width: positiveInt32.optional(),
		height: positiveInt32.optional(),
		scalingAlgorithm: z.enum(SCALING_ALGORITHMS).optional(),
		sampleAspectRatioNumerator: positiveInt32.optional(),
		sampleAspectRatioDenominator: positiveInt32.optional(),
	})
	.superRefine((v, ctx) => {
		if (
			(v.sampleAspectRatioNumerator === undefined) !==
			(v.sampleAspectRatioDenominator === undefined)
		)
			ctx.addIssue({
				code: "custom",
				message: "Set both the sample aspect ratio numerator and denominator.",
				path: [
					v.sampleAspectRatioNumerator === undefined
						? "sampleAspectRatioNumerator"
						: "sampleAspectRatioDenominator",
				],
			});
	});
export const cropFilterSchema = z
	.strictObject({ key, kind: z.literal("CROP"), ...edges })
	.superRefine((v, ctx) => {
		if (
			v.unit === "PERCENTS" &&
			((v.left ?? 0) + (v.right ?? 0) >= 100 ||
				(v.top ?? 0) + (v.bottom ?? 0) >= 100)
		)
			ctx.addIssue({
				code: "custom",
				message: "Crop must retain part of the image",
			});
	});
export const rotateFilterSchema = z.strictObject({
	key,
	kind: z.literal("ROTATE"),
	rotation: z.number().int(),
});
const watermarkImage = {
	inputKey: key,
	// Object key, never a capability URL or embedded credentials.
	imagePath: z
		.string()
		.min(1)
		.max(1024)
		.refine(
			(v) =>
				!/[?#\\]/.test(v) &&
				[...v].every((c) => c.charCodeAt(0) >= 32) &&
				v.replace(/^\/+/, "").length > 0 &&
				!v.includes("://") &&
				!v.split("/").includes(".."),
			"Use a storage object path, not a URL",
		),
};
type WatermarkPosition = {
	left?: number;
	right?: number;
	top?: number;
	bottom?: number;
	unit?: z.infer<typeof unit>;
};
function validateWatermarkPosition(v: WatermarkPosition, ctx: z.RefinementCtx) {
	if (v.left !== undefined && v.right !== undefined)
		ctx.addIssue({
			code: "custom",
			message: "Choose left or right",
			path: ["right"],
		});
	if (v.top !== undefined && v.bottom !== undefined)
		ctx.addIssue({
			code: "custom",
			message: "Choose top or bottom",
			path: ["bottom"],
		});
	if (
		v.unit === "PERCENTS" &&
		[v.left, v.right, v.top, v.bottom].some((n) => n !== undefined && n > 100)
	)
		ctx.addIssue({
			code: "custom",
			message: "Percentage must be at most 100",
		});
}
export const watermarkFilterSchema = z
	.strictObject({
		key,
		kind: z.literal("WATERMARK"),
		...watermarkImage,
		...edges,
	})
	.superRefine(validateWatermarkPosition);
const offset = z.number().nonnegative().optional();
export const enhancedWatermarkFilterSchema = z
	.strictObject({
		key,
		kind: z.literal("ENHANCED_WATERMARK"),
		...watermarkImage,
		unit: unit.optional(),
		left: offset,
		right: offset,
		top: offset,
		bottom: offset,
		width: z.number().positive().optional(),
		height: z.number().positive().optional(),
		opacity: z.number().min(0).max(1).optional(),
	})
	.superRefine((value, ctx) => {
		validateWatermarkPosition(value, ctx);
		for (const [first, second] of [
			["left", "right"],
			["top", "bottom"],
		] as const)
			if (value[first] === undefined && value[second] === undefined)
				ctx.addIssue({
					code: "custom",
					path: [first],
					message: `Set one of ${first} or ${second}.`,
				});
		for (const field of ["width", "height"] as const) {
			const size = value[field];
			if (
				size !== undefined &&
				(value.unit === "PERCENTS" ? size < 0.1 || size > 100 : size < 1)
			)
				ctx.addIssue({
					code: "custom",
					path: [field],
					message:
						value.unit === "PERCENTS"
							? "Choose 0.1 to 100 percent."
							: "Use at least one pixel.",
				});
		}
	});
export const dolbyLoudnessFilterSchema = z
	.strictObject({
		key,
		kind: z.literal("DOLBY_LOUDNESS"),
		targetLoudness: z.number().int().min(-31).max(-8).optional(),
		maximumTruePeakLevel: z.number().min(-8).max(-0.1).optional(),
		dialogueIntelligence: z.enum(["ENABLED", "DISABLED"]).optional(),
		speechDetectionThreshold: z.number().int().min(0).max(100).optional(),
		contentForm: z.enum(["LONG", "SHORT", "AUTO_DETECT"]).optional(),
	})
	.superRefine((v, ctx) => {
		if ((v.maximumTruePeakLevel ?? -2) < (v.targetLoudness ?? -24) + 6)
			ctx.addIssue({
				code: "custom",
				path: ["maximumTruePeakLevel"],
				message: "True peak must be at least 6 dB above target loudness",
			});
	});
export const TEXT_FILTER_FONTS = [
	"DEJAVUSANS",
	"DEJAVUSERIF",
	"DEJAVUSANSMONO",
	"ROBOTOMONO",
	"ROBOTOBLACK",
	"ROBOTO",
	"ROBOTOCONDENSED",
] as const;
export const textFilterSchema = z.strictObject({
	key,
	kind: z.literal("TEXT"),
	text: z.string().min(1).max(4096),
	font: z.enum(TEXT_FILTER_FONTS).optional(),
	x: z.string().min(1).max(256),
	y: z.string().min(1).max(256),
	fontSize: z.number().int().positive().optional(),
	fontColor: z.string().min(1).optional(),
	box: z.boolean().optional(),
	boxColor: z.string().min(1).optional(),
	boxBorderWidth: distance.int().optional(),
	borderWidth: distance.int().optional(),
	lineSpacing: distance.int().optional(),
	fixBounds: z.boolean().optional(),
	alpha: z.number().min(0).max(1).optional(),
	shadowColor: z.string().min(1).optional(),
	shadowX: z.number().int().optional(),
	shadowY: z.number().int().optional(),
});
export const AUDIO_VOLUME_FORMATS = [
	"U8",
	"S16",
	"S32",
	"U8P",
	"S16P",
	"S32P",
	"S64",
	"S64P",
	"FLT",
	"FLTP",
	"NONE",
	"DBL",
	"DBLP",
] as const;
export const audioVolumeFilterSchema = z
	.strictObject({
		key,
		kind: z.literal("AUDIO_VOLUME"),
		volume: z.number(),
		unit: z.enum(["PERCENT", "DB"]),
		format: z.enum(AUDIO_VOLUME_FORMATS).optional(),
	})
	.superRefine((v, ctx) => {
		if ((v.unit ?? "PERCENT") === "PERCENT" && v.volume < 0)
			ctx.addIssue({
				code: "custom",
				message: "Percent volume must be non-negative",
				path: ["volume"],
			});
	});
export const ebuR128FilterSchema = z.strictObject({
	key,
	kind: z.literal("EBU_R128_SINGLE_PASS"),
	integratedLoudness: z.number().min(-70).max(-5).optional(),
	loudnessRange: z.number().min(1).max(20).optional(),
	maximumTruePeakLevel: z.number().min(-9).max(0).optional(),
});
const nonnegativeStrength = z.number().min(0).optional();
export const denoiseHqdn3dFilterSchema = z.strictObject({
	key,
	kind: z.literal("DENOISE_HQDN3D"),
	lumaSpatial: nonnegativeStrength,
	chromaSpatial: nonnegativeStrength,
	lumaTmp: nonnegativeStrength,
	chromaTmp: nonnegativeStrength,
});
const matrixSize = z
	.number()
	.int()
	.min(3)
	.max(23)
	.refine((n) => n % 2 === 1, "Matrix size must be odd")
	.optional();
export const unsharpFilterSchema = z.strictObject({
	key,
	kind: z.literal("UNSHARP"),
	lumaMatrixHorizontalSize: matrixSize,
	lumaMatrixVerticalSize: matrixSize,
	lumaEffectStrength: z.number().min(-1.5).max(1.5).optional(),
	chromaMatrixHorizontalSize: matrixSize,
	chromaMatrixVerticalSize: matrixSize,
	chromaEffectStrength: z.number().min(-1.5).max(1.5).optional(),
});
export function layoutChannelCount(layout: string): number | undefined {
	const declared = layout.split("_")[0] ?? "";
	const speakerCounts: Record<string, number> = {
		MONO: 1,
		STEREO: 2,
		STEREO_DOWNMIX: 4,
		QUAD_LFE: 5,
		BACK_SURROUND: 3,
		BACK_SURROUND_LFE: 4,
		SURROUND: 3,
		QUAD: 4,
		HEXAGONAL: 6,
		OCTAGONAL: 8,
	};
	return (
		speakerCounts[layout] ??
		(/^\d\.\d$/.test(declared)
			? Number(declared[0]) + Number(declared[2])
			: undefined)
	);
}
// These provider pan mappings select different speakers or channel counts.
// Input-stream mixes have a separate contract; this eligibility is only for
// the stream filter authored here.
export const unsupportedAudioMixFilterLayouts: ReadonlySet<string> = new Set([
	"2.1", // becomes 3.0(back), replacing the LFE with back center
	"5.0", // becomes 5.1
	"HEXAGONAL", // becomes hexadecagonal
	"STEREO_DOWNMIX", // the provider declares four codec channels but pans to two
]);
export const audioMixFilterSchema = z
	.strictObject({
		key,
		kind: z.literal("AUDIO_MIX"),
		channelLayout: z.enum(AUDIO_MIX_LAYOUTS),
		audioMixChannels: z
			.array(
				z.strictObject({
					channelNumber: z.number().int().nonnegative(),
					sourceChannels: audioMixChannelSchema.shape.sourceChannels,
				}),
			)
			.min(1),
	})
	.superRefine((mix, ctx) => {
		validateMixSourceChannelTypes(mix, ctx);
		if (unsupportedAudioMixFilterLayouts.has(mix.channelLayout))
			ctx.addIssue({
				code: "custom",
				path: ["channelLayout"],
				message: `The encoder cannot preserve the speaker mapping for Audio Mix layout ${mix.channelLayout}.`,
			});
		const numbers = mix.audioMixChannels.map(
			(channel) => channel.channelNumber,
		);
		const count = layoutChannelCount(mix.channelLayout);
		if (
			(count !== undefined && numbers.length !== count) ||
			new Set(numbers).size !== numbers.length ||
			numbers.some((n) => n >= numbers.length)
		) {
			ctx.addIssue({
				code: "custom",
				path: ["audioMixChannels"],
				message:
					"Provide one numbered output channel for each channel in the selected layout, starting at zero.",
			});
		}
	});
export const enhancedDeinterlaceFilterSchema = z.strictObject({
	key,
	kind: z.literal("ENHANCED_DEINTERLACE"),
	mode: z.enum(["FRAME", "FIELD"]).optional(),
	parity: z.enum(["TOP_FIELD_FIRST", "BOTTOM_FIELD_FIRST"]).optional(),
	autoEnable: z.enum(["ALWAYS_ON", "META_DATA_BASED"]).optional(),
});
export const conformFilterSchema = z.strictObject({
	key,
	kind: z.literal("CONFORM"),
	targetFps: z.number().positive(),
});
export const interlaceFilterSchema = z.strictObject({
	key,
	kind: z.literal("INTERLACE"),
	mode: z
		.enum([
			"TOP",
			"BOTTOM",
			"DROP_EVEN",
			"DROP_ODD",
			"PAD",
			"INTERLACE_X2",
			"MERGE",
			"MERGE_X2",
		])
		.optional(),
	verticalLowPassFilteringMode: z
		.enum(["DISABLED", "LOW_PASS", "COMPLEX"])
		.optional(),
});
export const mediaFilterSchema = z.discriminatedUnion("kind", [
	enhancedWatermarkFilterSchema,
	dolbyLoudnessFilterSchema,
	audioMixFilterSchema,
	enhancedDeinterlaceFilterSchema,
	conformFilterSchema,
	interlaceFilterSchema,
	scaleFilterSchema,
	cropFilterSchema,
	rotateFilterSchema,
	watermarkFilterSchema,
	textFilterSchema,
	audioVolumeFilterSchema,
	ebuR128FilterSchema,
	denoiseHqdn3dFilterSchema,
	unsharpFilterSchema,
]);
export type MediaFilter = z.infer<typeof mediaFilterSchema>;
export const FILTER_ENDPOINTS = {
	DEINTERLACE: "deinterlace",
	SCALE: "scale",
	CROP: "crop",
	ROTATE: "rotate",
	WATERMARK: "watermark",
	ENHANCED_WATERMARK: "enhancedWatermark",
	DOLBY_LOUDNESS: "dolbyLoudness",
	AUDIO_MIX: "audioMix",
	TEXT: "text",
	AUDIO_VOLUME: "audioVolume",
	EBU_R128_SINGLE_PASS: "ebuR128SinglePass",
	ENHANCED_DEINTERLACE: "enhancedDeinterlace",
	CONFORM: "conform",
	INTERLACE: "interlace",
	DENOISE_HQDN3D: "denoiseHqdn3d",
	UNSHARP: "unsharp",
} as const;
export function filterParameters(filter: {
	key: string;
	kind: string;
	[key: string]: unknown;
}): Record<string, unknown> {
	const { key: _key, kind: _kind, ...parameters } = filter;
	return parameters;
}
/** Dolby documents these output codecs for its loudness filter. */
export function supportsDolbyLoudness(codec: string): boolean {
	return ["AAC", "HE_AAC_V1", "OPUS", "PCM"].includes(codec);
}
export function filterFamily(kind: string): "audio" | "video" | "both" {
	if (kind === "CONFORM") return "both";
	return kind === "AUDIO_VOLUME" ||
		kind === "EBU_R128_SINGLE_PASS" ||
		kind === "DOLBY_LOUDNESS" ||
		kind === "AUDIO_MIX"
		? "audio"
		: "video";
}
