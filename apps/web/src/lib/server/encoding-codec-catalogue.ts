import "server-only";
import type {
	EncodingCodecCatalogueKind,
	encodingCodecProtocols,
} from "@/lib/encoding-codec-catalogue";

import type { EncodingCatalogueReader as Reader } from "./encoding-catalogue-reader";

const allCodecs: Reader = {
	list: (api, page) => api.encoding.configurations.list(page),
	get: (api, id) => api.encoding.configurations.get(id),
};

// Explicit calls let the SDK census resolve each concrete codec operation.
const codecReaders = {
	"video-codecs": {
		av1: {
			list: (api, page) => api.encoding.configurations.video.av1.list(page),
			get: (api, id) => api.encoding.configurations.video.av1.get(id),
			expectedType: "AV1",
			metadata: (api, id) =>
				api.encoding.configurations.video.av1.customdata.get(id),
		},
		h262: {
			list: (api, page) => api.encoding.configurations.video.h262.list(page),
			get: (api, id) => api.encoding.configurations.video.h262.get(id),
			expectedType: "H262",
			metadata: (api, id) =>
				api.encoding.configurations.video.h262.customdata.get(id),
		},
		h264: {
			list: (api, page) => api.encoding.configurations.video.h264.list(page),
			get: (api, id) => api.encoding.configurations.video.h264.get(id),
			expectedType: "H264",
			metadata: (api, id) =>
				api.encoding.configurations.video.h264.customdata.get(id),
		},
		h265: {
			list: (api, page) => api.encoding.configurations.video.h265.list(page),
			get: (api, id) => api.encoding.configurations.video.h265.get(id),
			expectedType: "H265",
			metadata: (api, id) =>
				api.encoding.configurations.video.h265.customdata.get(id),
		},
		h265v2: {
			list: (api, page) => api.encoding.configurations.video.h265v2.list(page),
			get: (api, id) => api.encoding.configurations.video.h265v2.get(id),
		},
		mjpeg: {
			list: (api, page) => api.encoding.configurations.video.mjpeg.list(page),
			get: (api, id) => api.encoding.configurations.video.mjpeg.get(id),
			expectedType: "MJPEG",
			metadata: (api, id) =>
				api.encoding.configurations.video.mjpeg.customdata.get(id),
		},
		vp8: {
			list: (api, page) => api.encoding.configurations.video.vp8.list(page),
			get: (api, id) => api.encoding.configurations.video.vp8.get(id),
			expectedType: "VP8",
			metadata: (api, id) =>
				api.encoding.configurations.video.vp8.customdata.get(id),
		},
		vp9: {
			list: (api, page) => api.encoding.configurations.video.vp9.list(page),
			get: (api, id) => api.encoding.configurations.video.vp9.get(id),
			expectedType: "VP9",
			metadata: (api, id) =>
				api.encoding.configurations.video.vp9.customdata.get(id),
		},
	},
	"audio-codecs": {
		aac: {
			list: (api, page) => api.encoding.configurations.audio.aac.list(page),
			get: (api, id) => api.encoding.configurations.audio.aac.get(id),
			expectedType: "AAC",
			metadata: (api, id) =>
				api.encoding.configurations.audio.aac.customdata.get(id),
		},
		ac3: {
			list: (api, page) => api.encoding.configurations.audio.ac3.list(page),
			get: (api, id) => api.encoding.configurations.audio.ac3.get(id),
			expectedType: "AC3",
			metadata: (api, id) =>
				api.encoding.configurations.audio.ac3.customdata.get(id),
		},
		"dolby-atmos": {
			list: (api, page) =>
				api.encoding.configurations.audio.dolbyAtmos.list(page),
			get: (api, id) => api.encoding.configurations.audio.dolbyAtmos.get(id),
			expectedType: "DOLBY_ATMOS",
			metadata: (api, id) =>
				api.encoding.configurations.audio.dolbyAtmos.customdata.get(id),
		},
		"dolby-digital": {
			list: (api, page) =>
				api.encoding.configurations.audio.dolbyDigital.list(page),
			get: (api, id) => api.encoding.configurations.audio.dolbyDigital.get(id),
			expectedType: "DD",
			metadata: (api, id) =>
				api.encoding.configurations.audio.dolbyDigital.customdata.get(id),
		},
		"dolby-digital-plus": {
			list: (api, page) =>
				api.encoding.configurations.audio.dolbyDigitalPlus.list(page),
			get: (api, id) =>
				api.encoding.configurations.audio.dolbyDigitalPlus.get(id),
			expectedType: "DDPLUS",
			metadata: (api, id) =>
				api.encoding.configurations.audio.dolbyDigitalPlus.customdata.get(id),
		},
		dts: {
			list: (api, page) => api.encoding.configurations.audio.dts.list(page),
			get: (api, id) => api.encoding.configurations.audio.dts.get(id),
			expectedType: "DTS",
			metadata: (api, id) =>
				api.encoding.configurations.audio.dts.customdata.get(id),
		},
		"dts-passthrough": {
			list: (api, page) =>
				api.encoding.configurations.audio.dtsPassthrough.list(page),
			get: (api, id) =>
				api.encoding.configurations.audio.dtsPassthrough.get(id),
			expectedType: "DTS_PASSTHROUGH",
			metadata: (api, id) =>
				api.encoding.configurations.audio.dtsPassthrough.customdata.get(id),
		},
		dtsx: {
			list: (api, page) => api.encoding.configurations.audio.dtsx.list(page),
			get: (api, id) => api.encoding.configurations.audio.dtsx.get(id),
			expectedType: "DTSX",
			metadata: (api, id) =>
				api.encoding.configurations.audio.dtsx.customdata.get(id),
		},
		eac3: {
			list: (api, page) => api.encoding.configurations.audio.eac3.list(page),
			get: (api, id) => api.encoding.configurations.audio.eac3.get(id),
			expectedType: "EAC3",
			metadata: (api, id) =>
				api.encoding.configurations.audio.eac3.customdata.get(id),
		},
		"he-aac-v1": {
			list: (api, page) => api.encoding.configurations.audio.heAacV1.list(page),
			get: (api, id) => api.encoding.configurations.audio.heAacV1.get(id),
			expectedType: "HE_AAC_V1",
			metadata: (api, id) =>
				api.encoding.configurations.audio.heAacV1.customdata.get(id),
		},
		"he-aac-v2": {
			list: (api, page) => api.encoding.configurations.audio.heAacV2.list(page),
			get: (api, id) => api.encoding.configurations.audio.heAacV2.get(id),
			expectedType: "HE_AAC_V2",
			metadata: (api, id) =>
				api.encoding.configurations.audio.heAacV2.customdata.get(id),
		},
		mp2: {
			list: (api, page) => api.encoding.configurations.audio.mp2.list(page),
			get: (api, id) => api.encoding.configurations.audio.mp2.get(id),
			expectedType: "MP2",
			metadata: (api, id) =>
				api.encoding.configurations.audio.mp2.customdata.get(id),
		},
		mp3: {
			list: (api, page) => api.encoding.configurations.audio.mp3.list(page),
			get: (api, id) => api.encoding.configurations.audio.mp3.get(id),
			expectedType: "MP3",
			metadata: (api, id) =>
				api.encoding.configurations.audio.mp3.customdata.get(id),
		},
		opus: {
			list: (api, page) => api.encoding.configurations.audio.opus.list(page),
			get: (api, id) => api.encoding.configurations.audio.opus.get(id),
			expectedType: "OPUS",
			metadata: (api, id) =>
				api.encoding.configurations.audio.opus.customdata.get(id),
		},
		passthrough: {
			list: (api, page) =>
				api.encoding.configurations.audio.passthrough.list(page),
			get: (api, id) => api.encoding.configurations.audio.passthrough.get(id),
		},
		pcm: {
			list: (api, page) => api.encoding.configurations.audio.pcm.list(page),
			get: (api, id) => api.encoding.configurations.audio.pcm.get(id),
			expectedType: "PCM",
			metadata: (api, id) =>
				api.encoding.configurations.audio.pcm.customdata.get(id),
		},
		vorbis: {
			list: (api, page) => api.encoding.configurations.audio.vorbis.list(page),
			get: (api, id) => api.encoding.configurations.audio.vorbis.get(id),
			expectedType: "VORBIS",
			metadata: (api, id) =>
				api.encoding.configurations.audio.vorbis.customdata.get(id),
		},
	},
	"subtitle-codecs": {
		"dvb-subtitle": {
			list: (api, page) =>
				api.encoding.configurations.subtitles.dvbSubtitle.list(page),
			get: (api, id) =>
				api.encoding.configurations.subtitles.dvbSubtitle.get(id),
			expectedType: "DVB_SUBTITLE",
			metadata: (api, id) =>
				api.encoding.configurations.subtitles.dvbSubtitle.customdata.get(id),
		},
		imsc: {
			list: (api, page) =>
				api.encoding.configurations.subtitles.imsc.list(page),
			get: (api, id) => api.encoding.configurations.subtitles.imsc.get(id),
			expectedType: "IMSC",
			metadata: (api, id) =>
				api.encoding.configurations.subtitles.imsc.customdata.get(id),
		},
		webvtt: {
			list: (api, page) =>
				api.encoding.configurations.subtitles.webvtt.list(page),
			get: (api, id) => api.encoding.configurations.subtitles.webvtt.get(id),
			expectedType: "WEBVTT",
			metadata: (api, id) =>
				api.encoding.configurations.subtitles.webvtt.customdata.get(id),
		},
	},
} satisfies {
	[Kind in EncodingCodecCatalogueKind]: Record<
		keyof (typeof encodingCodecProtocols)[Kind],
		Reader
	>;
};

export function encodingCodecReader(
	kind: string,
	protocol?: string,
): Reader | undefined {
	if (kind === "codecs" && protocol === undefined) return allCodecs;
	if (!protocol || !Object.hasOwn(codecReaders, kind)) return;
	const catalogue: Readonly<Record<string, Reader>> =
		codecReaders[kind as EncodingCodecCatalogueKind];
	if (Object.hasOwn(catalogue, protocol)) return catalogue[protocol];
}
