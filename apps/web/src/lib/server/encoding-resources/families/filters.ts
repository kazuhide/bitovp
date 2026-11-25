import type {
	AudioVolumeFilter,
	CropFilter,
	DeinterlaceFilter,
	DenoiseHqdn3dFilter,
	EbuR128SinglePassFilter,
	RotateFilter,
	ScaleFilter,
	TextFilter,
	UnsharpFilter,
	WatermarkFilter,
} from "@bitmovin/api-sdk";
import { defineFamily } from "../family";

export const filters = {
	CREATE_FILTER_AUDIO_VOLUME: defineFamily<AudioVolumeFilter>({
		parents: [],
		fields: [
			"createdAt",
			"format",
			"id",
			"modifiedAt",
			"name",
			"unit",
			"volume",
		],
		get: (api, { id }) => api.encoding.filters.audioVolume.get(id),
		remove: (api, { id }) => api.encoding.filters.audioVolume.delete(id),
	}),
	CREATE_FILTER_CROP: defineFamily<CropFilter>({
		parents: [],
		fields: ["createdAt", "id", "modifiedAt", "name", "unit"],
		get: (api, { id }) => api.encoding.filters.crop.get(id),
		remove: (api, { id }) => api.encoding.filters.crop.delete(id),
	}),
	CREATE_FILTER_DEINTERLACE: defineFamily<DeinterlaceFilter>({
		parents: [],
		fields: ["createdAt", "id", "modifiedAt", "name"],
		get: (api, { id }) => api.encoding.filters.deinterlace.get(id),
		remove: (api, { id }) => api.encoding.filters.deinterlace.delete(id),
	}),
	CREATE_FILTER_DENOISE_HQDN3D: defineFamily<DenoiseHqdn3dFilter>({
		parents: [],
		fields: ["createdAt", "id", "modifiedAt", "name"],
		get: (api, { id }) => api.encoding.filters.denoiseHqdn3d.get(id),
		remove: (api, { id }) => api.encoding.filters.denoiseHqdn3d.delete(id),
	}),
	CREATE_FILTER_EBU_R128_SINGLE_PASS: defineFamily<EbuR128SinglePassFilter>({
		parents: [],
		fields: ["createdAt", "id", "modifiedAt", "name"],
		get: (api, { id }) => api.encoding.filters.ebuR128SinglePass.get(id),
		remove: (api, { id }) => api.encoding.filters.ebuR128SinglePass.delete(id),
	}),
	CREATE_FILTER_ROTATE: defineFamily<RotateFilter>({
		parents: [],
		fields: ["createdAt", "id", "modifiedAt", "name", "rotation"],
		get: (api, { id }) => api.encoding.filters.rotate.get(id),
		remove: (api, { id }) => api.encoding.filters.rotate.delete(id),
	}),
	CREATE_FILTER_SCALE: defineFamily<ScaleFilter>({
		parents: [],
		fields: [
			"createdAt",
			"height",
			"id",
			"modifiedAt",
			"name",
			"scalingAlgorithm",
			"width",
		],
		get: (api, { id }) => api.encoding.filters.scale.get(id),
		remove: (api, { id }) => api.encoding.filters.scale.delete(id),
	}),
	CREATE_FILTER_TEXT: defineFamily<TextFilter>({
		parents: [],
		fields: ["createdAt", "id", "modifiedAt", "name", "x", "y"],
		get: (api, { id }) => api.encoding.filters.text.get(id),
		remove: (api, { id }) => api.encoding.filters.text.delete(id),
	}),
	CREATE_FILTER_UNSHARP: defineFamily<UnsharpFilter>({
		parents: [],
		fields: ["createdAt", "id", "modifiedAt", "name"],
		get: (api, { id }) => api.encoding.filters.unsharp.get(id),
		remove: (api, { id }) => api.encoding.filters.unsharp.delete(id),
	}),
	CREATE_FILTER_WATERMARK: defineFamily<WatermarkFilter>({
		parents: [],
		fields: ["createdAt", "id", "modifiedAt", "name", "unit"],
		get: (api, { id }) => api.encoding.filters.watermark.get(id),
		remove: (api, { id }) => api.encoding.filters.watermark.delete(id),
	}),
};
