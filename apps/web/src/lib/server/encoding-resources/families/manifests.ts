import type {
	AudioAdaptationSet,
	AudioMediaInfo,
	ClosedCaptionsMediaInfo,
	CustomXmlElement,
	DashChunkedTextRepresentation,
	DashCmafRepresentation,
	DashFmp4Representation,
	DashImscRepresentation,
	DashManifest,
	DashMp4Representation,
	DashProgressiveWebmRepresentation,
	DashVttRepresentation,
	DashWebmRepresentation,
	HlsManifest,
	IFramePlaylist,
	ImageAdaptationSet,
	Period,
	SmoothStreamingManifest,
	SmoothStreamingRepresentation,
	SpriteRepresentation,
	StreamInfo,
	SubtitleAdaptationSet,
	SubtitlesMediaInfo,
	VideoAdaptationSet,
	VideoMediaInfo,
	VttMediaInfo,
} from "@bitmovin/api-sdk";
import { defineFamily } from "../family";

export const manifests = {
	CREATE_MANIFEST_DASH: defineFamily<DashManifest>({
		parents: [],
		fields: ["createdAt", "id", "manifestName", "modifiedAt", "name", "type"],
		get: (api, { id }) => api.encoding.manifests.dash.get(id),
		remove: (api, { id }) => api.encoding.manifests.dash.delete(id),
	}),
	CREATE_DASH_ADAPTATION_SET_AUDIO: defineFamily<AudioAdaptationSet>({
		parents: ["manifestId", "periodId"],
		fields: ["id", "lang"],
		get: (api, { id, parent }) =>
			api.encoding.manifests.dash.periods.adaptationsets.audio.get(
				parent("manifestId"),
				parent("periodId"),
				id,
			),
		list: (api, { parent }, page) =>
			api.encoding.manifests.dash.periods.adaptationsets.audio.list(
				parent("manifestId"),
				parent("periodId"),
				page,
			),
		remove: (api, { id, parent }) =>
			api.encoding.manifests.dash.periods.adaptationsets.audio.delete(
				parent("manifestId"),
				parent("periodId"),
				id,
			),
	}),
	CREATE_DASH_ADAPTATION_SET_IMAGE: defineFamily<ImageAdaptationSet>({
		parents: ["manifestId", "periodId"],
		fields: ["id"],
		get: (api, { id, parent }) =>
			api.encoding.manifests.dash.periods.adaptationsets.image.get(
				parent("manifestId"),
				parent("periodId"),
				id,
			),
		list: (api, { parent }, page) =>
			api.encoding.manifests.dash.periods.adaptationsets.image.list(
				parent("manifestId"),
				parent("periodId"),
				page,
			),
		remove: (api, { id, parent }) =>
			api.encoding.manifests.dash.periods.adaptationsets.image.delete(
				parent("manifestId"),
				parent("periodId"),
				id,
			),
	}),
	CREATE_DASH_REPRESENTATION_CHUNKED_TEXT:
		defineFamily<DashChunkedTextRepresentation>({
			parents: ["manifestId", "periodId", "adaptationSetId"],
			fields: ["id", "type"],
			get: (api, { id, parent }) =>
				api.encoding.manifests.dash.periods.adaptationsets.representations.chunkedText.get(
					parent("manifestId"),
					parent("periodId"),
					parent("adaptationSetId"),
					id,
				),
			list: (api, { parent }, page) =>
				api.encoding.manifests.dash.periods.adaptationsets.representations.chunkedText.list(
					parent("manifestId"),
					parent("periodId"),
					parent("adaptationSetId"),
					page,
				),
			remove: (api, { id, parent }) =>
				api.encoding.manifests.dash.periods.adaptationsets.representations.chunkedText.delete(
					parent("manifestId"),
					parent("periodId"),
					parent("adaptationSetId"),
					id,
				),
		}),
	CREATE_DASH_REPRESENTATION_CMAF: defineFamily<DashCmafRepresentation>({
		parents: ["manifestId", "periodId", "adaptationSetId"],
		fields: ["id", "type"],
		get: (api, { id, parent }) =>
			api.encoding.manifests.dash.periods.adaptationsets.representations.cmaf.get(
				parent("manifestId"),
				parent("periodId"),
				parent("adaptationSetId"),
				id,
			),
		list: (api, { parent }, page) =>
			api.encoding.manifests.dash.periods.adaptationsets.representations.cmaf.list(
				parent("manifestId"),
				parent("periodId"),
				parent("adaptationSetId"),
				page,
			),
		remove: (api, { id, parent }) =>
			api.encoding.manifests.dash.periods.adaptationsets.representations.cmaf.delete(
				parent("manifestId"),
				parent("periodId"),
				parent("adaptationSetId"),
				id,
			),
	}),
	CREATE_DASH_REPRESENTATION_FMP4: defineFamily<DashFmp4Representation>({
		parents: ["manifestId", "periodId", "adaptationSetId"],
		fields: ["id", "type"],
		get: (api, { id, parent }) =>
			api.encoding.manifests.dash.periods.adaptationsets.representations.fmp4.get(
				parent("manifestId"),
				parent("periodId"),
				parent("adaptationSetId"),
				id,
			),
		list: (api, { parent }, page) =>
			api.encoding.manifests.dash.periods.adaptationsets.representations.fmp4.list(
				parent("manifestId"),
				parent("periodId"),
				parent("adaptationSetId"),
				page,
			),
		remove: (api, { id, parent }) =>
			api.encoding.manifests.dash.periods.adaptationsets.representations.fmp4.delete(
				parent("manifestId"),
				parent("periodId"),
				parent("adaptationSetId"),
				id,
			),
	}),
	CREATE_DASH_REPRESENTATION_IMSC: defineFamily<DashImscRepresentation>({
		parents: ["manifestId", "periodId", "adaptationSetId"],
		fields: ["id"],
		get: (api, { id, parent }) =>
			api.encoding.manifests.dash.periods.adaptationsets.representations.imsc.get(
				parent("manifestId"),
				parent("periodId"),
				parent("adaptationSetId"),
				id,
			),
		list: (api, { parent }, page) =>
			api.encoding.manifests.dash.periods.adaptationsets.representations.imsc.list(
				parent("manifestId"),
				parent("periodId"),
				parent("adaptationSetId"),
				page,
			),
		remove: (api, { id, parent }) =>
			api.encoding.manifests.dash.periods.adaptationsets.representations.imsc.delete(
				parent("manifestId"),
				parent("periodId"),
				parent("adaptationSetId"),
				id,
			),
	}),
	CREATE_DASH_REPRESENTATION_MP4: defineFamily<DashMp4Representation>({
		parents: ["manifestId", "periodId", "adaptationSetId"],
		fields: ["id", "type"],
		get: (api, { id, parent }) =>
			api.encoding.manifests.dash.periods.adaptationsets.representations.mp4.get(
				parent("manifestId"),
				parent("periodId"),
				parent("adaptationSetId"),
				id,
			),
		list: (api, { parent }, page) =>
			api.encoding.manifests.dash.periods.adaptationsets.representations.mp4.list(
				parent("manifestId"),
				parent("periodId"),
				parent("adaptationSetId"),
				page,
			),
		remove: (api, { id, parent }) =>
			api.encoding.manifests.dash.periods.adaptationsets.representations.mp4.delete(
				parent("manifestId"),
				parent("periodId"),
				parent("adaptationSetId"),
				id,
			),
	}),
	CREATE_DASH_REPRESENTATION_PROGRESSIVE_WEBM:
		defineFamily<DashProgressiveWebmRepresentation>({
			parents: ["manifestId", "periodId", "adaptationSetId"],
			fields: ["id"],
			get: (api, { id, parent }) =>
				api.encoding.manifests.dash.periods.adaptationsets.representations.progressiveWebm.get(
					parent("manifestId"),
					parent("periodId"),
					parent("adaptationSetId"),
					id,
				),
			list: (api, { parent }, page) =>
				api.encoding.manifests.dash.periods.adaptationsets.representations.progressiveWebm.list(
					parent("manifestId"),
					parent("periodId"),
					parent("adaptationSetId"),
					page,
				),
			remove: (api, { id, parent }) =>
				api.encoding.manifests.dash.periods.adaptationsets.representations.progressiveWebm.delete(
					parent("manifestId"),
					parent("periodId"),
					parent("adaptationSetId"),
					id,
				),
		}),
	CREATE_DASH_REPRESENTATION_SPRITE: defineFamily<SpriteRepresentation>({
		parents: ["manifestId", "periodId", "adaptationSetId"],
		fields: ["id"],
		get: (api, { id, parent }) =>
			api.encoding.manifests.dash.periods.adaptationsets.representations.sprite.get(
				parent("manifestId"),
				parent("periodId"),
				parent("adaptationSetId"),
				id,
			),
		list: (api, { parent }, page) =>
			api.encoding.manifests.dash.periods.adaptationsets.representations.sprite.list(
				parent("manifestId"),
				parent("periodId"),
				parent("adaptationSetId"),
				page,
			),
		remove: (api, { id, parent }) =>
			api.encoding.manifests.dash.periods.adaptationsets.representations.sprite.delete(
				parent("manifestId"),
				parent("periodId"),
				parent("adaptationSetId"),
				id,
			),
	}),
	CREATE_DASH_REPRESENTATION_VTT: defineFamily<DashVttRepresentation>({
		parents: ["manifestId", "periodId", "adaptationSetId"],
		fields: ["id"],
		get: (api, { id, parent }) =>
			api.encoding.manifests.dash.periods.adaptationsets.representations.vtt.get(
				parent("manifestId"),
				parent("periodId"),
				parent("adaptationSetId"),
				id,
			),
		list: (api, { parent }, page) =>
			api.encoding.manifests.dash.periods.adaptationsets.representations.vtt.list(
				parent("manifestId"),
				parent("periodId"),
				parent("adaptationSetId"),
				page,
			),
		remove: (api, { id, parent }) =>
			api.encoding.manifests.dash.periods.adaptationsets.representations.vtt.delete(
				parent("manifestId"),
				parent("periodId"),
				parent("adaptationSetId"),
				id,
			),
	}),
	CREATE_DASH_REPRESENTATION_WEBM: defineFamily<DashWebmRepresentation>({
		parents: ["manifestId", "periodId", "adaptationSetId"],
		fields: ["id", "type"],
		get: (api, { id, parent }) =>
			api.encoding.manifests.dash.periods.adaptationsets.representations.webm.get(
				parent("manifestId"),
				parent("periodId"),
				parent("adaptationSetId"),
				id,
			),
		list: (api, { parent }, page) =>
			api.encoding.manifests.dash.periods.adaptationsets.representations.webm.list(
				parent("manifestId"),
				parent("periodId"),
				parent("adaptationSetId"),
				page,
			),
		remove: (api, { id, parent }) =>
			api.encoding.manifests.dash.periods.adaptationsets.representations.webm.delete(
				parent("manifestId"),
				parent("periodId"),
				parent("adaptationSetId"),
				id,
			),
	}),
	CREATE_DASH_ADAPTATION_SET_SUBTITLE: defineFamily<SubtitleAdaptationSet>({
		parents: ["manifestId", "periodId"],
		fields: ["id", "lang"],
		get: (api, { id, parent }) =>
			api.encoding.manifests.dash.periods.adaptationsets.subtitle.get(
				parent("manifestId"),
				parent("periodId"),
				id,
			),
		list: (api, { parent }, page) =>
			api.encoding.manifests.dash.periods.adaptationsets.subtitle.list(
				parent("manifestId"),
				parent("periodId"),
				page,
			),
		remove: (api, { id, parent }) =>
			api.encoding.manifests.dash.periods.adaptationsets.subtitle.delete(
				parent("manifestId"),
				parent("periodId"),
				id,
			),
	}),
	CREATE_DASH_ADAPTATION_SET_VIDEO: defineFamily<VideoAdaptationSet>({
		parents: ["manifestId", "periodId"],
		fields: ["id"],
		get: (api, { id, parent }) =>
			api.encoding.manifests.dash.periods.adaptationsets.video.get(
				parent("manifestId"),
				parent("periodId"),
				id,
			),
		list: (api, { parent }, page) =>
			api.encoding.manifests.dash.periods.adaptationsets.video.list(
				parent("manifestId"),
				parent("periodId"),
				page,
			),
		remove: (api, { id, parent }) =>
			api.encoding.manifests.dash.periods.adaptationsets.video.delete(
				parent("manifestId"),
				parent("periodId"),
				id,
			),
	}),
	CREATE_DASH_PERIOD: defineFamily<Period>({
		parents: ["manifestId"],
		fields: ["duration", "id", "start"],
		get: (api, { id, parent }) =>
			api.encoding.manifests.dash.periods.get(parent("manifestId"), id),
		list: (api, { parent }, page) =>
			api.encoding.manifests.dash.periods.list(parent("manifestId"), page),
		remove: (api, { id, parent }) =>
			api.encoding.manifests.dash.periods.delete(parent("manifestId"), id),
	}),
	CREATE_DASH_PERIOD_XML: defineFamily<CustomXmlElement>({
		parents: ["manifestId", "periodId"],
		fields: ["id"],
		get: (api, { id, parent }) =>
			api.encoding.manifests.dash.periods.customXmlElements.get(
				parent("manifestId"),
				parent("periodId"),
				id,
			),
		list: (api, { parent }, page) =>
			api.encoding.manifests.dash.periods.customXmlElements.list(
				parent("manifestId"),
				parent("periodId"),
				page,
			),
		remove: (api, { id, parent }) =>
			api.encoding.manifests.dash.periods.customXmlElements.delete(
				parent("manifestId"),
				parent("periodId"),
				id,
			),
	}),
	CREATE_MANIFEST_HLS: defineFamily<HlsManifest>({
		parents: [],
		fields: ["createdAt", "id", "manifestName", "modifiedAt", "name", "type"],
		get: (api, { id }) => api.encoding.manifests.hls.get(id),
		remove: (api, { id }) => api.encoding.manifests.hls.delete(id),
	}),
	CREATE_HLS_AUDIO_MEDIA: defineFamily<AudioMediaInfo>({
		parents: ["manifestId"],
		fields: ["id", "language", "name"],
		get: (api, { id, parent }) =>
			api.encoding.manifests.hls.media.audio.get(parent("manifestId"), id),
		list: (api, { parent }, page) =>
			api.encoding.manifests.hls.media.audio.list(parent("manifestId"), page),
		remove: (api, { id, parent }) =>
			api.encoding.manifests.hls.media.audio.delete(parent("manifestId"), id),
	}),
	CREATE_HLS_CLOSED_CAPTIONS_MEDIA: defineFamily<ClosedCaptionsMediaInfo>({
		parents: ["manifestId"],
		fields: ["id", "language", "name"],
		get: (api, { id, parent }) =>
			api.encoding.manifests.hls.media.closedCaptions.get(
				parent("manifestId"),
				id,
			),
		list: (api, { parent }, page) =>
			api.encoding.manifests.hls.media.closedCaptions.list(
				parent("manifestId"),
				page,
			),
		remove: (api, { id, parent }) =>
			api.encoding.manifests.hls.media.closedCaptions.delete(
				parent("manifestId"),
				id,
			),
	}),
	CREATE_HLS_SUBTITLES_MEDIA: defineFamily<SubtitlesMediaInfo>({
		parents: ["manifestId"],
		fields: ["id", "language", "name"],
		get: (api, { id, parent }) =>
			api.encoding.manifests.hls.media.subtitles.get(parent("manifestId"), id),
		list: (api, { parent }, page) =>
			api.encoding.manifests.hls.media.subtitles.list(
				parent("manifestId"),
				page,
			),
		remove: (api, { id, parent }) =>
			api.encoding.manifests.hls.media.subtitles.delete(
				parent("manifestId"),
				id,
			),
	}),
	CREATE_HLS_VIDEO_MEDIA: defineFamily<VideoMediaInfo>({
		parents: ["manifestId"],
		fields: ["id", "language", "name"],
		get: (api, { id, parent }) =>
			api.encoding.manifests.hls.media.video.get(parent("manifestId"), id),
		list: (api, { parent }, page) =>
			api.encoding.manifests.hls.media.video.list(parent("manifestId"), page),
		remove: (api, { id, parent }) =>
			api.encoding.manifests.hls.media.video.delete(parent("manifestId"), id),
	}),
	CREATE_HLS_VTT_MEDIA: defineFamily<VttMediaInfo>({
		parents: ["manifestId"],
		fields: ["id", "language", "name"],
		get: (api, { id, parent }) =>
			api.encoding.manifests.hls.media.vtt.get(parent("manifestId"), id),
		list: (api, { parent }, page) =>
			api.encoding.manifests.hls.media.vtt.list(parent("manifestId"), page),
		remove: (api, { id, parent }) =>
			api.encoding.manifests.hls.media.vtt.delete(parent("manifestId"), id),
	}),
	CREATE_HLS_STREAM_INFO: defineFamily<StreamInfo>({
		parents: ["manifestId"],
		fields: ["createdAt", "id", "modifiedAt", "name"],
		get: (api, { id, parent }) =>
			api.encoding.manifests.hls.streams.get(parent("manifestId"), id),
		list: (api, { parent }, page) =>
			api.encoding.manifests.hls.streams.list(parent("manifestId"), page),
		remove: (api, { id, parent }) =>
			api.encoding.manifests.hls.streams.delete(parent("manifestId"), id),
	}),
	CREATE_HLS_IFRAME_PLAYLIST: defineFamily<IFramePlaylist>({
		parents: ["manifestId", "streamInfoId"],
		fields: ["createdAt", "id", "modifiedAt", "name"],
		get: (api, { id, parent }) =>
			api.encoding.manifests.hls.streams.iframe.get(
				parent("manifestId"),
				parent("streamInfoId"),
				id,
			),
		list: (api, { parent }, page) =>
			api.encoding.manifests.hls.streams.iframe.list(
				parent("manifestId"),
				parent("streamInfoId"),
				page,
			),
		remove: (api, { id, parent }) =>
			api.encoding.manifests.hls.streams.iframe.delete(
				parent("manifestId"),
				parent("streamInfoId"),
				id,
			),
	}),
	CREATE_MANIFEST_SMOOTH: defineFamily<SmoothStreamingManifest>({
		parents: [],
		fields: ["createdAt", "id", "modifiedAt", "name", "type"],
		get: (api, { id }) => api.encoding.manifests.smooth.get(id),
		remove: (api, { id }) => api.encoding.manifests.smooth.delete(id),
	}),
	CREATE_SMOOTH_REPRESENTATION_MP4: defineFamily<SmoothStreamingRepresentation>(
		{
			parents: ["manifestId"],
			fields: ["createdAt", "id", "language", "modifiedAt", "name"],
			get: (api, { id, parent }) =>
				api.encoding.manifests.smooth.representations.mp4.get(
					parent("manifestId"),
					id,
				),
			list: (api, { parent }, page) =>
				api.encoding.manifests.smooth.representations.mp4.list(
					parent("manifestId"),
					page,
				),
			remove: (api, { id, parent }) =>
				api.encoding.manifests.smooth.representations.mp4.delete(
					parent("manifestId"),
					id,
				),
		},
	),
};
