import {
	AacChannelLayout,
	Ac3ChannelLayout,
	AdaptiveQuantMode,
	AutoLevelSetup,
	Av1DetailPreservationMode,
	BAdapt,
	ColorPrimaries,
	ColorSpace,
	ColorTransfer,
	DolbyDigitalChannelLayout,
	DolbyDigitalPlusChannelLayout,
	ForceFlushMode,
	H264BPyramid,
	H264DynamicRangeFormat,
	H264InterlaceMode,
	H264MotionEstimationMethod,
	H264NalHrd,
	H264Partition,
	H264SubMe,
	H264Trellis,
	LevelAv1,
	LevelH264,
	LevelH265,
	LimitReferences,
	LimitTransformUnitDepthRecursionMode,
	MaxCtuSize,
	MaxTransformUnitSize,
	MinCodingUnitSize,
	MotionSearch,
	MvPredictionMode,
	PassthroughMode,
	PixelFormat,
	PresetConfiguration,
	QuantizationGroupSize,
	RateDistortionLevelForQuantization,
	RateDistortionPenaltyMode,
	TransformSkipMode,
	TuInterDepth,
	TuIntraDepth,
	VideoFormat,
	Vp9AqMode,
	Vp9ArnrType,
	Vp9DynamicRangeFormat,
	Vp9Quality,
} from "@bitmovin/api-sdk";
import { CODEC_ENUM_VALUES, type CompiledOperation } from "@bitovp/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeStep } from "./executor";
import { createBitmovinSdkOps, sdkEnumValue } from "./sdk-ops";

afterEach(() => vi.unstubAllGlobals());
const sdkEnums = {
	Ac3ChannelLayout,
	AutoLevelSetup,
	Av1DetailPreservationMode,
	BAdapt,
	ForceFlushMode,
	H264BPyramid,
	H264DynamicRangeFormat,
	H264InterlaceMode,
	H264NalHrd,
	H264Partition,
	LimitReferences,
	LimitTransformUnitDepthRecursionMode,
	MaxTransformUnitSize,
	MinCodingUnitSize,
	PassthroughMode,
	QuantizationGroupSize,
	RateDistortionLevelForQuantization,
	RateDistortionPenaltyMode,
	TransformSkipMode,
	VideoFormat,
	Vp9DynamicRangeFormat,

	AacChannelLayout,
	AdaptiveQuantMode,
	ColorPrimaries,
	ColorSpace,
	ColorTransfer,
	DolbyDigitalChannelLayout,
	DolbyDigitalPlusChannelLayout,
	H264MotionEstimationMethod,
	H264SubMe,
	H264Trellis,
	LevelAv1,
	LevelH264,
	LevelH265,
	MaxCtuSize,
	MotionSearch,
	MvPredictionMode,
	PixelFormat,
	PresetConfiguration,
	TuInterDepth,
	TuIntraDepth,
	Vp9AqMode,
	Vp9ArnrType,
	Vp9Quality,
};

describe("safe SDK enum conversion", () => {
	it.each(
		Object.keys(CODEC_ENUM_VALUES) as (keyof typeof CODEC_ENUM_VALUES)[],
	)("shares exact %s names and values with the installed SDK", (name) => {
		expect(CODEC_ENUM_VALUES[name]).toEqual(sdkEnums[name]);
		for (const [key, wire] of Object.entries(CODEC_ENUM_VALUES[name])) {
			expect(sdkEnumValue(sdkEnums[name], key, name)).toBe(wire);
			expect(sdkEnumValue(sdkEnums[name], wire, name)).toBe(wire);
		}
	});

	it("keeps recognized SDK names and wire values compatible", () => {
		expect(sdkEnumValue(LevelH264, "L4_1", "LevelH264")).toBe("4.1");
		expect(sdkEnumValue(LevelH264, "4.1", "LevelH264")).toBe("4.1");
		expect(sdkEnumValue(MaxCtuSize, "64", "MaxCtuSize")).toBe("64");
	});

	it.each([
		"",
		"toString",
		"constructor",
		"__proto__",
		"INVALID_ENUM",
	])("rejects invalid enum member %s", (name) => {
		expect(() => sdkEnumValue(LevelH264, name, "LevelH264")).toThrow(
			"Unknown LevelH264",
		);
	});

	it("rejects non-string own properties and inherited string properties", () => {
		expect(() =>
			sdkEnumValue(
				{ INVALID: {} } as unknown as Record<string, string>,
				"INVALID",
				"TestEnum",
			),
		).toThrow("Unknown TestEnum");
		expect(() =>
			sdkEnumValue(
				Object.create({ INHERITED: "value" }),
				"INHERITED",
				"TestEnum",
			),
		).toThrow("Unknown TestEnum");
	});

	it.each([
		["CREATE_CODEC_H264", { level: "4.1" }, { level: "4.1" }],
		[
			"CREATE_CODEC_H265",
			{ level: "4.1", maxCTUSize: "64", tuIntraDepth: "4" },
			{ level: "4.1", maxCTUSize: "64", tuIntraDepth: "4" },
		],
		[
			"CREATE_CODEC_AAC",
			{ rate: 48000, channelLayout: "STEREO" },
			{ channelLayout: "STEREO" },
		],
		[
			"CREATE_CODEC_DD",
			{ rate: 48000, channelLayout: "5.1" },
			{ channelLayout: "5.1" },
		],
		[
			"CREATE_CODEC_DDPLUS",
			{ rate: 48000, channelLayout: "5.1" },
			{ channelLayout: "5.1" },
		],
	] as const)("serializes recognized %s wire aliases through the installed SDK", async (kind, payload, expected) => {
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
				step: "codec:video",
				kind,
				refs: {},
				payload: { height: 360, bitrate: 600000, ...payload },
			} as CompiledOperation,
			{
				sdk,
				ids: new Map(),
				resolveCredential: vi.fn(),
				poll: { intervalMs: 1, timeoutMs: 1, sleep: async () => {} },
			},
		);
		expect(fetch).toHaveBeenCalledOnce();
		const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
		expect(JSON.parse(init.body as string)).toMatchObject(expected);
	});
});
