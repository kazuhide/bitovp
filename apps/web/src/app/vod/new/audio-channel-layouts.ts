import { CODEC_OPTIONS, OPUS_CHANNEL_LAYOUTS } from "@bitovp/core";

// SDK enum keys, not wire values: sdkEnumValue resolves them at execution.
// Kept browser-safe; parity with the installed SDK is covered by UI tests.
const AAC_CHANNEL_LAYOUTS = [
	"NONE",
	"MONO",
	"CL_STEREO",
	"CL_SURROUND",
	"CL_4_0",
	"CL_5_0_BACK",
	"CL_5_1_BACK",
	"CL_7_1",
	"CL_7_1_WIDE_BACK",
] as const;

const DOLBY_CHANNEL_LAYOUTS = [
	"NONE",
	"MONO",
	"CL_STEREO",
	"CL_SURROUND",
	"CL_3_1",
	"CL_BACK_SURROUND",
	"CL_BACK_SURROUND_LFE",
	"CL_QUAD",
	"CL_QUAD_LFE",
	"CL_4_0",
	"CL_4_1",
	"CL_5_0",
	"CL_5_1",
] as const;

export const AUDIO_CHANNEL_LAYOUTS: Record<
	"AAC" | "OPUS" | "DD" | "DDPLUS" | "AC3" | "EAC3",
	readonly string[]
> = {
	AAC: AAC_CHANNEL_LAYOUTS,
	AC3: CODEC_OPTIONS.Ac3ChannelLayout,
	EAC3: CODEC_OPTIONS.Ac3ChannelLayout,
	OPUS: OPUS_CHANNEL_LAYOUTS,
	DD: DOLBY_CHANNEL_LAYOUTS,
	DDPLUS: DOLBY_CHANNEL_LAYOUTS,
};
