/**
 *  half 2: the configs cases of executor.ts' 84-case switch,
 * moved VERBATIM. executor.ts keeps every case LABEL (grouped, so its
 * `never` default still proves exhaustiveness and the freeze scan still
 * reads all 84) and dispatches here; this switch narrows the same way the
 * monolithic one did. The default is unreachable by construction.
 */
import type { CompiledOperation } from "@bitovp/core";
import { h264RenditionSchema, h265V2QualityControlsSchema } from "@bitovp/core";
import type { StepResult } from "../executor";
import type { ExecStepContext } from "./exec-shared";
import {
	colorConfigOf,
	num,
	optBool,
	optNum,
	optStr,
	str,
} from "./exec-shared";

export async function executeConfigStep(
	op: CompiledOperation,
	ec: ExecStepContext,
): Promise<StepResult> {
	const { ctx, request } = ec;
	const p = op.payload;
	switch (op.kind) {
		case "CREATE_CODEC_H264": {
			const resourceId = await ctx.sdk.createH264Config({
				minGop: optNum(p.minGop),
				maxGop: optNum(p.maxGop),
				openGop: optBool(p.openGop),
				sampleAspectRatioNumerator: optNum(p.sampleAspectRatioNumerator),
				sampleAspectRatioDenominator: optNum(p.sampleAspectRatioDenominator),
				displayAspectRatio: h264RenditionSchema.shape.displayAspectRatio.parse(
					p.displayAspectRatio,
				),
				crf: optNum(p.crf),
				minBitrate: optNum(p.minBitrate),
				maxBitrate: optNum(p.maxBitrate),
				bufsize: optNum(p.bufsize),
				encodingMode: optStr(p.encodingMode),
				name: optStr(p.name),
				...(p.width !== undefined ? { width: optNum(p.width) } : {}),
				height: optNum(p.height),
				bitrate: optNum(p.bitrate),
				rate: optNum(p.rate),
				level: optStr(p.level),
				presetConfiguration: optStr(p.presetConfiguration),
				profile: optStr(p.profile),
				minKeyframeInterval: optNum(p.minKeyframeInterval),
				maxKeyframeInterval: optNum(p.maxKeyframeInterval),
				slices: optNum(p.slices),
				trellis: optStr(p.trellis),
				mvSearchRangeMax: optNum(p.mvSearchRangeMax),
				rcLookahead: optNum(p.rcLookahead),
				subMe: optStr(p.subMe),
				motionEstimationMethod: optStr(p.motionEstimationMethod),
				sceneCutThreshold: optNum(p.sceneCutThreshold),
				adaptiveQuantizationMode: optStr(p.adaptiveQuantizationMode),
				adaptiveQuantizationStrength: optNum(p.adaptiveQuantizationStrength),
				mvPredictionMode: optStr(p.mvPredictionMode),
				psyRateDistortionOptimization: optNum(p.psyRateDistortionOptimization),
				psyTrellis: optNum(p.psyTrellis),
				refFrames: optNum(p.refFrames),
				bframes: optNum(p.bframes),
				cabac: optBool(p.cabac),
				adaptiveSpatialTransform: optBool(p.adaptiveSpatialTransform),
				weightedPredictionPFrames: optStr(p.weightedPredictionPFrames),
				colorConfig: colorConfigOf(p.colorConfig),
			});
			return { resourceId, request, response: { id: resourceId } };
		}

		case "CREATE_CODEC_H265": {
			// Parse raw controls before opt helpers can silently drop malformed
			// values; validate nested extras at the execution boundary as well.
			const quality = h265V2QualityControlsSchema.parse({
				motionCompensatedTemporalFiltering:
					p.motionCompensatedTemporalFiltering,
				rateControlModeConfig: p.rateControlModeConfig,
			});
			const resourceId = await ctx.sdk.createH265Config({
				...(p.width !== undefined ? { width: optNum(p.width) } : {}),
				bframes: optNum(p.bframes),
				refFrames: optNum(p.refFrames),
				qp: optNum(p.qp),
				qpMax: optNum(p.qpMax),
				strictCbr: optBool(p.strictCbr),
				minGop: optNum(p.minGop),
				maxGop: optNum(p.maxGop),
				openGop: optBool(p.openGop),
				sampleAspectRatioNumerator: optNum(p.sampleAspectRatioNumerator),
				sampleAspectRatioDenominator: optNum(p.sampleAspectRatioDenominator),
				displayAspectRatio: h264RenditionSchema.shape.displayAspectRatio.parse(
					p.displayAspectRatio,
				),
				crf: optNum(p.crf),
				minBitrate: optNum(p.minBitrate),
				...quality,
				encodingMode: optStr(p.encodingMode),
				...(p.internalHevcV2 === true
					? {
							internalHevcV2: true as const,
						}
					: {}),
				name: optStr(p.name),
				profile: optStr(p.profile),
				height: optNum(p.height),
				bitrate: optNum(p.bitrate),
				rate: optNum(p.rate),
				level: optStr(p.level),
				pixelFormat: optStr(p.pixelFormat),
				minKeyframeInterval: optNum(p.minKeyframeInterval),
				maxKeyframeInterval: optNum(p.maxKeyframeInterval),
				rcLookahead: optNum(p.rcLookahead),
				subMe: optNum(p.subMe),
				maxCTUSize: optStr(p.maxCTUSize),
				motionSearch: optStr(p.motionSearch),
				tuIntraDepth: optStr(p.tuIntraDepth),
				tuInterDepth: optStr(p.tuInterDepth),
				weightPredictionOnPSlice: optBool(p.weightPredictionOnPSlice),
				weightPredictionOnBSlice: optBool(p.weightPredictionOnBSlice),
				sceneCutThreshold: optNum(p.sceneCutThreshold),
				motionSearchRange: optNum(p.motionSearchRange),
				adaptiveQuantizationMode: optStr(p.adaptiveQuantizationMode),
				adaptiveQuantizationStrength: optNum(p.adaptiveQuantizationStrength),
				psyRateDistortionOptimization: optNum(p.psyRateDistortionOptimization),
				psyRateDistortionOptimizedQuantization: optNum(
					p.psyRateDistortionOptimizedQuantization,
				),
				qpMin: optNum(p.qpMin),
				sao: optBool(p.sao),
				hdr: optBool(p.hdr),
				masterDisplay: optStr(p.masterDisplay),
				maxContentLightLevel: optNum(p.maxContentLightLevel),
				maxPictureAverageLightLevel: optNum(p.maxPictureAverageLightLevel),
				colorConfig: colorConfigOf(p.colorConfig),
				presetConfiguration: optStr(p.presetConfiguration),
				maxBitrate: optNum(p.maxBitrate),
				bufsize: optNum(p.bufsize),
				dynamicRangeFormat: optStr(p.dynamicRangeFormat),
				levelHighTier: optBool(p.levelHighTier),
			});
			return { resourceId, request, response: { id: resourceId } };
		}

		case "CREATE_CODEC_VP9": {
			const resourceId = await ctx.sdk.createVp9Config({
				encodingMode: optStr(p.encodingMode),
				name: optStr(p.name),
				height: optNum(p.height),
				bitrate: optNum(p.bitrate),
				rate: optNum(p.rate),
				cpuUsed: optNum(p.cpuUsed),
				tileColumns: optNum(p.tileColumns),
				qpMin: optNum(p.qpMin),
				qpMax: optNum(p.qpMax),
				rateUndershootPct: optNum(p.rateUndershootPct),
				rateOvershootPct: optNum(p.rateOvershootPct),
				quality: optStr(p.quality),
				lossless: optBool(p.lossless),
				aqMode: optStr(p.aqMode),
				arnrType: optStr(p.arnrType),
				arnrMaxFrames: optNum(p.arnrMaxFrames),
				arnrStrength: optNum(p.arnrStrength),
				colorConfig: colorConfigOf(p.colorConfig),
			});
			return { resourceId, request, response: { id: resourceId } };
		}

		case "CREATE_CODEC_AV1": {
			const resourceId = await ctx.sdk.createAv1Config({
				encodingMode: optStr(p.encodingMode),
				name: optStr(p.name),
				height: optNum(p.height),
				bitrate: optNum(p.bitrate),
				rate: optNum(p.rate),
				presetConfiguration: optStr(p.presetConfiguration),
				autoLevelSetup: optStr(p.autoLevelSetup),
				dynamicRangeFormat: optStr(p.dynamicRangeFormat),
				colorConfig: colorConfigOf(p.colorConfig),
			});
			return { resourceId, request, response: { id: resourceId } };
		}

		case "CREATE_CODEC_IMSC": {
			const resourceId = await ctx.sdk.createImscConfig({
				styling: p.styling as { mode?: string } | undefined,
			});
			return { resourceId, request, response: { id: resourceId } };
		}
		case "CREATE_CODEC_OPUS": {
			const resourceId = await ctx.sdk.createOpusConfig({
				name: optStr(p.name),
				bitrate: num(p.bitrate, 0),
				rate: num(p.rate, 48000),
				channelLayout: str(p.channelLayout),
			});
			return { resourceId, request, response: { id: resourceId } };
		}
		case "CREATE_CODEC_AAC": {
			const resourceId = await ctx.sdk.createAacConfig({
				name: optStr(p.name),
				bitrate: num(p.bitrate, 0),
				rate: num(p.rate, 0),
				channelLayout: str(p.channelLayout),
			});
			return { resourceId, request, response: { id: resourceId } };
		}

		case "CREATE_CODEC_DOLBY_ATMOS": {
			const resourceId = await ctx.sdk.createDolbyAtmosConfig({
				name: optStr(p.name),
				bitrate: num(p.bitrate, 0),
				rate: num(p.rate, 0),
				loudnessControl: p.loudnessControl as
					| {
							meteringMode?: string;
							dialogueIntelligence?: string;
							speechThreshold?: number;
					  }
					| undefined,
			});
			return { resourceId, request, response: { id: resourceId } };
		}

		case "CREATE_CODEC_DDPLUS": {
			const resourceId = await ctx.sdk.createDolbyDigitalPlusConfig({
				name: optStr(p.name),
				bitrate: num(p.bitrate, 0),
				rate: num(p.rate, 0),
				channelLayout: str(p.channelLayout),
			});
			return { resourceId, request, response: { id: resourceId } };
		}

		case "CREATE_CODEC_DD": {
			const resourceId = await ctx.sdk.createDolbyDigitalConfig({
				name: optStr(p.name),
				bitrate: num(p.bitrate, 0),
				rate: num(p.rate, 0),
				channelLayout: str(p.channelLayout),
			});
			return { resourceId, request, response: { id: resourceId } };
		}

		case "CREATE_CODEC_WEBVTT": {
			const resourceId = await ctx.sdk.createWebVttConfig({
				name: optStr(p.name),
			});
			return { resourceId, request, response: { id: resourceId } };
		}
		default:
			throw new Error(
				`executeConfigStep: unhandled kind ${String(op.kind)} — the executor dispatch and this switch have diverged`,
			);
	}
}
