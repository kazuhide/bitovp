import { z } from "zod";
import { h26xPictureControlsSchema } from "./codec-controls";
import {
	CODEC_ENUM_VALUES,
	type CodecEnumName,
	codecEnumSchema,
} from "./codec-enums";
import type { EncodingPlan } from "./schema";
import type { PlanIssue } from "./validate";

/** Optional SDK settings shared by the form, plan and operation payload. */
export const aspectRatioControlsSchema = h26xPictureControlsSchema.pick({
	sampleAspectRatioNumerator: true,
	sampleAspectRatioDenominator: true,
	displayAspectRatio: true,
});
/** Geometry is supported by HEVCv2 independently of ordinary H.265 tuning. */
export function codecAspectRatioControls(
	value: object,
): Record<string, unknown> {
	const record = value as Record<string, unknown>;
	return Object.fromEntries(
		Object.keys(aspectRatioControlsSchema.shape)
			.filter((key) => record[key] !== undefined)
			.map((key) => [key, record[key]]),
	);
}

export const cea608708SubtitleConfigSchema = z.strictObject({
	passthroughActivated: z.boolean(),
	passthroughMode: codecEnumSchema("PassthroughMode"),
});

export const h264DetailControlsSchema = z.strictObject({
	autoLevelSetup: codecEnumSchema("AutoLevelSetup").optional(),
	bAdaptiveStrategy: codecEnumSchema("BAdapt").optional(),
	bPyramid: codecEnumSchema("H264BPyramid").optional(),
	cea608708SubtitleConfig: cea608708SubtitleConfigSchema.optional(),
	deblockAlpha: z.number().int().min(-6).max(6).optional(),
	deblockBeta: z.number().int().min(-6).max(6).optional(),
	dynamicRangeFormat: codecEnumSchema("H264DynamicRangeFormat").optional(),
	fastSkipDetectionPFrames: z.boolean().optional(),
	interlaceMode: codecEnumSchema("H264InterlaceMode").optional(),
	macroblockTreeRatecontrol: z.boolean().optional(),
	mixedReferences: z.boolean().optional(),
	nalHrd: codecEnumSchema("H264NalHrd").optional(),
	partitions: z.array(codecEnumSchema("H264Partition")).min(1).optional(),
	pixelFormat: codecEnumSchema("PixelFormat").optional(),
	qpMax: z.number().int().min(0).max(69).optional(),
	qpMin: z.number().int().min(0).max(69).optional(),
	quantizerCurveCompression: z.number().min(0).max(1).optional(),
	weightedPredictionBFrames: z.boolean().optional(),
});
export type H264DetailControls = z.input<typeof h264DetailControlsSchema>;

export const h265DetailControlsSchema = z.strictObject({
	adaptiveQuantizationMotion: z.boolean().optional(),
	allowedRADLBeforeIDR: z.number().int().nonnegative().optional(),
	analyzeSourceFramePixels: z.boolean().optional(),
	asymetricMotionPartitionsAnalysis: z.boolean().optional(),
	autoLevelSetup: codecEnumSchema("AutoLevelSetup").optional(),
	bAdapt: codecEnumSchema("BAdapt").optional(),
	bframeBias: z.number().int().optional(),
	blurComplexity: z.number().nonnegative().optional(),
	blurQuants: z.number().nonnegative().optional(),
	cea608708SubtitleConfig: cea608708SubtitleConfigSchema.optional(),
	codingUnitLossless: z.boolean().optional(),
	constrainedIntraPrediction: z.boolean().optional(),
	copyPicture: z.boolean().optional(),
	cutree: z.boolean().optional(),
	dynamicRateDistortionStrength: z.number().nonnegative().optional(),
	earlySkip: z.boolean().optional(),
	enableHlgSignaling: z.boolean().optional(),
	enableHrdSignaling: z.boolean().optional(),
	evaluationOfIntraModesInBSlices: z.boolean().optional(),
	fastSearchForAngularIntraPredictions: z.boolean().optional(),
	forceFlush: codecEnumSchema("ForceFlushMode").optional(),
	gopLookahead: z.number().int().nonnegative().optional(),
	grainOptimizedRateControl: z.boolean().optional(),
	ipRatio: z.number().positive().optional(),
	limitModes: z.boolean().optional(),
	limitReferences: codecEnumSchema("LimitReferences").optional(),
	limitSao: z.boolean().optional(),
	limitTransformUnitDepthRecursion: codecEnumSchema(
		"LimitTransformUnitDepthRecursionMode",
	).optional(),
	lookaheadSlices: z.number().int().min(0).max(16).optional(),
	lowpassDct: z.boolean().optional(),
	maximumTransformUnitSize: codecEnumSchema("MaxTransformUnitSize").optional(),
	maxMerge: z.number().int().min(1).max(5).optional(),
	minCodingUnitSize: codecEnumSchema("MinCodingUnitSize").optional(),
	noiseReductionInter: z.number().int().nonnegative().optional(),
	noiseReductionIntra: z.number().int().nonnegative().optional(),
	pbRatio: z.number().positive().optional(),
	qpOffsetChromaCb: z.number().int().optional(),
	qpOffsetChromaCr: z.number().int().optional(),
	qpStep: z.number().int().nonnegative().optional(),
	quantizationGroupSize: codecEnumSchema("QuantizationGroupSize").optional(),
	quantizerCurveCompressionFactor: z.number().min(0).max(1).optional(),
	rateDistortionLevelForModeDecision: z.number().int().min(0).max(4).optional(),
	rateDistortionLevelForQuantization: codecEnumSchema(
		"RateDistortionLevelForQuantization",
	).optional(),
	rateDistortionPenalty: codecEnumSchema(
		"RateDistortionPenaltyMode",
	).optional(),
	rectangularMotionPartitionsAnalysis: z.boolean().optional(),
	recursionSkip: z.boolean().optional(),
	refineRateDistortionCost: z.boolean().optional(),
	saoNonDeblock: z.boolean().optional(),
	scenecutBias: z.number().optional(),
	signHide: z.boolean().optional(),
	skipSplitRateDistortionAnalysis: z.boolean().optional(),
	slices: z.number().int().nonnegative().optional(),
	ssimRateDistortionOptimization: z.boolean().optional(),
	strongIntraSmoothing: z.boolean().optional(),
	temporalMotionVectorPredictors: z.boolean().optional(),
	transformSkip: codecEnumSchema("TransformSkipMode").optional(),
	videoFormat: codecEnumSchema("VideoFormat").optional(),
	wavefrontParallelProcessing: z.boolean().optional(),
});
export type H265DetailControls = z.input<typeof h265DetailControlsSchema>;

export const vp9DetailControlsSchema = z.strictObject({
	autoLevelSetup: codecEnumSchema("AutoLevelSetup").optional(),
	automaticAltRefFramesEnabled: z.boolean().optional(),
	biasPct: z.number().int().min(0).max(100).optional(),
	clientBufferSize: z.number().int().nonnegative().optional(),
	clientInitialBufferSize: z.number().int().nonnegative().optional(),
	crf: z.number().min(0).max(63).optional(),
	displayAspectRatio: aspectRatioControlsSchema.shape.displayAspectRatio
		.unwrap()
		.optional(),
	dynamicRangeFormat: codecEnumSchema("Vp9DynamicRangeFormat").optional(),
	errorResiliencyEnabled: z.boolean().optional(),
	frameParallel: z.boolean().optional(),
	lagInFrames: z.number().int().nonnegative().optional(),
	maxGop: z.number().int().nonnegative().optional(),
	maxIntraRate: z.number().int().nonnegative().optional(),
	maxKeyframeInterval: z.number().positive().optional(),
	minGop: z.number().int().nonnegative().optional(),
	minKeyframeInterval: z.number().positive().optional(),
	noiseSensitivity: z.boolean().optional(),
	pixelFormat: codecEnumSchema("PixelFormat").optional(),
	presetConfiguration: codecEnumSchema("PresetConfiguration").optional(),
	rowMultiThreadingEnabled: z.boolean().optional(),
	sampleAspectRatioDenominator: z.number().int().positive().optional(),
	sampleAspectRatioNumerator: z.number().int().positive().optional(),
	sharpness: z.number().int().nonnegative().optional(),
	staticThresh: z.number().int().nonnegative().optional(),
	targetLevel: z.number().int().nonnegative().optional(),
	tileRows: z.number().int().min(0).max(2).optional(),
});
export type VP9DetailControls = z.input<typeof vp9DetailControlsSchema>;

export const av1DetailControlsSchema = z.strictObject({
	displayAspectRatio: aspectRatioControlsSchema.shape.displayAspectRatio
		.unwrap()
		.optional(),
	pixelFormat: codecEnumSchema("PixelFormat").optional(),
	sampleAspectRatioDenominator: z.number().int().positive().optional(),
	sampleAspectRatioNumerator: z.number().int().positive().optional(),
});
export type AV1DetailControls = z.input<typeof av1DetailControlsSchema>;

export const CODEC_DETAIL_SCHEMAS = {
	H264: h264DetailControlsSchema,
	H265: h265DetailControlsSchema,
	VP9: vp9DetailControlsSchema,
	AV1: av1DetailControlsSchema,
} as const;
export type DetailCodec = keyof typeof CODEC_DETAIL_SCHEMAS;

/** Copy only known detail fields. Invalid user input stays visible for validation. */
export function codecDetailControls(
	codec: DetailCodec,
	value: object,
): Record<string, unknown> {
	const record = value as Record<string, unknown>;
	return Object.fromEntries(
		Object.keys(CODEC_DETAIL_SCHEMAS[codec].shape)
			.filter((key) => record[key] !== undefined)
			.map((key) => [key, record[key]]),
	);
}

const DETAIL_ENUM_FIELDS: Partial<
	Record<DetailCodec, Record<string, CodecEnumName>>
> = {
	H264: {
		autoLevelSetup: "AutoLevelSetup",
		bAdaptiveStrategy: "BAdapt",
		bPyramid: "H264BPyramid",
		dynamicRangeFormat: "H264DynamicRangeFormat",
		interlaceMode: "H264InterlaceMode",
		nalHrd: "H264NalHrd",
		partitions: "H264Partition",
		pixelFormat: "PixelFormat",
	},
	H265: {
		autoLevelSetup: "AutoLevelSetup",
		bAdapt: "BAdapt",
		forceFlush: "ForceFlushMode",
		limitReferences: "LimitReferences",
		limitTransformUnitDepthRecursion: "LimitTransformUnitDepthRecursionMode",
		maximumTransformUnitSize: "MaxTransformUnitSize",
		minCodingUnitSize: "MinCodingUnitSize",
		quantizationGroupSize: "QuantizationGroupSize",
		rateDistortionLevelForQuantization: "RateDistortionLevelForQuantization",
		rateDistortionPenalty: "RateDistortionPenaltyMode",
		transformSkip: "TransformSkipMode",
		videoFormat: "VideoFormat",
	},
	VP9: {
		autoLevelSetup: "AutoLevelSetup",
		dynamicRangeFormat: "Vp9DynamicRangeFormat",
		pixelFormat: "PixelFormat",
		presetConfiguration: "PresetConfiguration",
	},
	AV1: { pixelFormat: "PixelFormat" },
};

/** Resolve SDK enum names independently for SDK requests, cURL and template exports. */
export function codecDetailWireControls(
	codec: DetailCodec,
	value: object,
): Record<string, unknown> {
	const selected = codecDetailControls(codec, value);
	const parsed = CODEC_DETAIL_SCHEMAS[codec].parse(selected) as Record<
		string,
		unknown
	>;
	for (const [key, name] of Object.entries(DETAIL_ENUM_FIELDS[codec] ?? {})) {
		const raw = parsed[key];
		if (raw === undefined) continue;
		const values: Readonly<Record<string, string>> = CODEC_ENUM_VALUES[name];
		parsed[key] = Array.isArray(raw)
			? raw.map((value) => values[String(value)])
			: values[String(raw)];
	}
	return parsed;
}

export function checkCodecDetailControls(
	renditions: EncodingPlan["renditions"],
): PlanIssue[] {
	const issues: PlanIssue[] = [];
	for (const [index, rendition] of renditions.entries()) {
		const r = rendition as Record<string, unknown>;
		const issue = (
			code: string,
			field: string,
			message: string,
			level: "error" | "warning" = "error",
		) =>
			issues.push({
				code,
				path: `renditions[${index}].${field}`,
				message,
				level,
			});
		if (rendition.codec === "AV1" || rendition.codec === "VP9") {
			const numerator = r.sampleAspectRatioNumerator !== undefined;
			const denominator = r.sampleAspectRatioDenominator !== undefined;
			if (numerator !== denominator)
				issue(
					"PLAN_CODEC_SAR_PAIR",
					"sampleAspectRatioNumerator",
					"Sample aspect ratio requires both numerator and denominator",
				);
			if (r.displayAspectRatio !== undefined && (numerator || denominator))
				issue(
					"PLAN_CODEC_ASPECT_CONFLICT",
					"displayAspectRatio",
					"Choose sample aspect ratio or display aspect ratio, not both",
				);
		}
		if (
			(rendition.codec === "H264" || rendition.codec === "VP9") &&
			typeof r.qpMin === "number" &&
			typeof r.qpMax === "number" &&
			r.qpMin > r.qpMax
		)
			issue(
				"PLAN_CODEC_QP_RANGE",
				"qpMax",
				"Maximum quantization factor must not be less than the minimum",
			);
		if (rendition.codec === "H264") {
			if (
				rendition.nalHrd !== undefined &&
				rendition.nalHrd !== "NONE" &&
				!rendition.bufsize
			)
				issue(
					"PLAN_CODEC_HRD_BUFFER",
					"nalHrd",
					"HRD signaling requires a positive bufsize",
				);
			if (
				rendition.partitions?.some((p) => p === "NONE" || p === "ALL") &&
				rendition.partitions.length > 1
			)
				issue(
					"PLAN_CODEC_PARTITIONS_CONFLICT",
					"partitions",
					"Choose NONE, ALL, or individual partitions",
				);
		}
		if (rendition.codec === "H265") {
			if (rendition.allowedRADLBeforeIDR !== undefined) {
				if (
					rendition.bframes !== undefined &&
					rendition.allowedRADLBeforeIDR > rendition.bframes
				)
					issue(
						"PLAN_CODEC_RADL_BFRAMES",
						"allowedRADLBeforeIDR",
						"RADL pictures must not exceed bframes",
					);
				if (
					rendition.allowedRADLBeforeIDR > 0 &&
					!(
						rendition.minGop !== undefined &&
						rendition.minGop === rendition.maxGop
					) &&
					!(
						rendition.minKeyframeInterval !== undefined &&
						rendition.minKeyframeInterval === rendition.maxKeyframeInterval
					)
				)
					issue(
						"PLAN_CODEC_RADL_FIXED_GOP",
						"allowedRADLBeforeIDR",
						"RADL pictures require a fixed keyframe interval",
					);
			}
			if (
				rendition.gopLookahead !== undefined &&
				rendition.rcLookahead !== undefined &&
				rendition.gopLookahead > rendition.rcLookahead
			)
				issue(
					"PLAN_CODEC_GOP_LOOKAHEAD",
					"gopLookahead",
					"GOP lookahead must not exceed rcLookahead",
				);
		}
		if (rendition.codec === "VP9") {
			if (
				rendition.minGop !== undefined &&
				rendition.maxGop !== undefined &&
				rendition.minGop > rendition.maxGop
			)
				issue(
					"PLAN_CODEC_GOP_RANGE",
					"minGop",
					"Minimum GOP length must not exceed maximum GOP length",
				);
			if (
				rendition.clientInitialBufferSize !== undefined &&
				rendition.clientBufferSize !== undefined &&
				rendition.clientInitialBufferSize > rendition.clientBufferSize
			)
				issue(
					"PLAN_CODEC_INITIAL_BUFFER",
					"clientInitialBufferSize",
					"Initial buffer must not exceed total client buffer (milliseconds)",
				);
			if (
				rendition.automaticAltRefFramesEnabled === true &&
				rendition.encodingMode !== "TWO_PASS"
			)
				issue(
					"PLAN_CODEC_ALTREF_TWO_PASS",
					"automaticAltRefFramesEnabled",
					"Automatic alternate reference frames require TWO_PASS encoding",
					"warning",
				);
		}
		if (
			(rendition.codec === "AAC" ||
				rendition.codec === "AC3" ||
				rendition.codec === "EAC3") &&
			rendition.cutoffFrequency !== undefined &&
			rendition.cutoffFrequency > rendition.rate / 2
		)
			issue(
				"PLAN_CODEC_AUDIO_CUTOFF",
				"cutoffFrequency",
				"Cutoff frequency must not exceed half the audio sample rate (Hz)",
			);
	}
	return issues;
}
