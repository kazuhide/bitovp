import type { LiveChannelPlan } from "./schema";

export type LiveEncodingOptionReasonCode =
	| "LEGACY_CUSTOM"
	| "CUSTOM_REQUESTED"
	| "CODEC_UNSUPPORTED"
	| "INPUT_PROTOCOL"
	| "INPUT_DEPENDENT"
	| "VIDEO_COUNT"
	| "HD_VIDEO_COUNT"
	| "VIDEO_LONG_EDGE"
	| "VIDEO_SHORT_EDGE"
	| "VIDEO_FRAME_RATE"
	| "VIDEO_BITRATE"
	| "TOTAL_VIDEO_PIXELS"
	| "TOTAL_VIDEO_BITRATE"
	| "AUDIO_COUNT"
	| "AUDIO_BITRATE"
	| "AUDIO_SAMPLE_RATE"
	| "AUDIO_CHANNELS"
	| "ENCODING_MODE"
	| "PRESET_UNSUPPORTED"
	| "MANIFEST_COUNT";

export type LiveEncodingOptionReason = {
	code: LiveEncodingOptionReasonCode;
	renditionKey?: string;
	actual?: string | number;
	limit?: number;
};

export type LiveEncodingOptionResolution = {
	encodingOption: "HD" | "CUSTOM";
	reasons: LiveEncodingOptionReason[];
};

const LIVE_PRESETS = new Set([
	"LIVE_STANDARD",
	"LIVE_LOW_LATENCY",
	"LIVE_LOWER_LATENCY",
	"LIVE_VERYLOW_LATENCY",
]);
// SDK enum NAMES, not wire values: the worker resolves AacChannelLayout[name].
// NONE is a valid request but inherits input, so it cannot confirm <=2 channels.
const AUDIO_CHANNELS: Readonly<Record<string, number | null>> = {
	NONE: null,
	MONO: 1,
	CL_STEREO: 2,
	CL_SURROUND: 3,
	CL_4_0: 4,
	CL_5_0_BACK: 5,
	CL_5_1_BACK: 6,
	CL_7_1: 8,
	CL_7_1_WIDE_BACK: 8,
};
/** Shared by pre-provisioning validation and HD eligibility; no inherited keys. */
export function isLiveAacChannelLayout(name: string): boolean {
	return Object.hasOwn(AUDIO_CHANNELS, name);
}
const positive = (n: unknown): n is number =>
	typeof n === "number" && Number.isFinite(n) && n > 0;

/**
 * Both edges when at least one is fixed: a lone edge is completed at 16:9,
 * the shape the wizard's ladders and the provider's inheritance produce for a
 * 16:9 input. Both missing ⇒ both undefined (input-dependent). A non-16:9
 * input can still exceed the limit at run time; this is an authored-plan
 * judgement, not a probe.
 */
export function assumeSixteenNine(
	width: unknown,
	height: unknown,
): { width?: number; height?: number } {
	const w = positive(width) ? width : undefined;
	const h = positive(height) ? height : undefined;
	if (w !== undefined && h !== undefined) return { width: w, height: h };
	if (w !== undefined) return { width: w, height: Math.round((w * 9) / 16) };
	if (h !== undefined) return { width: Math.round((h * 16) / 9), height: h };
	return {};
}

/**
 * Classify the authored plan, not account entitlement or deployed behavior.
 * Inherited dimensions cannot establish HD eligibility. A single explicit
 * dimension is completed at 16:9; general validation separately checks
 * stream filters, codec settings, and Per-Title restrictions.
 */
export function resolveLiveEncodingOption(
	plan: LiveChannelPlan,
): LiveEncodingOptionResolution {
	if (plan.start.encodingOption === undefined)
		return { encodingOption: "CUSTOM", reasons: [{ code: "LEGACY_CUSTOM" }] };
	if (plan.start.encodingOption === "CUSTOM")
		return {
			encodingOption: "CUSTOM",
			reasons: [{ code: "CUSTOM_REQUESTED" }],
		};
	const reasons: LiveEncodingOptionReason[] = [];
	// Public HD support names RTMP (including backup) and SRT. Other inputs
	// remain Custom unless support is confirmed; this is not a runtime probe.
	if (
		plan.liveInput.kind !== "RTMP" &&
		plan.liveInput.kind !== "REDUNDANT_RTMP" &&
		plan.liveInput.kind !== "SRT"
	)
		reasons.push({ code: "INPUT_PROTOCOL", actual: plan.liveInput.kind });
	const over = (
		code: LiveEncodingOptionReasonCode,
		actual: number,
		limit: number,
		renditionKey?: string,
	) => {
		if (actual > limit)
			reasons.push({
				code,
				actual,
				limit,
				...(renditionKey ? { renditionKey } : {}),
			});
	};
	const unknown = (renditionKey: string, actual: string) =>
		reasons.push({ code: "INPUT_DEPENDENT", renditionKey, actual });
	const mode = plan.start.liveEncodingMode;
	if (mode !== undefined && mode !== "STANDARD" && mode !== "SINGLE_PASS")
		reasons.push({ code: "ENCODING_MODE", actual: mode });
	let videoCount = 0,
		hdCount = 0,
		pixels = 0,
		bitrate = 0,
		audioCount = 0;
	for (const r of plan.renditions) {
		if (r.codec === "H264") {
			videoCount++;
			for (const field of ["rate", "bitrate"] as const)
				if (!positive(r[field])) unknown(r.key, field);
			const { width, height } = assumeSixteenNine(r.width, r.height);
			if (width === undefined) unknown(r.key, "width");
			if (height === undefined) unknown(r.key, "height");
			if (width !== undefined && height !== undefined) {
				const long = Math.max(width, height),
					short = Math.min(width, height);
				over("VIDEO_LONG_EDGE", long, 1920, r.key);
				over("VIDEO_SHORT_EDGE", short, 1200, r.key);
				if (long >= 1280 || short >= 720) hdCount++;
				pixels += width * height;
			}
			if (positive(r.rate)) over("VIDEO_FRAME_RATE", r.rate, 30, r.key);
			if (positive(r.bitrate)) {
				over("VIDEO_BITRATE", r.bitrate, 7_000_000, r.key);
				bitrate += r.bitrate;
			}
			if (
				r.presetConfiguration != null &&
				!LIVE_PRESETS.has(r.presetConfiguration)
			)
				reasons.push({
					code: "PRESET_UNSUPPORTED",
					renditionKey: r.key,
					actual: r.presetConfiguration,
				});
			// Color metadata is not the provider's dynamicRangeFormat. Do not
			// infer SDR for copied/unknown transfer or explicit HDR transfer.
			if (
				r.colorConfig?.copyColorTransferFlag === true ||
				(r.colorConfig?.colorTransfer !== undefined &&
					r.colorConfig.colorTransfer !== "BT709")
			)
				unknown(r.key, "colorConfig");
		} else if (r.codec === "AAC") {
			audioCount++;
			for (const field of ["rate", "bitrate"] as const)
				if (!positive(r[field])) unknown(r.key, field);
			over("AUDIO_BITRATE", r.bitrate, 192_000, r.key);
			over("AUDIO_SAMPLE_RATE", r.rate, 48_000, r.key);
			const channels = isLiveAacChannelLayout(r.channelLayout)
				? AUDIO_CHANNELS[r.channelLayout]
				: undefined;
			if (channels == null) unknown(r.key, "channelLayout");
			else over("AUDIO_CHANNELS", channels, 2, r.key);
		} else if (r.codec !== "WEBVTT") {
			reasons.push({
				code: "CODEC_UNSUPPORTED",
				renditionKey: r.key,
				actual: r.codec,
			});
		}
	}
	over("VIDEO_COUNT", videoCount, 6);
	over("HD_VIDEO_COUNT", hdCount, 3);
	over("TOTAL_VIDEO_PIXELS", pixels, 4_800_000);
	over("TOTAL_VIDEO_BITRATE", bitrate, 16_000_000);
	over("AUDIO_COUNT", audioCount, 2);
	// Public Live HD limit is manifests, not delivery outputs/mirrors.
	over("MANIFEST_COUNT", plan.liveManifests.length, 2);
	return { encodingOption: reasons.length === 0 ? "HD" : "CUSTOM", reasons };
}
