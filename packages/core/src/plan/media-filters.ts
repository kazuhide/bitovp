import { z } from "zod";

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
export const watermarkFilterSchema = z
	.strictObject({
		key,
		kind: z.literal("WATERMARK"),
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
		...edges,
	})
	.superRefine((v, ctx) => {
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
export const mediaFilterSchema = z.discriminatedUnion("kind", [
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
	TEXT: "text",
	AUDIO_VOLUME: "audioVolume",
	EBU_R128_SINGLE_PASS: "ebuR128SinglePass",
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
export function filterFamily(kind: string): "audio" | "video" {
	return kind === "AUDIO_VOLUME" || kind === "EBU_R128_SINGLE_PASS"
		? "audio"
		: "video";
}
