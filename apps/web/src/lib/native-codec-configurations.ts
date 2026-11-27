import { z } from "zod";

export const nativeCodecKinds = [
	"dts",
	"dts-passthrough",
	"dtsx",
	"mp2",
	"mp3",
	"vorbis",
	"dvb-subtitle",
	"h262",
	"mjpeg",
	"vp8",
] as const;
export const dtsXBitrates = [
	160000, 192000, 224000, 256000, 288000, 320000, 384000, 448000,
] as const;
export const h262Profile = "MPEG2_422";
export const nativeCodecKind = z.enum(nativeCodecKinds);
export type NativeCodecKind = z.infer<typeof nativeCodecKind>;

export const nativeCodecLabels = {
	dts: "DTS",
	"dts-passthrough": "DTS Passthrough",
	dtsx: "DTS:X",
	mp2: "MP2",
	mp3: "MP3",
	vorbis: "Vorbis",
	"dvb-subtitle": "DVB-SUB",
	h262: "H.262",
	mjpeg: "MJPEG",
	vp8: "VP8",
} satisfies Record<NativeCodecKind, string>;

export const nativeCodecUuid = z.uuid().toLowerCase();
const scope = {
	bitmovinAccountId: nativeCodecUuid,
	scopeVersion: nativeCodecUuid,
};
const configuration = {
	...scope,
	name: z
		.string()
		.trim()
		.min(1)
		.max(80)
		.regex(/^[^\p{Cc}]+$/u),
};
const bitrate = z.int().min(1).max(2_147_483_647);
const audio = {
	...configuration,
	bitrate,
	rate: z.int().min(1).max(768_000).optional(),
};
const videoSize = {
	width: z.int().min(1).max(16_384).optional(),
	height: z.int().min(1).max(16_384).optional(),
};
const videoRate = z.number().positive().max(240);
const video = { ...configuration, ...videoSize, rate: videoRate.optional() };

export const createNativeCodecSchema = z.discriminatedUnion("codec", [
	z.strictObject({
		...audio,
		codec: z.literal("dts"),
		mode: z.enum(["EXPRESS_AUDIO", "DIGITAL_SURROUND"]).optional(),
	}),
	z.strictObject({ ...configuration, codec: z.literal("dts-passthrough") }),
	z.strictObject({
		...configuration,
		codec: z.literal("dtsx"),
		bitrate: z.literal(dtsXBitrates),
		channelLayout: z.enum(["5.1", "5.1.4"]),
	}),
	z.strictObject({ ...audio, codec: z.literal("mp2") }),
	z.strictObject({ ...audio, codec: z.literal("mp3") }),
	z.strictObject({ ...audio, codec: z.literal("vorbis") }),
	z.strictObject({ ...configuration, codec: z.literal("dvb-subtitle") }),
	z.strictObject({
		...video,
		codec: z.literal("h262"),
		profile: z.literal(h262Profile),
		bitrate,
	}),
	z.strictObject({
		...video,
		codec: z.literal("mjpeg"),
		qScale: z.int().min(1).max(2_147_483_647),
		rate: videoRate,
	}),
	z.strictObject({ ...video, codec: z.literal("vp8"), bitrate }),
]);
export type CreateNativeCodec = z.infer<typeof createNativeCodecSchema>;
export const checkNativeCodecSchema = z.strictObject({
	...scope,
	id: nativeCodecUuid,
});
export const patchNativeCodecSchema = checkNativeCodecSchema.extend({
	resume: z.literal(true).optional(),
});
export const deleteNativeCodecSchema = checkNativeCodecSchema.extend({
	confirmProviderId: nativeCodecUuid,
});
export type CheckNativeCodec = z.infer<typeof checkNativeCodecSchema>;
export type DeleteNativeCodec = z.infer<typeof deleteNativeCodecSchema>;

export type NativeCodecState =
	| "CREATING"
	| "ACTIVE"
	| "DELETING"
	| "REMOVED"
	| "REJECTED";
export type NativeCodecReceipt = {
	id: string;
	codec: NativeCodecKind;
	name: string;
	state: NativeCodecState;
	providerId: string | null;
	canAct: boolean;
	canRetryDelete: boolean;
	canResumeCreate: boolean;
};
export type NativeCodecList = {
	rows: NativeCodecReceipt[];
	scopeVersion: string;
	hasMore: boolean;
};
