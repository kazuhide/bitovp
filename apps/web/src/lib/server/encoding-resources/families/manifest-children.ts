import type {
	AdaptationSet,
	AdaptationSetType,
	ContentProtection,
	CustomTag,
	DashRepresentation,
	DashRepresentationTypeDiscriminator,
} from "@bitmovin/api-sdk";
import {
	defineChildCollection,
	type ResourceChildren,
} from "../resource-children";

const adaptationSets = defineChildCollection<
	AdaptationSet & { type?: AdaptationSetType }
>({
	label: "Adaptation sets",
	fields: { type: ["AUDIO", "IMAGE", "SUBTITLE", "VIDEO"] },
	list: (api, { id, parent }, page) =>
		api.encoding.manifests.dash.periods.adaptationsets.list(
			parent("manifestId"),
			id,
			page,
		),
});

const representations = defineChildCollection<
	DashRepresentation & {
		typeDiscriminator?: DashRepresentationTypeDiscriminator;
	}
>({
	label: "Representations",
	fields: {
		typeDiscriminator: [
			"CMAF",
			"CHUNKED_TEXT",
			"CONTENT_PROTECTION",
			"DRM_FMP4",
			"DRM_MP4",
			"FMP4",
			"IMSC",
			"MP4",
			"PROGRESSIVE_WEBM",
			"SPRITE",
			"VTT",
			"WEBM",
		],
	},
	list: (api, { id, parent }, page) =>
		api.encoding.manifests.dash.periods.adaptationsets.representations.list(
			parent("manifestId"),
			parent("periodId"),
			id,
			page,
		),
});

const contentProtection = defineChildCollection<ContentProtection>({
	label: "Content protection",
	fields: { typeDiscriminator: ["CONTENT_PROTECTION"] },
	list: (api, { id, parent }, page) =>
		api.encoding.manifests.dash.periods.adaptationsets.representations.cmaf.contentprotection.list(
			parent("manifestId"),
			parent("periodId"),
			parent("adaptationSetId"),
			id,
			page,
		),
	get: (api, { id, parent }, childId) =>
		api.encoding.manifests.dash.periods.adaptationsets.representations.cmaf.contentprotection.get(
			parent("manifestId"),
			parent("periodId"),
			parent("adaptationSetId"),
			id,
			childId,
		),
});

const customTagFields = {
	positionMode: ["KEYFRAME", "SEGMENT", "TIME"],
	segment: "number",
	time: "number",
} as const;

const mediaCustomTags = defineChildCollection<CustomTag>({
	label: "Custom tags",
	fields: customTagFields,
	list: (api, { id, parent }, page) =>
		api.encoding.manifests.hls.media.customTags.list(
			parent("manifestId"),
			id,
			page,
		),
	get: (api, { id, parent }, childId) =>
		api.encoding.manifests.hls.media.customTags.get(
			parent("manifestId"),
			id,
			childId,
		),
});

const streamCustomTags = defineChildCollection<CustomTag>({
	label: "Custom tags",
	fields: customTagFields,
	list: (api, { id, parent }, page) =>
		api.encoding.manifests.hls.streams.customTags.list(
			parent("manifestId"),
			id,
			page,
		),
	get: (api, { id, parent }, childId) =>
		api.encoding.manifests.hls.streams.customTags.get(
			parent("manifestId"),
			id,
			childId,
		),
});

export const manifestChildren: ResourceChildren = {
	CREATE_DASH_PERIOD: { adaptationSets },
	CREATE_DASH_ADAPTATION_SET_AUDIO: { representations },
	CREATE_DASH_ADAPTATION_SET_IMAGE: { representations },
	CREATE_DASH_ADAPTATION_SET_SUBTITLE: { representations },
	CREATE_DASH_ADAPTATION_SET_VIDEO: { representations },
	CREATE_DASH_REPRESENTATION_CMAF: { contentProtection },
	CREATE_HLS_AUDIO_MEDIA: { customTags: mediaCustomTags },
	CREATE_HLS_SUBTITLES_MEDIA: { customTags: mediaCustomTags },
	CREATE_HLS_STREAM_INFO: { customTags: streamCustomTags },
};
