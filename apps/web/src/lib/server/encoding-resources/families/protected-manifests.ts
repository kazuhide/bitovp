import type {
	ContentProtection,
	DashFmp4DrmRepresentation,
	DashMp4DrmRepresentation,
	SmoothManifestContentProtection,
} from "@bitmovin/api-sdk";
import { defineFamily, type ResourceFamily } from "../family";

export const protectedManifests: Record<string, ResourceFamily> = {
	FMP4_REP: defineFamily<DashFmp4DrmRepresentation>({
		parents: [
			"manifestId",
			"periodId",
			"adaptationSetId",
			"encodingId",
			"muxingId",
			"drmId",
		],
		fields: ["id", "type", "typeDiscriminator"],
		get: (api, { id, parent }) =>
			api.encoding.manifests.dash.periods.adaptationsets.representations.fmp4.drm.get(
				parent("manifestId"),
				parent("periodId"),
				parent("adaptationSetId"),
				id,
			),
		list: (api, { parent }, page) =>
			api.encoding.manifests.dash.periods.adaptationsets.representations.fmp4.drm.list(
				parent("manifestId"),
				parent("periodId"),
				parent("adaptationSetId"),
				page,
			),
		remove: (api, { id, parent }) =>
			api.encoding.manifests.dash.periods.adaptationsets.representations.fmp4.drm.delete(
				parent("manifestId"),
				parent("periodId"),
				parent("adaptationSetId"),
				id,
			),
	}),
	MP4_REP: defineFamily<DashMp4DrmRepresentation>({
		parents: [
			"manifestId",
			"periodId",
			"adaptationSetId",
			"encodingId",
			"muxingId",
			"drmId",
		],
		fields: ["id", "type", "typeDiscriminator"],
		get: (api, { id, parent }) =>
			api.encoding.manifests.dash.periods.adaptationsets.representations.mp4.drm.get(
				parent("manifestId"),
				parent("periodId"),
				parent("adaptationSetId"),
				id,
			),
		list: (api, { parent }, page) =>
			api.encoding.manifests.dash.periods.adaptationsets.representations.mp4.drm.list(
				parent("manifestId"),
				parent("periodId"),
				parent("adaptationSetId"),
				page,
			),
		remove: (api, { id, parent }) =>
			api.encoding.manifests.dash.periods.adaptationsets.representations.mp4.drm.delete(
				parent("manifestId"),
				parent("periodId"),
				parent("adaptationSetId"),
				id,
			),
	}),
	ADAPTATION_SET: defineFamily<ContentProtection>({
		parents: [
			"manifestId",
			"periodId",
			"adaptationSetId",
			"encodingId",
			"muxingId",
			"drmId",
		],
		fields: ["id", "typeDiscriminator"],
		get: (api, { id, parent }) =>
			api.encoding.manifests.dash.periods.adaptationsets.contentprotection.get(
				parent("manifestId"),
				parent("periodId"),
				parent("adaptationSetId"),
				id,
			),
		list: (api, { parent }, page) =>
			api.encoding.manifests.dash.periods.adaptationsets.contentprotection.list(
				parent("manifestId"),
				parent("periodId"),
				parent("adaptationSetId"),
				page,
			),
		remove: (api, { id, parent }) =>
			api.encoding.manifests.dash.periods.adaptationsets.contentprotection.delete(
				parent("manifestId"),
				parent("periodId"),
				parent("adaptationSetId"),
				id,
			),
	}),
	FMP4: defineFamily<ContentProtection>({
		parents: [
			"manifestId",
			"periodId",
			"adaptationSetId",
			"encodingId",
			"muxingId",
			"drmId",
			"representationId",
		],
		fields: ["id", "typeDiscriminator"],
		get: (api, { id, parent }) =>
			api.encoding.manifests.dash.periods.adaptationsets.representations.fmp4.contentprotection.get(
				parent("manifestId"),
				parent("periodId"),
				parent("adaptationSetId"),
				parent("representationId"),
				id,
			),
		list: (api, { parent }, page) =>
			api.encoding.manifests.dash.periods.adaptationsets.representations.fmp4.contentprotection.list(
				parent("manifestId"),
				parent("periodId"),
				parent("adaptationSetId"),
				parent("representationId"),
				page,
			),
		remove: (api, { id, parent }) =>
			api.encoding.manifests.dash.periods.adaptationsets.representations.fmp4.contentprotection.delete(
				parent("manifestId"),
				parent("periodId"),
				parent("adaptationSetId"),
				parent("representationId"),
				id,
			),
	}),
	FMP4_DRM: defineFamily<ContentProtection>({
		parents: [
			"manifestId",
			"periodId",
			"adaptationSetId",
			"encodingId",
			"muxingId",
			"drmId",
			"representationId",
		],
		fields: ["id", "typeDiscriminator"],
		get: (api, { id, parent }) =>
			api.encoding.manifests.dash.periods.adaptationsets.representations.fmp4.drm.contentprotection.get(
				parent("manifestId"),
				parent("periodId"),
				parent("adaptationSetId"),
				parent("representationId"),
				id,
			),
		list: (api, { parent }, page) =>
			api.encoding.manifests.dash.periods.adaptationsets.representations.fmp4.drm.contentprotection.list(
				parent("manifestId"),
				parent("periodId"),
				parent("adaptationSetId"),
				parent("representationId"),
				page,
			),
		remove: (api, { id, parent }) =>
			api.encoding.manifests.dash.periods.adaptationsets.representations.fmp4.drm.contentprotection.delete(
				parent("manifestId"),
				parent("periodId"),
				parent("adaptationSetId"),
				parent("representationId"),
				id,
			),
	}),
	WEBM: defineFamily<ContentProtection>({
		parents: [
			"manifestId",
			"periodId",
			"adaptationSetId",
			"encodingId",
			"muxingId",
			"drmId",
			"representationId",
		],
		fields: ["id", "typeDiscriminator"],
		get: (api, { id, parent }) =>
			api.encoding.manifests.dash.periods.adaptationsets.representations.webm.contentprotection.get(
				parent("manifestId"),
				parent("periodId"),
				parent("adaptationSetId"),
				parent("representationId"),
				id,
			),
		list: (api, { parent }, page) =>
			api.encoding.manifests.dash.periods.adaptationsets.representations.webm.contentprotection.list(
				parent("manifestId"),
				parent("periodId"),
				parent("adaptationSetId"),
				parent("representationId"),
				page,
			),
		remove: (api, { id, parent }) =>
			api.encoding.manifests.dash.periods.adaptationsets.representations.webm.contentprotection.delete(
				parent("manifestId"),
				parent("periodId"),
				parent("adaptationSetId"),
				parent("representationId"),
				id,
			),
	}),
	SMOOTH: defineFamily<SmoothManifestContentProtection>({
		parents: ["manifestId", "encodingId", "muxingId", "drmId"],
		fields: ["id", "name", "createdAt", "modifiedAt"],
		get: (api, { id, parent }) =>
			api.encoding.manifests.smooth.contentprotection.get(
				parent("manifestId"),
				id,
			),
		list: (api, { parent }, page) =>
			api.encoding.manifests.smooth.contentprotection.list(
				parent("manifestId"),
				page,
			),
		remove: (api, { id, parent }) =>
			api.encoding.manifests.smooth.contentprotection.delete(
				parent("manifestId"),
				id,
			),
	}),
};
