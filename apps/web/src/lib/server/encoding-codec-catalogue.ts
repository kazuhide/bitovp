import "server-only";
import type BitmovinApi from "@bitmovin/api-sdk";
import type {
	EncodingCodecCatalogueKind,
	encodingCodecProtocols,
} from "@/lib/encoding-codec-catalogue";

type Reader = {
	list: (
		api: BitmovinApi,
		page: { offset: number; limit: number },
	) => Promise<unknown>;
	get: (api: BitmovinApi, id: string) => Promise<unknown>;
};

// Explicit calls let the SDK census resolve each concrete codec operation.
const codecReaders = {
	"video-codecs": {
		av1: {
			list: (api, page) => api.encoding.configurations.video.av1.list(page),
			get: (api, id) => api.encoding.configurations.video.av1.get(id),
		},
		h262: {
			list: (api, page) => api.encoding.configurations.video.h262.list(page),
			get: (api, id) => api.encoding.configurations.video.h262.get(id),
		},
		h264: {
			list: (api, page) => api.encoding.configurations.video.h264.list(page),
			get: (api, id) => api.encoding.configurations.video.h264.get(id),
		},
		h265: {
			list: (api, page) => api.encoding.configurations.video.h265.list(page),
			get: (api, id) => api.encoding.configurations.video.h265.get(id),
		},
		h265v2: {
			list: (api, page) => api.encoding.configurations.video.h265v2.list(page),
			get: (api, id) => api.encoding.configurations.video.h265v2.get(id),
		},
		mjpeg: {
			list: (api, page) => api.encoding.configurations.video.mjpeg.list(page),
			get: (api, id) => api.encoding.configurations.video.mjpeg.get(id),
		},
		vp8: {
			list: (api, page) => api.encoding.configurations.video.vp8.list(page),
			get: (api, id) => api.encoding.configurations.video.vp8.get(id),
		},
		vp9: {
			list: (api, page) => api.encoding.configurations.video.vp9.list(page),
			get: (api, id) => api.encoding.configurations.video.vp9.get(id),
		},
	},
	"audio-codecs": {
		aac: {
			list: (api, page) => api.encoding.configurations.audio.aac.list(page),
			get: (api, id) => api.encoding.configurations.audio.aac.get(id),
		},
		ac3: {
			list: (api, page) => api.encoding.configurations.audio.ac3.list(page),
			get: (api, id) => api.encoding.configurations.audio.ac3.get(id),
		},
		"dolby-atmos": {
			list: (api, page) =>
				api.encoding.configurations.audio.dolbyAtmos.list(page),
			get: (api, id) => api.encoding.configurations.audio.dolbyAtmos.get(id),
		},
		"dolby-digital": {
			list: (api, page) =>
				api.encoding.configurations.audio.dolbyDigital.list(page),
			get: (api, id) => api.encoding.configurations.audio.dolbyDigital.get(id),
		},
		"dolby-digital-plus": {
			list: (api, page) =>
				api.encoding.configurations.audio.dolbyDigitalPlus.list(page),
			get: (api, id) =>
				api.encoding.configurations.audio.dolbyDigitalPlus.get(id),
		},
		dts: {
			list: (api, page) => api.encoding.configurations.audio.dts.list(page),
			get: (api, id) => api.encoding.configurations.audio.dts.get(id),
		},
		"dts-passthrough": {
			list: (api, page) =>
				api.encoding.configurations.audio.dtsPassthrough.list(page),
			get: (api, id) =>
				api.encoding.configurations.audio.dtsPassthrough.get(id),
		},
		dtsx: {
			list: (api, page) => api.encoding.configurations.audio.dtsx.list(page),
			get: (api, id) => api.encoding.configurations.audio.dtsx.get(id),
		},
		eac3: {
			list: (api, page) => api.encoding.configurations.audio.eac3.list(page),
			get: (api, id) => api.encoding.configurations.audio.eac3.get(id),
		},
		"he-aac-v1": {
			list: (api, page) => api.encoding.configurations.audio.heAacV1.list(page),
			get: (api, id) => api.encoding.configurations.audio.heAacV1.get(id),
		},
		"he-aac-v2": {
			list: (api, page) => api.encoding.configurations.audio.heAacV2.list(page),
			get: (api, id) => api.encoding.configurations.audio.heAacV2.get(id),
		},
		mp2: {
			list: (api, page) => api.encoding.configurations.audio.mp2.list(page),
			get: (api, id) => api.encoding.configurations.audio.mp2.get(id),
		},
		mp3: {
			list: (api, page) => api.encoding.configurations.audio.mp3.list(page),
			get: (api, id) => api.encoding.configurations.audio.mp3.get(id),
		},
		opus: {
			list: (api, page) => api.encoding.configurations.audio.opus.list(page),
			get: (api, id) => api.encoding.configurations.audio.opus.get(id),
		},
		passthrough: {
			list: (api, page) =>
				api.encoding.configurations.audio.passthrough.list(page),
			get: (api, id) => api.encoding.configurations.audio.passthrough.get(id),
		},
		pcm: {
			list: (api, page) => api.encoding.configurations.audio.pcm.list(page),
			get: (api, id) => api.encoding.configurations.audio.pcm.get(id),
		},
		vorbis: {
			list: (api, page) => api.encoding.configurations.audio.vorbis.list(page),
			get: (api, id) => api.encoding.configurations.audio.vorbis.get(id),
		},
	},
	"subtitle-codecs": {
		"dvb-subtitle": {
			list: (api, page) =>
				api.encoding.configurations.subtitles.dvbSubtitle.list(page),
			get: (api, id) =>
				api.encoding.configurations.subtitles.dvbSubtitle.get(id),
		},
		imsc: {
			list: (api, page) =>
				api.encoding.configurations.subtitles.imsc.list(page),
			get: (api, id) => api.encoding.configurations.subtitles.imsc.get(id),
		},
		webvtt: {
			list: (api, page) =>
				api.encoding.configurations.subtitles.webvtt.list(page),
			get: (api, id) => api.encoding.configurations.subtitles.webvtt.get(id),
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
	if (!protocol || !Object.hasOwn(codecReaders, kind)) return;
	const catalogue: Readonly<Record<string, Reader>> =
		codecReaders[kind as EncodingCodecCatalogueKind];
	if (Object.hasOwn(catalogue, protocol)) return catalogue[protocol];
}
