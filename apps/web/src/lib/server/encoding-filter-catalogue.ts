import "server-only";
import type { encodingFilterProtocols } from "@/lib/encoding-filter-catalogue";

import type { EncodingCatalogueReader as Reader } from "./encoding-catalogue-reader";

const allFilters: Reader = {
	list: (api, page) => api.encoding.filters.list(page),
	get: (api, id) => api.encoding.filters.get(id),
	readType: (api, id) => api.encoding.filters.type.get(id),
};

const typedFilters = {
	"audio-mix": {
		list: (api, page) => api.encoding.filters.audioMix.list(page),
		get: (api, id) => api.encoding.filters.audioMix.get(id),
		expectedType: "AUDIO_MIX",
		metadata: (api, id) => api.encoding.filters.audioMix.customdata.get(id),
	},
	"audio-volume": {
		list: (api, page) => api.encoding.filters.audioVolume.list(page),
		get: (api, id) => api.encoding.filters.audioVolume.get(id),
		expectedType: "AUDIO_VOLUME",
		metadata: (api, id) => api.encoding.filters.audioVolume.customdata.get(id),
	},
	"azure-speech-to-captions": {
		list: (api, page) => api.encoding.filters.azureSpeechToCaptions.list(page),
		get: (api, id) => api.encoding.filters.azureSpeechToCaptions.get(id),
		expectedType: "AZURE_SPEECH_TO_CAPTIONS",
		metadata: (api, id) =>
			api.encoding.filters.azureSpeechToCaptions.customdata.get(id),
	},
	conform: {
		list: (api, page) => api.encoding.filters.conform.list(page),
		get: (api, id) => api.encoding.filters.conform.get(id),
		expectedType: "CONFORM",
		metadata: (api, id) => api.encoding.filters.conform.customdata.get(id),
	},
	crop: {
		list: (api, page) => api.encoding.filters.crop.list(page),
		get: (api, id) => api.encoding.filters.crop.get(id),
		expectedType: "CROP",
		metadata: (api, id) => api.encoding.filters.crop.customdata.get(id),
	},
	deinterlace: {
		list: (api, page) => api.encoding.filters.deinterlace.list(page),
		get: (api, id) => api.encoding.filters.deinterlace.get(id),
		expectedType: "DEINTERLACE",
		metadata: (api, id) => api.encoding.filters.deinterlace.customdata.get(id),
	},
	"denoise-hqdn3d": {
		list: (api, page) => api.encoding.filters.denoiseHqdn3d.list(page),
		get: (api, id) => api.encoding.filters.denoiseHqdn3d.get(id),
		expectedType: "DENOISE_HQDN3D",
		metadata: (api, id) =>
			api.encoding.filters.denoiseHqdn3d.customdata.get(id),
	},
	"dolby-loudness": {
		list: (api, page) => api.encoding.filters.dolbyLoudness.list(page),
		get: (api, id) => api.encoding.filters.dolbyLoudness.get(id),
		expectedType: "DOLBY_LOUDNESS",
		metadata: (api, id) =>
			api.encoding.filters.dolbyLoudness.customdata.get(id),
	},
	"ebu-r128-single-pass": {
		list: (api, page) => api.encoding.filters.ebuR128SinglePass.list(page),
		get: (api, id) => api.encoding.filters.ebuR128SinglePass.get(id),
		expectedType: "EBU_R128_SINGLE_PASS",
		metadata: (api, id) =>
			api.encoding.filters.ebuR128SinglePass.customdata.get(id),
	},
	"enhanced-deinterlace": {
		list: (api, page) => api.encoding.filters.enhancedDeinterlace.list(page),
		get: (api, id) => api.encoding.filters.enhancedDeinterlace.get(id),
		expectedType: "ENHANCED_DEINTERLACE",
		metadata: (api, id) =>
			api.encoding.filters.enhancedDeinterlace.customdata.get(id),
	},
	"enhanced-watermark": {
		list: (api, page) => api.encoding.filters.enhancedWatermark.list(page),
		get: (api, id) => api.encoding.filters.enhancedWatermark.get(id),
		expectedType: "ENHANCED_WATERMARK",
		metadata: (api, id) =>
			api.encoding.filters.enhancedWatermark.customdata.get(id),
	},
	interlace: {
		list: (api, page) => api.encoding.filters.interlace.list(page),
		get: (api, id) => api.encoding.filters.interlace.get(id),
		expectedType: "INTERLACE",
		metadata: (api, id) => api.encoding.filters.interlace.customdata.get(id),
	},
	rotate: {
		list: (api, page) => api.encoding.filters.rotate.list(page),
		get: (api, id) => api.encoding.filters.rotate.get(id),
		expectedType: "ROTATE",
		metadata: (api, id) => api.encoding.filters.rotate.customdata.get(id),
	},
	scale: {
		list: (api, page) => api.encoding.filters.scale.list(page),
		get: (api, id) => api.encoding.filters.scale.get(id),
		expectedType: "SCALE",
		metadata: (api, id) => api.encoding.filters.scale.customdata.get(id),
	},
	text: {
		list: (api, page) => api.encoding.filters.text.list(page),
		get: (api, id) => api.encoding.filters.text.get(id),
		expectedType: "TEXT",
		metadata: (api, id) => api.encoding.filters.text.customdata.get(id),
	},
	unsharp: {
		list: (api, page) => api.encoding.filters.unsharp.list(page),
		get: (api, id) => api.encoding.filters.unsharp.get(id),
		expectedType: "UNSHARP",
		metadata: (api, id) => api.encoding.filters.unsharp.customdata.get(id),
	},
	watermark: {
		list: (api, page) => api.encoding.filters.watermark.list(page),
		get: (api, id) => api.encoding.filters.watermark.get(id),
		expectedType: "WATERMARK",
		metadata: (api, id) => api.encoding.filters.watermark.customdata.get(id),
	},
} satisfies Record<keyof typeof encodingFilterProtocols, Reader>;

export function encodingFilterReader(protocol?: string): Reader | undefined {
	if (protocol === undefined) return allFilters;
	const filters: Readonly<Record<string, Reader>> = typedFilters;
	if (Object.hasOwn(filters, protocol)) return filters[protocol];
}
