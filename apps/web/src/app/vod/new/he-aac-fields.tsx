"use client";
import {
	HE_AAC_MAX_BITRATE,
	HE_AAC_V1_SIGNALING,
	HE_AAC_V2_SIGNALING,
	type HeAacCodec,
	type HeAacSignaling,
	isHeAac,
} from "@bitovp/core";
import { Field } from "@/components/ui/field";
import { SelectNative } from "@/components/ui/input";
import { useT } from "@/lib/i18n/context";

export function audioCodecLabel(codec: string) {
	return codec === "HE_AAC_V1"
		? "HE-AAC v1"
		: codec === "HE_AAC_V2"
			? "HE-AAC v2"
			: codec;
}

/** Only an explicit codec switch adjusts the preceding codec's bitrate or signaling. */
export function audioProfileTransition(
	codec: string,
	audio: { bitrate: number; rate?: number; signaling?: HeAacSignaling },
) {
	if (!isHeAac(codec))
		return { signaling: undefined, rate: audio.rate ?? 48_000 };
	return {
		bitrate: Math.min(audio.bitrate, HE_AAC_MAX_BITRATE[codec]),
		signaling:
			codec === "HE_AAC_V1" && audio.signaling === "EXPLICIT_PS"
				? undefined
				: audio.signaling,
	};
}

export function readAudioRate(codec: string, text: string) {
	if (isHeAac(codec)) return text === "" ? undefined : Number(text);
	return Math.max(0, Math.round(Number(text)));
}

export function HeAacSignalingField({
	id,
	codec,
	value,
	onChange,
}: {
	id: string;
	codec: HeAacCodec;
	value?: HeAacSignaling;
	onChange: (s?: HeAacSignaling) => void;
}) {
	const { t } = useT();
	const options =
		codec === "HE_AAC_V1" ? HE_AAC_V1_SIGNALING : HE_AAC_V2_SIGNALING;
	return (
		<Field label={t("wizard.heAacSignaling")} htmlFor={id}>
			<SelectNative
				id={id}
				value={value ?? ""}
				onChange={(event) =>
					onChange((event.target.value as HeAacSignaling) || undefined)
				}
			>
				<option value="">{t("wizard.default")}</option>
				{options.map((mode) => (
					<option value={mode} key={mode}>
						{mode}
					</option>
				))}
			</SelectNative>
		</Field>
	);
}
