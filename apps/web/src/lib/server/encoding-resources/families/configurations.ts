import type {
	AacAudioConfiguration,
	Ac3AudioConfiguration,
	Av1VideoConfiguration,
	DolbyAtmosAudioConfiguration,
	DolbyDigitalAudioConfiguration,
	DolbyDigitalPlusAudioConfiguration,
	Eac3AudioConfiguration,
	H264VideoConfiguration,
	H265V2VideoConfiguration,
	H265VideoConfiguration,
	ImscConfiguration,
	OpusAudioConfiguration,
	PassthroughAudioConfiguration,
	PcmAudioConfiguration,
	Vp9VideoConfiguration,
	WebVttConfiguration,
} from "@bitmovin/api-sdk";
import { defineFamily } from "../family";

const hevcFields = [
	"bitrate",
	"createdAt",
	"height",
	"modifiedAt",
	"rate",
	"type",
	"width",
] as const;

export const hevcV2 = defineFamily<H265V2VideoConfiguration>({
	parents: [],
	fields: hevcFields,
	get: (api, { id }) => api.encoding.configurations.video.h265v2.get(id),
	remove: (api, { id }) => api.encoding.configurations.video.h265v2.delete(id),
});

export const configurations = {
	CREATE_CODEC_AAC: defineFamily<AacAudioConfiguration>({
		parents: [],
		fields: [
			"bitrate",
			"channelLayout",
			"createdAt",
			"id",
			"modifiedAt",
			"name",
			"rate",
		],
		get: (api, { id }) => api.encoding.configurations.audio.aac.get(id),
		remove: (api, { id }) => api.encoding.configurations.audio.aac.delete(id),
	}),
	CREATE_CODEC_AC3: defineFamily<Ac3AudioConfiguration>({
		parents: [],
		fields: [
			"bitrate",
			"channelLayout",
			"createdAt",
			"id",
			"modifiedAt",
			"name",
			"rate",
		],
		get: (api, { id }) => api.encoding.configurations.audio.ac3.get(id),
		remove: (api, { id }) => api.encoding.configurations.audio.ac3.delete(id),
	}),
	CREATE_CODEC_DOLBY_ATMOS: defineFamily<DolbyAtmosAudioConfiguration>({
		parents: [],
		fields: ["bitrate", "createdAt", "id", "modifiedAt", "name", "rate"],
		get: (api, { id }) => api.encoding.configurations.audio.dolbyAtmos.get(id),
		remove: (api, { id }) =>
			api.encoding.configurations.audio.dolbyAtmos.delete(id),
	}),
	CREATE_CODEC_DD: defineFamily<DolbyDigitalAudioConfiguration>({
		parents: [],
		fields: [
			"bitrate",
			"channelLayout",
			"createdAt",
			"id",
			"modifiedAt",
			"name",
			"rate",
		],
		get: (api, { id }) =>
			api.encoding.configurations.audio.dolbyDigital.get(id),
		remove: (api, { id }) =>
			api.encoding.configurations.audio.dolbyDigital.delete(id),
	}),
	CREATE_CODEC_DDPLUS: defineFamily<DolbyDigitalPlusAudioConfiguration>({
		parents: [],
		fields: [
			"bitrate",
			"channelLayout",
			"createdAt",
			"id",
			"modifiedAt",
			"name",
			"rate",
		],
		get: (api, { id }) =>
			api.encoding.configurations.audio.dolbyDigitalPlus.get(id),
		remove: (api, { id }) =>
			api.encoding.configurations.audio.dolbyDigitalPlus.delete(id),
	}),
	CREATE_CODEC_EAC3: defineFamily<Eac3AudioConfiguration>({
		parents: [],
		fields: [
			"bitrate",
			"channelLayout",
			"createdAt",
			"id",
			"modifiedAt",
			"name",
			"rate",
		],
		get: (api, { id }) => api.encoding.configurations.audio.eac3.get(id),
		remove: (api, { id }) => api.encoding.configurations.audio.eac3.delete(id),
	}),
	CREATE_CODEC_OPUS: defineFamily<OpusAudioConfiguration>({
		parents: [],
		fields: [
			"bitrate",
			"channelLayout",
			"createdAt",
			"id",
			"modifiedAt",
			"name",
			"rate",
		],
		get: (api, { id }) => api.encoding.configurations.audio.opus.get(id),
		remove: (api, { id }) => api.encoding.configurations.audio.opus.delete(id),
	}),
	CREATE_CODEC_PCM: defineFamily<PcmAudioConfiguration>({
		parents: [],
		fields: [
			"bitrate",
			"channelLayout",
			"createdAt",
			"modifiedAt",
			"rate",
			"sampleFormat",
			"type",
		],
		get: (api, { id }) => api.encoding.configurations.audio.pcm.get(id),
		remove: (api, { id }) => api.encoding.configurations.audio.pcm.delete(id),
	}),
	CREATE_CODEC_AUDIO_PASSTHROUGH: defineFamily<PassthroughAudioConfiguration>({
		parents: [],
		fields: ["createdAt", "modifiedAt", "type"],
		get: (api, { id }) => api.encoding.configurations.audio.passthrough.get(id),
		remove: (api, { id }) =>
			api.encoding.configurations.audio.passthrough.delete(id),
	}),
	CREATE_CODEC_IMSC: defineFamily<ImscConfiguration>({
		parents: [],
		fields: ["createdAt", "id", "modifiedAt", "name"],
		get: (api, { id }) => api.encoding.configurations.subtitles.imsc.get(id),
		remove: (api, { id }) =>
			api.encoding.configurations.subtitles.imsc.delete(id),
	}),
	CREATE_CODEC_WEBVTT: defineFamily<WebVttConfiguration>({
		parents: [],
		fields: ["createdAt", "id", "modifiedAt", "name"],
		get: (api, { id }) => api.encoding.configurations.subtitles.webvtt.get(id),
		remove: (api, { id }) =>
			api.encoding.configurations.subtitles.webvtt.delete(id),
	}),
	CREATE_CODEC_AV1: defineFamily<Av1VideoConfiguration>({
		parents: [],
		fields: [
			"bitrate",
			"createdAt",
			"encodingMode",
			"height",
			"id",
			"modifiedAt",
			"name",
			"presetConfiguration",
			"rate",
			"width",
		],
		get: (api, { id }) => api.encoding.configurations.video.av1.get(id),
		remove: (api, { id }) => api.encoding.configurations.video.av1.delete(id),
	}),
	CREATE_CODEC_H264: defineFamily<H264VideoConfiguration>({
		parents: [],
		fields: [
			"bitrate",
			"createdAt",
			"encodingMode",
			"height",
			"id",
			"level",
			"modifiedAt",
			"name",
			"presetConfiguration",
			"profile",
			"rate",
			"width",
		],
		get: (api, { id }) => api.encoding.configurations.video.h264.get(id),
		remove: (api, { id }) => api.encoding.configurations.video.h264.delete(id),
	}),
	CREATE_CODEC_H265: defineFamily<H265VideoConfiguration>({
		parents: [],
		fields: hevcFields,
		get: (api, { id }) => api.encoding.configurations.video.h265.get(id),
		remove: (api, { id }) => api.encoding.configurations.video.h265.delete(id),
	}),
	CREATE_CODEC_VP9: defineFamily<Vp9VideoConfiguration>({
		parents: [],
		fields: [
			"bitrate",
			"createdAt",
			"encodingMode",
			"height",
			"id",
			"modifiedAt",
			"name",
			"presetConfiguration",
			"rate",
			"width",
		],
		get: (api, { id }) => api.encoding.configurations.video.vp9.get(id),
		remove: (api, { id }) => api.encoding.configurations.video.vp9.delete(id),
	}),
};
