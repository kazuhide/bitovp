import type { CencDrm, FairPlayDrm, SpekeDrm } from "@bitmovin/api-sdk";
import { defineFamily, type ResourceFamily } from "../family";

// Each entry matches a DRM producer supported by the normal worker.
export const authoredDrm: Record<string, ResourceFamily> = {
	"CREATE_DRM_CENC.FMP4": defineFamily<CencDrm>({
		parents: ["encodingId", "muxingId"],
		fields: ["name", "createdAt", "modifiedAt", "encryptionMode", "ivSize"],
		get: (api, { id, parent }) =>
			api.encoding.encodings.muxings.fmp4.drm.cenc.get(
				parent("encodingId"),
				parent("muxingId"),
				id,
			),
		customData: (api, { id, parent }) =>
			api.encoding.encodings.muxings.fmp4.drm.cenc.customdata.get(
				parent("encodingId"),
				parent("muxingId"),
				id,
			),
		remove: (api, { id, parent }) =>
			api.encoding.encodings.muxings.fmp4.drm.cenc.delete(
				parent("encodingId"),
				parent("muxingId"),
				id,
			),
	}),
	"CREATE_DRM_CENC.MP4": defineFamily<CencDrm>({
		parents: ["encodingId", "muxingId"],
		fields: ["name", "createdAt", "modifiedAt", "encryptionMode", "ivSize"],
		get: (api, { id, parent }) =>
			api.encoding.encodings.muxings.mp4.drm.cenc.get(
				parent("encodingId"),
				parent("muxingId"),
				id,
			),
		customData: (api, { id, parent }) =>
			api.encoding.encodings.muxings.mp4.drm.cenc.customdata.get(
				parent("encodingId"),
				parent("muxingId"),
				id,
			),
		remove: (api, { id, parent }) =>
			api.encoding.encodings.muxings.mp4.drm.cenc.delete(
				parent("encodingId"),
				parent("muxingId"),
				id,
			),
	}),
	"CREATE_DRM_CENC.WEBM": defineFamily<CencDrm>({
		parents: ["encodingId", "muxingId"],
		fields: ["name", "createdAt", "modifiedAt", "encryptionMode", "ivSize"],
		get: (api, { id, parent }) =>
			api.encoding.encodings.muxings.webm.drm.cenc.get(
				parent("encodingId"),
				parent("muxingId"),
				id,
			),
		customData: (api, { id, parent }) =>
			api.encoding.encodings.muxings.webm.drm.cenc.customdata.get(
				parent("encodingId"),
				parent("muxingId"),
				id,
			),
		remove: (api, { id, parent }) =>
			api.encoding.encodings.muxings.webm.drm.cenc.delete(
				parent("encodingId"),
				parent("muxingId"),
				id,
			),
	}),
	"CREATE_DRM_FAIRPLAY.FMP4": defineFamily<FairPlayDrm>({
		parents: ["encodingId", "muxingId"],
		fields: ["name", "createdAt", "modifiedAt"],
		get: (api, { id, parent }) =>
			api.encoding.encodings.muxings.fmp4.drm.fairplay.get(
				parent("encodingId"),
				parent("muxingId"),
				id,
			),
		customData: (api, { id, parent }) =>
			api.encoding.encodings.muxings.fmp4.drm.fairplay.customdata.get(
				parent("encodingId"),
				parent("muxingId"),
				id,
			),
		remove: (api, { id, parent }) =>
			api.encoding.encodings.muxings.fmp4.drm.fairplay.delete(
				parent("encodingId"),
				parent("muxingId"),
				id,
			),
	}),
	"CREATE_DRM_FAIRPLAY.TS": defineFamily<FairPlayDrm>({
		parents: ["encodingId", "muxingId"],
		fields: ["name", "createdAt", "modifiedAt"],
		get: (api, { id, parent }) =>
			api.encoding.encodings.muxings.ts.drm.fairplay.get(
				parent("encodingId"),
				parent("muxingId"),
				id,
			),
		customData: (api, { id, parent }) =>
			api.encoding.encodings.muxings.ts.drm.fairplay.customdata.get(
				parent("encodingId"),
				parent("muxingId"),
				id,
			),
		remove: (api, { id, parent }) =>
			api.encoding.encodings.muxings.ts.drm.fairplay.delete(
				parent("encodingId"),
				parent("muxingId"),
				id,
			),
	}),
	"CREATE_DRM_SPEKE.FMP4": defineFamily<SpekeDrm>({
		parents: ["encodingId", "muxingId"],
		fields: ["name", "createdAt", "modifiedAt"],
		get: (api, { id, parent }) =>
			api.encoding.encodings.muxings.fmp4.drm.speke.get(
				parent("encodingId"),
				parent("muxingId"),
				id,
			),
		customData: (api, { id, parent }) =>
			api.encoding.encodings.muxings.fmp4.drm.speke.customdata.get(
				parent("encodingId"),
				parent("muxingId"),
				id,
			),
		remove: (api, { id, parent }) =>
			api.encoding.encodings.muxings.fmp4.drm.speke.delete(
				parent("encodingId"),
				parent("muxingId"),
				id,
			),
	}),
	"CREATE_DRM_SPEKE.MP4": defineFamily<SpekeDrm>({
		parents: ["encodingId", "muxingId"],
		fields: ["name", "createdAt", "modifiedAt"],
		get: (api, { id, parent }) =>
			api.encoding.encodings.muxings.mp4.drm.speke.get(
				parent("encodingId"),
				parent("muxingId"),
				id,
			),
		customData: (api, { id, parent }) =>
			api.encoding.encodings.muxings.mp4.drm.speke.customdata.get(
				parent("encodingId"),
				parent("muxingId"),
				id,
			),
		remove: (api, { id, parent }) =>
			api.encoding.encodings.muxings.mp4.drm.speke.delete(
				parent("encodingId"),
				parent("muxingId"),
				id,
			),
	}),
	"CREATE_DRM_SPEKE.TS": defineFamily<SpekeDrm>({
		parents: ["encodingId", "muxingId"],
		fields: ["name", "createdAt", "modifiedAt"],
		get: (api, { id, parent }) =>
			api.encoding.encodings.muxings.ts.drm.speke.get(
				parent("encodingId"),
				parent("muxingId"),
				id,
			),
		customData: (api, { id, parent }) =>
			api.encoding.encodings.muxings.ts.drm.speke.customdata.get(
				parent("encodingId"),
				parent("muxingId"),
				id,
			),
		remove: (api, { id, parent }) =>
			api.encoding.encodings.muxings.ts.drm.speke.delete(
				parent("encodingId"),
				parent("muxingId"),
				id,
			),
	}),
	"CREATE_DRM_SPEKE.WEBM": defineFamily<SpekeDrm>({
		parents: ["encodingId", "muxingId"],
		fields: ["name", "createdAt", "modifiedAt"],
		get: (api, { id, parent }) =>
			api.encoding.encodings.muxings.webm.drm.speke.get(
				parent("encodingId"),
				parent("muxingId"),
				id,
			),
		customData: (api, { id, parent }) =>
			api.encoding.encodings.muxings.webm.drm.speke.customdata.get(
				parent("encodingId"),
				parent("muxingId"),
				id,
			),
		remove: (api, { id, parent }) =>
			api.encoding.encodings.muxings.webm.drm.speke.delete(
				parent("encodingId"),
				parent("muxingId"),
				id,
			),
	}),
	"CREATE_DRM_SPEKE.PROGRESSIVE_TS": defineFamily<SpekeDrm>({
		parents: ["encodingId", "muxingId"],
		fields: ["name", "createdAt", "modifiedAt"],
		get: (api, { id, parent }) =>
			api.encoding.encodings.muxings.progressiveTs.drm.speke.get(
				parent("encodingId"),
				parent("muxingId"),
				id,
			),
		customData: (api, { id, parent }) =>
			api.encoding.encodings.muxings.progressiveTs.drm.speke.customdata.get(
				parent("encodingId"),
				parent("muxingId"),
				id,
			),
		remove: (api, { id, parent }) =>
			api.encoding.encodings.muxings.progressiveTs.drm.speke.delete(
				parent("encodingId"),
				parent("muxingId"),
				id,
			),
	}),
	"CREATE_DRM_SPEKE.PROGRESSIVE_WEBM": defineFamily<SpekeDrm>({
		parents: ["encodingId", "muxingId"],
		fields: ["name", "createdAt", "modifiedAt"],
		get: (api, { id, parent }) =>
			api.encoding.encodings.muxings.progressiveWebm.drm.speke.get(
				parent("encodingId"),
				parent("muxingId"),
				id,
			),
		customData: (api, { id, parent }) =>
			api.encoding.encodings.muxings.progressiveWebm.drm.speke.customdata.get(
				parent("encodingId"),
				parent("muxingId"),
				id,
			),
		remove: (api, { id, parent }) =>
			api.encoding.encodings.muxings.progressiveWebm.drm.speke.delete(
				parent("encodingId"),
				parent("muxingId"),
				id,
			),
	}),
	"CREATE_DRM_FAIRPLAY.PROGRESSIVE_TS": defineFamily<FairPlayDrm>({
		parents: ["encodingId", "muxingId"],
		fields: ["name", "createdAt", "modifiedAt"],
		get: (api, { id, parent }) =>
			api.encoding.encodings.muxings.progressiveTs.drm.fairplay.get(
				parent("encodingId"),
				parent("muxingId"),
				id,
			),
		customData: (api, { id, parent }) =>
			api.encoding.encodings.muxings.progressiveTs.drm.fairplay.customdata.get(
				parent("encodingId"),
				parent("muxingId"),
				id,
			),
		remove: (api, { id, parent }) =>
			api.encoding.encodings.muxings.progressiveTs.drm.fairplay.delete(
				parent("encodingId"),
				parent("muxingId"),
				id,
			),
	}),
	"CREATE_DRM_CENC.PROGRESSIVE_WEBM": defineFamily<CencDrm>({
		parents: ["encodingId", "muxingId"],
		fields: ["name", "createdAt", "modifiedAt", "encryptionMode", "ivSize"],
		get: (api, { id, parent }) =>
			api.encoding.encodings.muxings.progressiveWebm.drm.cenc.get(
				parent("encodingId"),
				parent("muxingId"),
				id,
			),
		customData: (api, { id, parent }) =>
			api.encoding.encodings.muxings.progressiveWebm.drm.cenc.customdata.get(
				parent("encodingId"),
				parent("muxingId"),
				id,
			),
		remove: (api, { id, parent }) =>
			api.encoding.encodings.muxings.progressiveWebm.drm.cenc.delete(
				parent("encodingId"),
				parent("muxingId"),
				id,
			),
	}),
};
