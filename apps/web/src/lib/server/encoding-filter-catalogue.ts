import "server-only";
import type BitmovinApi from "@bitmovin/api-sdk";
import type { encodingFilterProtocols } from "@/lib/encoding-filter-catalogue";

type Reader = {
	list: (
		api: BitmovinApi,
		page: { offset: number; limit: number },
	) => Promise<unknown>;
	get: (api: BitmovinApi, id: string) => Promise<unknown>;
};

const allFilters: Reader = {
	list: (api, page) => api.encoding.filters.list(page),
	get: (api, id) => api.encoding.filters.get(id),
};

const typedFilters = {
	"audio-mix": {
		list: (api, page) => api.encoding.filters.audioMix.list(page),
		get: (api, id) => api.encoding.filters.audioMix.get(id),
	},
	"audio-volume": {
		list: (api, page) => api.encoding.filters.audioVolume.list(page),
		get: (api, id) => api.encoding.filters.audioVolume.get(id),
	},
	"azure-speech-to-captions": {
		list: (api, page) => api.encoding.filters.azureSpeechToCaptions.list(page),
		get: (api, id) => api.encoding.filters.azureSpeechToCaptions.get(id),
	},
	conform: {
		list: (api, page) => api.encoding.filters.conform.list(page),
		get: (api, id) => api.encoding.filters.conform.get(id),
	},
	crop: {
		list: (api, page) => api.encoding.filters.crop.list(page),
		get: (api, id) => api.encoding.filters.crop.get(id),
	},
	deinterlace: {
		list: (api, page) => api.encoding.filters.deinterlace.list(page),
		get: (api, id) => api.encoding.filters.deinterlace.get(id),
	},
	"denoise-hqdn3d": {
		list: (api, page) => api.encoding.filters.denoiseHqdn3d.list(page),
		get: (api, id) => api.encoding.filters.denoiseHqdn3d.get(id),
	},
	"dolby-loudness": {
		list: (api, page) => api.encoding.filters.dolbyLoudness.list(page),
		get: (api, id) => api.encoding.filters.dolbyLoudness.get(id),
	},
	"ebu-r128-single-pass": {
		list: (api, page) => api.encoding.filters.ebuR128SinglePass.list(page),
		get: (api, id) => api.encoding.filters.ebuR128SinglePass.get(id),
	},
	"enhanced-deinterlace": {
		list: (api, page) => api.encoding.filters.enhancedDeinterlace.list(page),
		get: (api, id) => api.encoding.filters.enhancedDeinterlace.get(id),
	},
	"enhanced-watermark": {
		list: (api, page) => api.encoding.filters.enhancedWatermark.list(page),
		get: (api, id) => api.encoding.filters.enhancedWatermark.get(id),
	},
	interlace: {
		list: (api, page) => api.encoding.filters.interlace.list(page),
		get: (api, id) => api.encoding.filters.interlace.get(id),
	},
	rotate: {
		list: (api, page) => api.encoding.filters.rotate.list(page),
		get: (api, id) => api.encoding.filters.rotate.get(id),
	},
	scale: {
		list: (api, page) => api.encoding.filters.scale.list(page),
		get: (api, id) => api.encoding.filters.scale.get(id),
	},
	text: {
		list: (api, page) => api.encoding.filters.text.list(page),
		get: (api, id) => api.encoding.filters.text.get(id),
	},
	unsharp: {
		list: (api, page) => api.encoding.filters.unsharp.list(page),
		get: (api, id) => api.encoding.filters.unsharp.get(id),
	},
	watermark: {
		list: (api, page) => api.encoding.filters.watermark.list(page),
		get: (api, id) => api.encoding.filters.watermark.get(id),
	},
} satisfies Record<keyof typeof encodingFilterProtocols, Reader>;

export function encodingFilterReader(protocol?: string): Reader | undefined {
	if (protocol === undefined) return allFilters;
	const filters: Readonly<Record<string, Reader>> = typedFilters;
	if (Object.hasOwn(filters, protocol)) return filters[protocol];
}
