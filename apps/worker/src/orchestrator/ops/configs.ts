/**
 * : configs members extracted VERBATIM from sdk-ops.ts. The
 * Pick<SdkOps, …> return type restores the contextual typing the members had
 * inside the monolithic literal; facade-freeze.test.ts pins the union.
 */

import {
	AacAudioConfiguration,
	AacChannelLayout,
	AdaptiveQuantMode,
	AutoLevelSetup,
	Av1DynamicRangeFormat,
	Av1PresetConfiguration,
	Av1VideoConfiguration,
	DolbyAtmosAudioConfiguration,
	DolbyAtmosDialogueIntelligence,
	DolbyAtmosLoudnessControl,
	DolbyAtmosMeteringMode,
	DolbyDigitalAudioConfiguration,
	DolbyDigitalChannelLayout,
	DolbyDigitalPlusAudioConfiguration,
	DolbyDigitalPlusChannelLayout,
	EncodingMode,
	H264MotionEstimationMethod,
	H264SubMe,
	H264Trellis,
	H264VideoConfiguration,
	H265DynamicRangeFormat,
	H265V2MotionCompensatedTemporalFiltering,
	H265V2PerceptualEncodingMode,
	H265V2PerceptualQualityModeConfig,
	H265V2PresetConfiguration,
	H265V2RateControlModeConfigType,
	H265V2VideoConfiguration,
	H265VideoConfiguration,
	ImscConfiguration,
	ImscStylingMode,
	LevelAv1,
	LevelH264,
	LevelH265,
	MaxCtuSize,
	MotionSearch,
	MvPredictionMode,
	OpusAudioConfiguration,
	OpusChannelLayout,
	PixelFormat,
	PresetConfiguration,
	ProfileH264,
	ProfileH265,
	TuInterDepth,
	TuIntraDepth,
	Vp9AqMode,
	Vp9ArnrType,
	Vp9Quality,
	Vp9VideoConfiguration,
	WebVttConfiguration,
	WeightedPredictionPFrames,
} from "@bitmovin/api-sdk";
import { h265V2QualityControlsSchema } from "@bitovp/core";
import { assertInternalHevcV2Access } from "../internal-hevc-v2";
import type { SdkOps } from "../sdk-ops";
import type { OpsContext } from "./context";
import { colorConfig, optEnum, sdkEnumValue } from "./shared";

/** SMART_PASS belongs exclusively to the authorized H265V2 path. */
function ordinaryEncodingMode(
	value: string | undefined,
): EncodingMode | undefined {
	if (value === "SMART_PASS")
		throw new Error("Internal HEVCv2 is required for SMART_PASS");
	return optEnum(EncodingMode, value, "EncodingMode");
}

export function createConfigOps(
	ctx: OpsContext,
): Pick<
	SdkOps,
	| "createH264Config"
	| "createH265Config"
	| "createVp9Config"
	| "createAv1Config"
	| "createAacConfig"
	| "createDolbyAtmosConfig"
	| "createDolbyDigitalPlusConfig"
	| "createDolbyDigitalConfig"
	| "createWebVttConfig"
	| "createOpusConfig"
	| "createImscConfig"
	| "getCodecConfigDetail"
	| "getVideoConfigBitrate"
> {
	const { api, audited, id, capturePort } = ctx;
	return {
		createH264Config: async (p) => {
			if (ctx.options.internalHevcV2)
				throw new Error("Internal HEVCv2 allows only H265V2 video configs");
			return audited(
				"POST",
				"/encoding/configurations/video/h264",
				p,
				() =>
					api.encoding.configurations.video.h264.create(
						new H264VideoConfiguration({
							minGop: p.minGop,
							maxGop: p.maxGop,
							openGop: p.openGop,
							sampleAspectRatioNumerator: p.sampleAspectRatioNumerator,
							sampleAspectRatioDenominator: p.sampleAspectRatioDenominator,
							displayAspectRatio: p.displayAspectRatio,
							crf: p.crf,
							minBitrate: p.minBitrate,
							maxBitrate: p.maxBitrate,
							bufsize: p.bufsize,
							encodingMode: ordinaryEncodingMode(p.encodingMode),
							name: p.name,
							width: p.width,
							height: p.height,
							bitrate: p.bitrate,
							rate: p.rate,
							level: optEnum(LevelH264, p.level, "LevelH264"),
							presetConfiguration: optEnum(
								PresetConfiguration,
								p.presetConfiguration,
								"PresetConfiguration",
							),
							profile: optEnum(ProfileH264, p.profile, "ProfileH264"),
							minKeyframeInterval: p.minKeyframeInterval,
							maxKeyframeInterval: p.maxKeyframeInterval,
							slices: p.slices,
							trellis: optEnum(H264Trellis, p.trellis, "H264Trellis"),
							mvSearchRangeMax: p.mvSearchRangeMax,
							rcLookahead: p.rcLookahead,
							subMe: optEnum(H264SubMe, p.subMe, "H264SubMe"),
							motionEstimationMethod: optEnum(
								H264MotionEstimationMethod,
								p.motionEstimationMethod,
								"H264MotionEstimationMethod",
							),
							sceneCutThreshold: p.sceneCutThreshold,
							adaptiveQuantizationMode: optEnum(
								AdaptiveQuantMode,
								p.adaptiveQuantizationMode,
								"AdaptiveQuantMode",
							),
							adaptiveQuantizationStrength: p.adaptiveQuantizationStrength,
							mvPredictionMode: optEnum(
								MvPredictionMode,
								p.mvPredictionMode,
								"MvPredictionMode",
							),
							psyRateDistortionOptimization: p.psyRateDistortionOptimization,
							psyTrellis: p.psyTrellis,
							refFrames: p.refFrames,
							bframes: p.bframes,
							cabac: p.cabac,
							adaptiveSpatialTransform: p.adaptiveSpatialTransform,
							weightedPredictionPFrames: optEnum(
								WeightedPredictionPFrames,
								p.weightedPredictionPFrames,
								"WeightedPredictionPFrames",
							),
							colorConfig: colorConfig(p.colorConfig),
						}),
					),
				(r) => ({ id: r.id }),
			).then(id);
		},

		createH265Config: async (p) => {
			if (
				!p.internalHevcV2 &&
				!ctx.options.internalHevcV2 &&
				(p.motionCompensatedTemporalFiltering !== undefined ||
					p.rateControlModeConfig !== undefined)
			)
				throw new Error("Native quality controls require internal HEVCv2");
			if (p.internalHevcV2 || ctx.options.internalHevcV2) {
				const profile = ctx.options.internalHevcV2;
				const allowed = new Set([
					"name",
					"height",
					"bitrate",
					"rate",
					"internalHevcV2",
					"encodingMode",
					"presetConfiguration",
					"pixelFormat",
					"colorConfig",
					"dynamicRangeFormat",
					"levelHighTier",
					"motionCompensatedTemporalFiltering",
					"rateControlModeConfig",
				]);
				if (
					!profile ||
					!p.internalHevcV2 ||
					p.encodingMode !== "SMART_PASS" ||
					p.presetConfiguration !== "VOD_HIGH_QUALITY" ||
					(p.dynamicRangeFormat !== undefined &&
						p.dynamicRangeFormat !== "SDR") ||
					Object.entries(p).some(
						([key, value]) => value !== undefined && !allowed.has(key),
					)
				)
					throw new Error("Invalid internal HEVCv2 codec request");
				assertInternalHevcV2Access(ctx.options.bitmovinAccountId, profile);
				const quality = h265V2QualityControlsSchema.parse({
					motionCompensatedTemporalFiltering:
						p.motionCompensatedTemporalFiltering,
					rateControlModeConfig: p.rateControlModeConfig,
				});
				const body = {
					name: p.name,
					height: p.height,
					bitrate: p.bitrate,
					rate: p.rate,
					pixelFormat: optEnum(PixelFormat, p.pixelFormat, "PixelFormat"),
					colorConfig: colorConfig(p.colorConfig),
					dynamicRangeFormat: optEnum(
						H265DynamicRangeFormat,
						p.dynamicRangeFormat,
						"H265DynamicRangeFormat",
					),
					levelHighTier: p.levelHighTier,
					encodingMode: EncodingMode.SMART_PASS,
					presetConfiguration: H265V2PresetConfiguration.VOD_HIGH_QUALITY,
					motionCompensatedTemporalFiltering: optEnum(
						H265V2MotionCompensatedTemporalFiltering,
						quality.motionCompensatedTemporalFiltering,
						"H265V2MotionCompensatedTemporalFiltering",
					),
					// Instantiate the discriminated subtype so the SDK Mapper retains
					// its nested fields instead of constructing a base config.
					rateControlModeConfig: quality.rateControlModeConfig
						? new H265V2PerceptualQualityModeConfig({
								...quality.rateControlModeConfig,
								type: H265V2RateControlModeConfigType.PERCEPTUAL_QUALITY_MODE,
								perceptualEncodingMode: optEnum(
									H265V2PerceptualEncodingMode,
									quality.rateControlModeConfig.perceptualEncodingMode,
									"H265V2PerceptualEncodingMode",
								),
							})
						: undefined,
				};
				return audited(
					"POST",
					"/encoding/configurations/video/h265v2",
					body,
					() =>
						api.encoding.configurations.video.h265v2.create(
							new H265V2VideoConfiguration(body),
						),
					(r) => ({ id: r.id }),
				).then(id);
			}
			return audited(
				"POST",
				"/encoding/configurations/video/h265",
				p,
				() =>
					api.encoding.configurations.video.h265.create(
						new H265VideoConfiguration({
							width: p.width,
							bframes: p.bframes,
							refFrames: p.refFrames,
							qp: p.qp,
							qpMax: p.qpMax,
							strictCbr: p.strictCbr,
							minGop: p.minGop,
							maxGop: p.maxGop,
							openGop: p.openGop,
							sampleAspectRatioNumerator: p.sampleAspectRatioNumerator,
							sampleAspectRatioDenominator: p.sampleAspectRatioDenominator,
							displayAspectRatio: p.displayAspectRatio,
							crf: p.crf,
							minBitrate: p.minBitrate,
							encodingMode: ordinaryEncodingMode(p.encodingMode),
							name: p.name,
							profile: optEnum(ProfileH265, p.profile, "ProfileH265"),
							height: p.height,
							bitrate: p.bitrate,
							rate: p.rate,
							level: optEnum(LevelH265, p.level, "LevelH265"),
							pixelFormat: optEnum(PixelFormat, p.pixelFormat, "PixelFormat"),
							minKeyframeInterval: p.minKeyframeInterval,
							maxKeyframeInterval: p.maxKeyframeInterval,
							rcLookahead: p.rcLookahead,
							subMe: p.subMe,
							maxCTUSize: optEnum(MaxCtuSize, p.maxCTUSize, "MaxCtuSize"),
							motionSearch: optEnum(
								MotionSearch,
								p.motionSearch,
								"MotionSearch",
							),
							tuIntraDepth: optEnum(
								TuIntraDepth,
								p.tuIntraDepth,
								"TuIntraDepth",
							),
							tuInterDepth: optEnum(
								TuInterDepth,
								p.tuInterDepth,
								"TuInterDepth",
							),
							weightPredictionOnPSlice: p.weightPredictionOnPSlice,
							weightPredictionOnBSlice: p.weightPredictionOnBSlice,
							sceneCutThreshold: p.sceneCutThreshold,
							motionSearchRange: p.motionSearchRange,
							adaptiveQuantizationMode: optEnum(
								AdaptiveQuantMode,
								p.adaptiveQuantizationMode,
								"AdaptiveQuantMode",
							),
							adaptiveQuantizationStrength: p.adaptiveQuantizationStrength,
							psyRateDistortionOptimization: p.psyRateDistortionOptimization,
							psyRateDistortionOptimizedQuantization:
								p.psyRateDistortionOptimizedQuantization,
							qpMin: p.qpMin,
							sao: p.sao,
							hdr: p.hdr,
							masterDisplay: p.masterDisplay,
							maxContentLightLevel: p.maxContentLightLevel,
							maxPictureAverageLightLevel: p.maxPictureAverageLightLevel,
							colorConfig: colorConfig(p.colorConfig),
							presetConfiguration: optEnum(
								PresetConfiguration,
								p.presetConfiguration,
								"PresetConfiguration",
							),
							maxBitrate: p.maxBitrate,
							bufsize: p.bufsize,
							dynamicRangeFormat: optEnum(
								H265DynamicRangeFormat,
								p.dynamicRangeFormat,
								"H265DynamicRangeFormat",
							),
							levelHighTier: p.levelHighTier,
						}),
					),
				(r) => ({ id: r.id }),
			).then(id);
		},

		createVp9Config: async (p) => {
			if (ctx.options.internalHevcV2)
				throw new Error("Internal HEVCv2 allows only H265V2 video configs");
			return audited(
				"POST",
				"/encoding/configurations/video/vp9",
				p,
				() =>
					api.encoding.configurations.video.vp9.create(
						new Vp9VideoConfiguration({
							encodingMode: ordinaryEncodingMode(p.encodingMode),
							name: p.name,
							width: p.width,
							height: p.height,
							bitrate: p.bitrate,
							rate: p.rate,
							cpuUsed: p.cpuUsed,
							tileColumns: p.tileColumns,
							qpMin: p.qpMin,
							qpMax: p.qpMax,
							rateUndershootPct: p.rateUndershootPct,
							rateOvershootPct: p.rateOvershootPct,
							quality: optEnum(Vp9Quality, p.quality, "Vp9Quality"),
							lossless: p.lossless,
							aqMode: optEnum(Vp9AqMode, p.aqMode, "Vp9AqMode"),
							arnrType: optEnum(Vp9ArnrType, p.arnrType, "Vp9ArnrType"),
							arnrMaxFrames: p.arnrMaxFrames,
							arnrStrength: p.arnrStrength,
							colorConfig: colorConfig(p.colorConfig),
						}),
					),
				(r) => ({ id: r.id }),
			).then(id);
		},

		createAv1Config: async (p) => {
			if (ctx.options.internalHevcV2)
				throw new Error("Internal HEVCv2 allows only H265V2 video configs");
			return audited(
				"POST",
				"/encoding/configurations/video/av1",
				p,
				() =>
					api.encoding.configurations.video.av1.create(
						new Av1VideoConfiguration({
							encodingMode: ordinaryEncodingMode(p.encodingMode),
							name: p.name,
							width: p.width,
							height: p.height,
							bitrate: p.bitrate,
							rate: p.rate,
							presetConfiguration: optEnum(
								Av1PresetConfiguration,
								p.presetConfiguration,
								"Av1PresetConfiguration",
							),
							autoLevelSetup: optEnum(
								AutoLevelSetup,
								p.autoLevelSetup,
								"AutoLevelSetup",
							),
							maxLevel: optEnum(LevelAv1, p.maxLevel, "LevelAv1"),
							dynamicRangeFormat: optEnum(
								Av1DynamicRangeFormat,
								p.dynamicRangeFormat,
								"Av1DynamicRangeFormat",
							),
							masterDisplay: p.masterDisplay,
							maxContentLightLevel: p.maxContentLightLevel,
							maxPictureAverageLightLevel: p.maxPictureAverageLightLevel,
							colorConfig: colorConfig(p.colorConfig),
						}),
					),
				(r) => ({ id: r.id }),
			).then(id);
		},

		createAacConfig: (p) =>
			audited(
				"POST",
				"/encoding/configurations/audio/aac",
				p,
				() =>
					api.encoding.configurations.audio.aac.create(
						new AacAudioConfiguration({
							name: p.name,
							bitrate: p.bitrate,
							rate: p.rate,
							channelLayout: sdkEnumValue(
								AacChannelLayout,
								p.channelLayout,
								"AacChannelLayout",
							),
						}),
					),
				(r) => ({ id: r.id }),
			).then(id),

		createDolbyAtmosConfig: (p) =>
			audited(
				"POST",
				"/encoding/configurations/audio/dolby-atmos",
				p,
				() =>
					api.encoding.configurations.audio.dolbyAtmos.create(
						new DolbyAtmosAudioConfiguration({
							name: p.name,
							bitrate: p.bitrate,
							rate: p.rate,
							loudnessControl: p.loudnessControl
								? new DolbyAtmosLoudnessControl({
										meteringMode: optEnum(
											DolbyAtmosMeteringMode,
											p.loudnessControl.meteringMode,
											"DolbyAtmosMeteringMode",
										),
										dialogueIntelligence: optEnum(
											DolbyAtmosDialogueIntelligence,
											p.loudnessControl.dialogueIntelligence,
											"DolbyAtmosDialogueIntelligence",
										),
										speechThreshold: p.loudnessControl.speechThreshold,
									})
								: undefined,
						}),
					),
				(r) => ({ id: r.id }),
			).then(id),

		createDolbyDigitalPlusConfig: (p) =>
			audited(
				"POST",
				"/encoding/configurations/audio/dolby-digital-plus",
				p,
				() =>
					api.encoding.configurations.audio.dolbyDigitalPlus.create(
						new DolbyDigitalPlusAudioConfiguration({
							name: p.name,
							bitrate: p.bitrate,
							rate: p.rate,
							channelLayout: sdkEnumValue(
								DolbyDigitalPlusChannelLayout,
								p.channelLayout,
								"DolbyDigitalPlusChannelLayout",
							),
						}),
					),
				(r) => ({ id: r.id }),
			).then(id),

		createDolbyDigitalConfig: (p) =>
			audited(
				"POST",
				"/encoding/configurations/audio/dolby-digital",
				p,
				() =>
					api.encoding.configurations.audio.dolbyDigital.create(
						new DolbyDigitalAudioConfiguration({
							name: p.name,
							bitrate: p.bitrate,
							rate: p.rate,
							channelLayout: sdkEnumValue(
								DolbyDigitalChannelLayout,
								p.channelLayout,
								"DolbyDigitalChannelLayout",
							),
						}),
					),
				(r) => ({ id: r.id }),
			).then(id),

		createOpusConfig: (p) =>
			audited(
				"POST",
				"/encoding/configurations/audio/opus",
				p,
				() =>
					api.encoding.configurations.audio.opus.create(
						new OpusAudioConfiguration({
							...p,
							channelLayout: sdkEnumValue(
								OpusChannelLayout,
								p.channelLayout,
								"OpusChannelLayout",
							),
						}),
					),
				(r) => ({ id: r.id }),
			).then(id),
		createImscConfig: (p) =>
			audited(
				"POST",
				"/encoding/configurations/subtitles/imsc",
				p,
				() =>
					api.encoding.configurations.subtitles.imsc.create(
						new ImscConfiguration({
							styling: p.styling
								? {
										mode: optEnum(
											ImscStylingMode,
											p.styling.mode,
											"ImscStylingMode",
										),
									}
								: undefined,
						}),
					),
				(r) => ({ id: r.id }),
			).then(id),
		createWebVttConfig: (p) =>
			audited(
				"POST",
				"/encoding/configurations/subtitles/webvtt",
				p,
				() =>
					api.encoding.configurations.subtitles.webvtt.create(
						new WebVttConfiguration({ name: p.name }),
					),
				(r) => ({ id: r.id }),
			).then(id),

		getCodecConfigDetail: (configId) => capturePort.getCodecConfig(configId),

		getVideoConfigBitrate: async (configId) => {
			const typed = await api.encoding.configurations.type.get(configId);
			switch (String(typed.type)) {
				case "H264":
					return (await api.encoding.configurations.video.h264.get(configId))
						.bitrate;
				case "H265V2":
					return (
						(await api.encoding.configurations.video.h265v2.get(configId))
							.bitrate ?? undefined
					);
				case "H265":
					return (await api.encoding.configurations.video.h265.get(configId))
						.bitrate;
				case "VP9":
					return (await api.encoding.configurations.video.vp9.get(configId))
						.bitrate;
				case "AV1":
					return (await api.encoding.configurations.video.av1.get(configId))
						.bitrate;
				default:
					return undefined;
			}
		},
	};
}
