import type { WizardAudioCodec, WizardVideoCodec } from "./build-plan";

/**
 * The codecs a rendition can be given, in the order a select lists them. The ladder
 * step and the format step of the file-output flow both read these, so neither can
 * come to offer a codec the other does not have.
 *
 * HEVCv2 is not in the list: it is offered beside these, in both steps, only to an
 * account that may use it.
 */
export const VIDEO_CODECS: readonly WizardVideoCodec[] = [
	"H264",
	"H265",
	"VP9",
	"AV1",
];

export const AUDIO_CODECS: readonly WizardAudioCodec[] = [
	"AAC",
	"AC3",
	"EAC3",
	"OPUS",
	"DOLBY_ATMOS",
	"DDPLUS",
	"DD",
];
