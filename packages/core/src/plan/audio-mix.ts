import { z } from "zod";

export const AUDIO_MIX_CHANNEL_TYPES = [
	"CHANNEL_NUMBER",
	"FRONT_LEFT",
	"FRONT_RIGHT",
	"CENTER",
	"LOW_FREQUENCY",
	"BACK_LEFT",
	"BACK_RIGHT",
	"SURROUND_LEFT",
	"SURROUND_RIGHT",
] as const;
export const AUDIO_MIX_LAYOUTS = [
	"NONE",
	"MONO",
	"STEREO",
	"SURROUND",
	"QUAD",
	"HEXAGONAL",
	"OCTAGONAL",
	"STEREO_DOWNMIX",
	"2.1",
	"2.2",
	"3.1",
	"4.0",
	"4.1",
	"5.0",
	"5.1",
	"5.0_BACK",
	"5.1_BACK",
	"6.0",
	"6.0_FRONT",
	"6.1",
	"6.1_FRONT",
	"6.1_BACK",
	"7.0",
	"7.0_FRONT",
	"7.1",
	"7.1_WIDE",
	"7.1_WIDE_BACK",
] as const;
const refKey = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[a-zA-Z0-9_-]+$/);
const channelType = z.enum(AUDIO_MIX_CHANNEL_TYPES);
export const audioMixChannelSchema = z
	.strictObject({
		sourceKey: refKey,
		outputChannelType: channelType,
		outputChannelNumber: z.number().int().min(0).optional(),
		sourceChannels: z
			.array(
				z
					.strictObject({
						type: channelType,
						channelNumber: z.number().int().min(0).optional(),
						gain: z.number().finite().optional(),
					})
					.superRefine((s, ctx) => {
						if (
							(s.type === "CHANNEL_NUMBER") !==
							(s.channelNumber !== undefined)
						)
							ctx.addIssue({
								code: "custom",
								path: ["channelNumber"],
								message: "Channel number is required only for CHANNEL_NUMBER",
							});
					}),
			)
			.min(1),
	})
	.superRefine((s, ctx) => {
		if (
			(s.outputChannelType === "CHANNEL_NUMBER") !==
			(s.outputChannelNumber !== undefined)
		)
			ctx.addIssue({
				code: "custom",
				path: ["outputChannelNumber"],
				message: "Channel number is required only for CHANNEL_NUMBER",
			});
	});
export const audioMixStreamSchema = z
	.strictObject({
		key: refKey,
		channelLayout: z.enum(AUDIO_MIX_LAYOUTS).optional(),
		audioMixChannels: z.array(audioMixChannelSchema).min(1),
		encodingKey: refKey.optional(),
	})
	.superRefine((mix, ctx) => {
		const named =
			mix.channelLayout === "MONO"
				? ["CENTER"]
				: mix.channelLayout === "STEREO"
					? ["FRONT_LEFT", "FRONT_RIGHT"]
					: undefined;

		const numbered = mix.audioMixChannels
			.flatMap((c) => c.sourceChannels)
			.map((s) => s.type === "CHANNEL_NUMBER");
		if (numbered.some(Boolean) && numbered.some((value) => !value))
			ctx.addIssue({
				code: "custom",
				path: ["audioMixChannels"],
				message:
					"Use source channel names or numbers consistently throughout the mix; do not combine both.",
			});
		const outputs = new Set<string>();
		mix.audioMixChannels.forEach((channel, i) => {
			const target =
				channel.outputChannelType === "CHANNEL_NUMBER"
					? (named?.[channel.outputChannelNumber ?? -1] ??
						`#${channel.outputChannelNumber}`)
					: channel.outputChannelType;
			if (outputs.has(target))
				ctx.addIssue({
					code: "custom",
					path: ["audioMixChannels", i, "outputChannelType"],
					message:
						"Define each output channel only once. Combine source channels within its row.",
				});
			outputs.add(target);

			if (
				named &&
				(channel.outputChannelType === "CHANNEL_NUMBER"
					? (channel.outputChannelNumber ?? 0) >= named.length
					: !named.includes(channel.outputChannelType))
			)
				ctx.addIssue({
					code: "custom",
					path: ["audioMixChannels", i, "outputChannelType"],
					message: `Output channel is outside ${mix.channelLayout} layout`,
				});
		});
	});
export type AudioMixStream = z.infer<typeof audioMixStreamSchema>;
export type AudioMixChannel = AudioMixStream["audioMixChannels"][number];
export function audioMixPreset(
	preset: "swap" | "mono" | "downmix" | "custom",
	sourceKey: string,
	secondSourceKey = sourceKey,
): AudioMixStream["audioMixChannels"] {
	const channel = (
		outputChannelType: AudioMixChannel["outputChannelType"],
		key: string,
		types: AudioMixChannel["sourceChannels"],
	): AudioMixChannel => ({
		outputChannelType,
		sourceKey: key,
		sourceChannels: types,
	});
	if (preset === "mono")
		return [
			channel("FRONT_LEFT", sourceKey, [
				{ type: "CHANNEL_NUMBER", channelNumber: 0 },
			]),
			channel("FRONT_RIGHT", secondSourceKey, [
				{ type: "CHANNEL_NUMBER", channelNumber: 0 },
			]),
		];
	if (preset === "downmix")
		return [
			channel("FRONT_LEFT", sourceKey, [
				{ type: "CHANNEL_NUMBER", channelNumber: 0, gain: 1 },
				{ type: "CHANNEL_NUMBER", channelNumber: 2, gain: Math.SQRT1_2 },
				{ type: "CHANNEL_NUMBER", channelNumber: 4, gain: Math.SQRT1_2 },
			]),
			channel("FRONT_RIGHT", sourceKey, [
				{ type: "CHANNEL_NUMBER", channelNumber: 1, gain: 1 },
				{ type: "CHANNEL_NUMBER", channelNumber: 2, gain: Math.SQRT1_2 },
				{ type: "CHANNEL_NUMBER", channelNumber: 5, gain: Math.SQRT1_2 },
			]),
		];
	return [
		channel("FRONT_LEFT", sourceKey, [
			{ type: preset === "swap" ? "FRONT_RIGHT" : "FRONT_LEFT" },
		]),
		channel("FRONT_RIGHT", sourceKey, [
			{ type: preset === "swap" ? "FRONT_LEFT" : "FRONT_RIGHT" },
		]),
	];
}
