import type { CustomTag } from "@bitmovin/api-sdk";
import { defineFamily } from "../family";

export const hlsCustomTags = {
	MEDIA: defineFamily<CustomTag>({
		parents: ["manifestId", "mediaId"],
		fields: ["id"],
		get: (api, { id, parent }) =>
			api.encoding.manifests.hls.media.customTags.get(
				parent("manifestId"),
				parent("mediaId"),
				id,
			),
		remove: (api, { id, parent }) =>
			api.encoding.manifests.hls.media.customTags.delete(
				parent("manifestId"),
				parent("mediaId"),
				id,
			),
	}),
	STREAM: defineFamily<CustomTag>({
		parents: ["manifestId", "streamInfoId"],
		fields: ["id"],
		get: (api, { id, parent }) =>
			api.encoding.manifests.hls.streams.customTags.get(
				parent("manifestId"),
				parent("streamInfoId"),
				id,
			),
		remove: (api, { id, parent }) =>
			api.encoding.manifests.hls.streams.customTags.delete(
				parent("manifestId"),
				parent("streamInfoId"),
				id,
			),
	}),
};
