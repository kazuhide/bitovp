import type { SlateDifference } from "@bitovp/core";
import type { MessageKey } from ".";
import type { Translator } from "./context";

const labels = {
	"video stream": "mediaDifference.videoStream",
	"video codec": "mediaDifference.videoCodec",
	resolution: "mediaDifference.resolution",
	"frame rate": "mediaDifference.frameRate",
	"H.264 profile": "mediaDifference.h264Profile",
	"H.264 level": "mediaDifference.h264Level",
	"pixel format": "mediaDifference.pixelFormat",
	"audio streams": "mediaDifference.audioStreams",
	"audio codec": "mediaDifference.audioCodec",
	"audio sample rate": "mediaDifference.audioSampleRate",
	"audio channels": "mediaDifference.audioChannels",
	"video stream position": "mediaDifference.videoPosition",
	container: "mediaDifference.container",
	"media kind": "mediaDifference.kind",
} satisfies Record<SlateDifference["attribute"], MessageKey>;

export function mediaAttributeLabel(t: Translator, attribute: string): string {
	return t(
		Object.hasOwn(labels, attribute)
			? labels[attribute as keyof typeof labels]
			: "mediaDifference.unknown",
	);
}

export function mediaDifferenceText(
	t: Translator,
	d: { attribute: string; reference: string; candidate: string },
): string {
	const value = (v: string) =>
		d.attribute === "video stream" && (v === "present" || v === "absent")
			? t(`mediaDifference.${v}`)
			: v;
	return `${mediaAttributeLabel(t, d.attribute)} ${value(d.reference)} → ${value(d.candidate)}`;
}

export function mediaDifferencesMessage(
	t: Translator,
	differences: readonly SlateDifference[],
	normalizes: boolean,
): string {
	return differences
		.map(
			(d) =>
				`${mediaDifferenceText(t, d)}${!d.blocking && normalizes ? t("mediaDifference.willReencode") : ""}`,
		)
		.join("\n");
}
