import type { CompiledOperation } from "@bitovp/core";
import { afterEach, expect, it, vi } from "vitest";
import { executeStep } from "./executor";
import { createBitmovinSdkOps } from "./sdk-ops";

afterEach(() => vi.unstubAllGlobals());

it.each([
	"AV1",
	"VP9",
] as const)("serializes %s sample aspect ratio without a display override", async (codec) => {
	const fetch = vi.fn(
		async () =>
			new Response(JSON.stringify({ data: { result: { id: "created" } } }), {
				status: 201,
				headers: { "content-type": "application/json" },
			}),
	);
	vi.stubGlobal("fetch", fetch);
	const sdk = createBitmovinSdkOps(
		{ apiKey: "test-only", tenantOrgId: null, bitmovinAccountId: "account" },
		async () => {},
	);
	await executeStep(
		{
			step: "codec:aspect",
			kind: `CREATE_CODEC_${codec}`,
			refs: {},
			payload: {
				bitrate: 600000,
				height: 360,
				sampleAspectRatioNumerator: 4,
				sampleAspectRatioDenominator: 3,
			},
		},
		{
			sdk,
			ids: new Map(),
			resolveCredential: vi.fn(),
			poll: { intervalMs: 1, timeoutMs: 50, sleep: async () => {} },
		},
	);
	const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
	const body = JSON.parse(init.body as string);
	expect(body).toMatchObject({
		sampleAspectRatioNumerator: 4,
		sampleAspectRatioDenominator: 3,
	});
	expect(body).not.toHaveProperty("displayAspectRatio");
});
const cases = [
	[
		"H264",
		{
			autoLevelSetup: "DISABLED",
			bAdaptiveStrategy: "FULL",
			bPyramid: "NORMAL",
			cea608708SubtitleConfig: {
				passthroughActivated: true,
				passthroughMode: "VIDEO_CAPTION_STREAM",
			},
			deblockAlpha: 0,
			deblockBeta: 0,
			dynamicRangeFormat: "SDR",
			fastSkipDetectionPFrames: false,
			interlaceMode: "BOTTOM_FIELD_FIRST",
			macroblockTreeRatecontrol: false,
			mixedReferences: false,
			nalHrd: "CBR",
			partitions: ["ALL"],
			pixelFormat: "YUV444P12BE",
			qpMax: 40,
			qpMin: 0,
			quantizerCurveCompression: 0.6,
			weightedPredictionBFrames: false,
		},
		{
			autoLevelSetup: "DISABLED",
			bAdaptiveStrategy: "FULL",
			bPyramid: "NORMAL",
			cea608708SubtitleConfig: {
				passthroughActivated: true,
				passthroughMode: "VIDEO_CAPTION_STREAM",
			},
			deblockAlpha: 0,
			deblockBeta: 0,
			dynamicRangeFormat: "SDR",
			fastSkipDetectionPFrames: false,
			interlaceMode: "BOTTOM_FIELD_FIRST",
			macroblockTreeRatecontrol: false,
			mixedReferences: false,
			nalHrd: "CBR",
			partitions: ["ALL"],
			pixelFormat: "YUV444P12BE",
			qpMax: 40,
			qpMin: 0,
			quantizerCurveCompression: 0.6,
			weightedPredictionBFrames: false,
		},
	],
	[
		"H265",
		{
			adaptiveQuantizationMotion: false,
			allowedRADLBeforeIDR: 0,
			analyzeSourceFramePixels: false,
			asymetricMotionPartitionsAnalysis: false,
			autoLevelSetup: "DISABLED",
			bAdapt: "FULL",
			bframeBias: 0,
			blurComplexity: 0,
			blurQuants: 0,
			cea608708SubtitleConfig: {
				passthroughActivated: true,
				passthroughMode: "VIDEO_CAPTION_STREAM",
			},
			codingUnitLossless: false,
			constrainedIntraPrediction: false,
			copyPicture: false,
			cutree: false,
			dynamicRateDistortionStrength: 0,
			earlySkip: false,
			enableHlgSignaling: false,
			enableHrdSignaling: false,
			evaluationOfIntraModesInBSlices: false,
			fastSearchForAngularIntraPredictions: false,
			forceFlush: "SLICE_TYPE",
			gopLookahead: 0,
			grainOptimizedRateControl: false,
			ipRatio: 1.4,
			limitModes: false,
			limitReferences: "DEPTH_AND_CU",
			limitSao: false,
			limitTransformUnitDepthRecursion: "LEVEL_4",
			lookaheadSlices: 0,
			lowpassDct: false,
			maximumTransformUnitSize: "MTU_32x32",
			maxMerge: 3,
			minCodingUnitSize: "MCU_32x32",
			noiseReductionInter: 0,
			noiseReductionIntra: 0,
			pbRatio: 1.3,
			qpOffsetChromaCb: 0,
			qpOffsetChromaCr: 0,
			qpStep: 0,
			quantizationGroupSize: "QGS_64x64",
			quantizerCurveCompressionFactor: 0.6,
			rateDistortionLevelForModeDecision: 0,
			rateDistortionLevelForQuantization: "LEVELS_AND_CODING_GROUPS",
			rateDistortionPenalty: "MAXIMUM",
			rectangularMotionPartitionsAnalysis: false,
			recursionSkip: false,
			refineRateDistortionCost: false,
			saoNonDeblock: false,
			scenecutBias: 0,
			signHide: false,
			skipSplitRateDistortionAnalysis: false,
			slices: 0,
			ssimRateDistortionOptimization: false,
			strongIntraSmoothing: false,
			temporalMotionVectorPredictors: false,
			transformSkip: "FAST",
			videoFormat: "MAC",
			wavefrontParallelProcessing: false,
		},
		{
			adaptiveQuantizationMotion: false,
			allowedRADLBeforeIDR: 0,
			analyzeSourceFramePixels: false,
			asymetricMotionPartitionsAnalysis: false,
			autoLevelSetup: "DISABLED",
			bAdapt: "FULL",
			bframeBias: 0,
			blurComplexity: 0,
			blurQuants: 0,
			cea608708SubtitleConfig: {
				passthroughActivated: true,
				passthroughMode: "VIDEO_CAPTION_STREAM",
			},
			codingUnitLossless: false,
			constrainedIntraPrediction: false,
			copyPicture: false,
			cutree: false,
			dynamicRateDistortionStrength: 0,
			earlySkip: false,
			enableHlgSignaling: false,
			enableHrdSignaling: false,
			evaluationOfIntraModesInBSlices: false,
			fastSearchForAngularIntraPredictions: false,
			forceFlush: "SLICE_TYPE",
			gopLookahead: 0,
			grainOptimizedRateControl: false,
			ipRatio: 1.4,
			limitModes: false,
			limitReferences: "DEPTH_AND_CU",
			limitSao: false,
			limitTransformUnitDepthRecursion: "LEVEL_4",
			lookaheadSlices: 0,
			lowpassDct: false,
			maximumTransformUnitSize: "MTU_32x32",
			maxMerge: 3,
			minCodingUnitSize: "MCU_32x32",
			noiseReductionInter: 0,
			noiseReductionIntra: 0,
			pbRatio: 1.3,
			qpOffsetChromaCb: 0,
			qpOffsetChromaCr: 0,
			qpStep: 0,
			quantizationGroupSize: "QGS_64x64",
			quantizerCurveCompressionFactor: 0.6,
			rateDistortionLevelForModeDecision: 0,
			rateDistortionLevelForQuantization: "LEVELS_AND_CODING_GROUPS",
			rateDistortionPenalty: "MAXIMUM",
			rectangularMotionPartitionsAnalysis: false,
			recursionSkip: false,
			refineRateDistortionCost: false,
			saoNonDeblock: false,
			scenecutBias: 0,
			signHide: false,
			skipSplitRateDistortionAnalysis: false,
			slices: 0,
			ssimRateDistortionOptimization: false,
			strongIntraSmoothing: false,
			temporalMotionVectorPredictors: false,
			transformSkip: "FAST",
			videoFormat: "MAC",
			wavefrontParallelProcessing: false,
		},
	],
	[
		"VP9",
		{
			autoLevelSetup: "DISABLED",
			automaticAltRefFramesEnabled: false,
			biasPct: 0,
			clientBufferSize: 1000,
			clientInitialBufferSize: 500,
			crf: 0,
			displayAspectRatio: {
				numerator: 16,
				denominator: 9,
			},
			dynamicRangeFormat: "SDR",
			errorResiliencyEnabled: false,
			frameParallel: false,
			lagInFrames: 0,
			maxGop: 0,
			maxIntraRate: 0,
			maxKeyframeInterval: 2,
			minGop: 0,
			minKeyframeInterval: 1,
			noiseSensitivity: false,
			pixelFormat: "YUV444P12BE",
			presetConfiguration: "VOD_HARDWARE_SHORTFORM",
			rowMultiThreadingEnabled: false,
			sharpness: 0,
			staticThresh: 0,
			targetLevel: 0,
			tileRows: 0,
		},
		{
			autoLevelSetup: "DISABLED",
			automaticAltRefFramesEnabled: false,
			biasPct: 0,
			clientBufferSize: 1000,
			clientInitialBufferSize: 500,
			crf: 0,
			displayAspectRatio: {
				numerator: 16,
				denominator: 9,
			},
			dynamicRangeFormat: "SDR",
			errorResiliencyEnabled: false,
			frameParallel: false,
			lagInFrames: 0,
			maxGop: 0,
			maxIntraRate: 0,
			maxKeyframeInterval: 2,
			minGop: 0,
			minKeyframeInterval: 1,
			noiseSensitivity: false,
			pixelFormat: "YUV444P12BE",
			presetConfiguration: "VOD_HARDWARE_SHORTFORM",
			rowMultiThreadingEnabled: false,
			sharpness: 0,
			staticThresh: 0,
			targetLevel: 0,
			tileRows: 0,
		},
	],
	[
		"AV1",
		{
			displayAspectRatio: {
				numerator: 16,
				denominator: 9,
			},
			pixelFormat: "YUV444P12BE",
		},
		{
			displayAspectRatio: {
				numerator: 16,
				denominator: 9,
			},
			pixelFormat: "YUV444P12BE",
		},
	],
] as const;

it.each(
	cases,
)("sends all additional %s controls through the executor and SDK mapper", async (codec, controls, expected) => {
	const fetch = vi.fn(
		async () =>
			new Response(JSON.stringify({ data: { result: { id: "created" } } }), {
				status: 201,
				headers: { "content-type": "application/json" },
			}),
	);
	vi.stubGlobal("fetch", fetch);
	const sdk = createBitmovinSdkOps(
		{ apiKey: "test-only", tenantOrgId: null, bitmovinAccountId: "account" },
		async () => {},
	);
	const op: CompiledOperation = {
		step: "codec:details",
		kind: `CREATE_CODEC_${codec}`,
		refs: {},
		payload: { height: 360, bitrate: 600000, ...controls },
	};
	await executeStep(op, {
		sdk,
		ids: new Map(),
		resolveCredential: vi.fn(),
		poll: { intervalMs: 1, timeoutMs: 50, sleep: async () => {} },
	});
	expect(fetch).toHaveBeenCalledOnce();
	const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
	expect(JSON.parse(init.body as string)).toMatchObject(expected);
});

it.each([
	"AAC",
	"AC3",
	"EAC3",
] as const)("sends %s cutoffFrequency to its own audio API", async (codec) => {
	for (const cutoffFrequency of [0, 16000]) {
		const fetch = vi.fn(
			async () =>
				new Response(JSON.stringify({ data: { result: { id: "created" } } }), {
					status: 201,
					headers: { "content-type": "application/json" },
				}),
		);
		vi.stubGlobal("fetch", fetch);
		const sdk = createBitmovinSdkOps(
			{ apiKey: "test-only", tenantOrgId: null, bitmovinAccountId: "account" },
			async () => {},
		);
		await executeStep(
			{
				step: "codec:audio",
				kind: `CREATE_CODEC_${codec}`,
				refs: {},
				payload: {
					bitrate: 128000,
					rate: 48000,
					channelLayout: "CL_STEREO",
					cutoffFrequency,
				},
			},
			{
				sdk,
				ids: new Map(),
				resolveCredential: vi.fn(),
				poll: { intervalMs: 1, timeoutMs: 50, sleep: async () => {} },
			},
		);
		const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
		expect(new URL(url).pathname).toBe(
			`/v1/encoding/configurations/audio/${codec.toLowerCase()}`,
		);
		expect(JSON.parse(init.body as string)).toEqual({
			type: codec,
			bitrate: 128000,
			rate: 48000,
			channelLayout: "STEREO",
			cutoffFrequency,
		});
	}
});
