import { z } from "zod";
import { codecEnumSchema } from "./codec-enums";

export const HE_AAC_CODECS = ["HE_AAC_V1", "HE_AAC_V2"] as const;
export type HeAacCodec = (typeof HE_AAC_CODECS)[number];
export const HE_AAC_MAX_BITRATE = {
	HE_AAC_V1: 128_000,
	HE_AAC_V2: 64_000,
} as const;
export const HE_AAC_V1_SIGNALING = [
	"IMPLICIT",
	"EXPLICIT_SBR",
	"EXPLICIT_HIERARCHICAL",
] as const;
export const HE_AAC_V2_SIGNALING = [
	...HE_AAC_V1_SIGNALING,
	"EXPLICIT_PS",
] as const;
export type HeAacSignaling = (typeof HE_AAC_V2_SIGNALING)[number];

export function isHeAac(codec: string | undefined): codec is HeAacCodec {
	return codec === "HE_AAC_V1" || codec === "HE_AAC_V2";
}

const shared = {
	name: z.string().min(1).optional(),
	rate: z.number().positive().optional(),
	channelLayout: codecEnumSchema("AacChannelLayout").optional(),
};
export const heAacV1Fields = {
	...shared,
	codec: z.literal("HE_AAC_V1"),
	bitrate: z.number().int().positive().max(HE_AAC_MAX_BITRATE.HE_AAC_V1),
	signaling: z.enum(HE_AAC_V1_SIGNALING).optional(),
};
export const heAacV2Fields = {
	...shared,
	codec: z.literal("HE_AAC_V2"),
	bitrate: z.number().int().positive().max(HE_AAC_MAX_BITRATE.HE_AAC_V2),
	signaling: z.enum(HE_AAC_V2_SIGNALING).optional(),
};

const requiredName = z.string().min(1);
export const heAacV1ConfigSchema = z
	.strictObject(heAacV1Fields)
	.omit({ codec: true })
	.extend({ name: requiredName });
export const heAacV2ConfigSchema = z
	.strictObject(heAacV2Fields)
	.omit({ codec: true })
	.extend({ name: requiredName });
export type HeAacV1Config = z.infer<typeof heAacV1ConfigSchema>;
export type HeAacV2Config = z.infer<typeof heAacV2ConfigSchema>;

/** Both create resources require a name. Use the stable rendition key when the plan omits one. */
export function heAacConfiguration(r: {
	name?: string;
	key: string;
	bitrate: number;
	rate?: number;
	channelLayout?: string;
	signaling?: HeAacSignaling;
}) {
	return {
		name: r.name ?? r.key,
		bitrate: r.bitrate,
		...(r.rate === undefined ? {} : { rate: r.rate }),
		...(r.channelLayout === undefined
			? {}
			: { channelLayout: r.channelLayout }),
		...(r.signaling === undefined ? {} : { signaling: r.signaling }),
	};
}
