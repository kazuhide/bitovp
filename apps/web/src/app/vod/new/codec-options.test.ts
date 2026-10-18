import {
	AdaptiveQuantMode,
	ColorPrimaries,
	ColorSpace,
	ColorTransfer,
	H264MotionEstimationMethod,
	H264SubMe,
	H264Trellis,
	LevelH264,
	LevelH265,
	MaxCtuSize,
	MotionSearch,
	MvPredictionMode,
	PixelFormat,
	TuInterDepth,
	TuIntraDepth,
	Vp9AqMode,
	Vp9ArnrType,
	Vp9Quality,
} from "@bitmovin/api-sdk";
import { describe, expect, it } from "vitest";
import { CODEC_OPTIONS } from "./codec-options";

const sdk = {
	ColorSpace,
	ColorPrimaries,
	ColorTransfer,
	H264Trellis,
	H264SubMe,
	H264MotionEstimationMethod,
	AdaptiveQuantMode,
	MvPredictionMode,
	MaxCtuSize,
	MotionSearch,
	TuIntraDepth,
	TuInterDepth,
	LevelH264,
	LevelH265,
	PixelFormat,
	Vp9Quality,
	Vp9AqMode,
	Vp9ArnrType,
};
describe("codec option contract", () => {
	it.each(
		Object.keys(CODEC_OPTIONS) as (keyof typeof CODEC_OPTIONS)[],
	)("%s matches executor SDK enum names", (name) => {
		expect([...CODEC_OPTIONS[name]]).toEqual(Object.keys(sdk[name]));
	});
});
