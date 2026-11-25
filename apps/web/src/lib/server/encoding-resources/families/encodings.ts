import type {
	AudioMixInputStream,
	BurnInSubtitleSrt,
	ChunkedTextMuxing,
	CmafMuxing,
	ConcatenationInputStream,
	DolbyAtmosIngestInputStream,
	DolbyVisionInputStream,
	DolbyVisionMetadata,
	DolbyVisionMetadataIngestInputStream,
	FileInputStream,
	Fmp4Muxing,
	H264PictureTimingTrimmingInputStream,
	IngestInputStream,
	Keyframe,
	Mp4Muxing,
	ProgressiveMovMuxing,
	ProgressiveTsMuxing,
	ProgressiveWebmMuxing,
	Sprite,
	Stream,
	TextMuxing,
	Thumbnail,
	TimeBasedTrimmingInputStream,
	TimecodeTrackTrimmingInputStream,
	TsMuxing,
	WebmMuxing,
} from "@bitmovin/api-sdk";
import { defineFamily } from "../family";

export const encodings = {
	CREATE_AUDIO_MIX_INPUT_STREAM: defineFamily<AudioMixInputStream>({
		parents: ["encodingId"],
		fields: ["createdAt", "id", "modifiedAt", "name"],
		get: (api, { id, parent }) =>
			api.encoding.encodings.inputStreams.audioMix.get(
				parent("encodingId"),
				id,
			),
		list: (api, { parent }, page) =>
			api.encoding.encodings.inputStreams.audioMix.list(
				parent("encodingId"),
				page,
			),
		remove: (api, { id, parent }) =>
			api.encoding.encodings.inputStreams.audioMix.delete(
				parent("encodingId"),
				id,
			),
	}),
	CREATE_CONCATENATION_INPUT_STREAM: defineFamily<ConcatenationInputStream>({
		parents: ["encodingId"],
		fields: ["createdAt", "id", "modifiedAt", "name"],
		get: (api, { id, parent }) =>
			api.encoding.encodings.inputStreams.concatenation.get(
				parent("encodingId"),
				id,
			),
		list: (api, { parent }, page) =>
			api.encoding.encodings.inputStreams.concatenation.list(
				parent("encodingId"),
				page,
			),
		remove: (api, { id, parent }) =>
			api.encoding.encodings.inputStreams.concatenation.delete(
				parent("encodingId"),
				id,
			),
	}),
	CREATE_DOLBY_ATMOS_INPUT_STREAM: defineFamily<DolbyAtmosIngestInputStream>({
		parents: ["encodingId"],
		fields: ["createdAt", "id", "modifiedAt", "name"],
		get: (api, { id, parent }) =>
			api.encoding.encodings.inputStreams.dolbyAtmos.get(
				parent("encodingId"),
				id,
			),
		list: (api, { parent }, page) =>
			api.encoding.encodings.inputStreams.dolbyAtmos.list(
				parent("encodingId"),
				page,
			),
		remove: (api, { id, parent }) =>
			api.encoding.encodings.inputStreams.dolbyAtmos.delete(
				parent("encodingId"),
				id,
			),
	}),
	CREATE_DOLBY_VISION_INPUT_STREAM: defineFamily<DolbyVisionInputStream>({
		parents: ["encodingId"],
		fields: ["createdAt", "id", "modifiedAt", "name"],
		get: (api, { id, parent }) =>
			api.encoding.encodings.inputStreams.dolbyVision.get(
				parent("encodingId"),
				id,
			),
		list: (api, { parent }, page) =>
			api.encoding.encodings.inputStreams.dolbyVision.list(
				parent("encodingId"),
				page,
			),
		remove: (api, { id, parent }) =>
			api.encoding.encodings.inputStreams.dolbyVision.delete(
				parent("encodingId"),
				id,
			),
	}),
	CREATE_FILE_INPUT_STREAM: defineFamily<FileInputStream>({
		parents: ["encodingId"],
		fields: ["createdAt", "id", "modifiedAt", "name"],
		get: (api, { id, parent }) =>
			api.encoding.encodings.inputStreams.file.get(parent("encodingId"), id),
		list: (api, { parent }, page) =>
			api.encoding.encodings.inputStreams.file.list(parent("encodingId"), page),
		remove: (api, { id, parent }) =>
			api.encoding.encodings.inputStreams.file.delete(parent("encodingId"), id),
	}),
	CREATE_INGEST_INPUT_STREAM: defineFamily<IngestInputStream>({
		parents: ["encodingId"],
		fields: [
			"createdAt",
			"id",
			"modifiedAt",
			"name",
			"position",
			"selectionMode",
		],
		get: (api, { id, parent }) =>
			api.encoding.encodings.inputStreams.ingest.get(parent("encodingId"), id),
		list: (api, { parent }, page) =>
			api.encoding.encodings.inputStreams.ingest.list(
				parent("encodingId"),
				page,
			),
		remove: (api, { id, parent }) =>
			api.encoding.encodings.inputStreams.ingest.delete(
				parent("encodingId"),
				id,
			),
	}),
	CREATE_DOLBY_VISION_METADATA_INPUT_STREAM:
		defineFamily<DolbyVisionMetadataIngestInputStream>({
			parents: ["encodingId"],
			fields: ["createdAt", "id", "modifiedAt", "name"],
			get: (api, { id, parent }) =>
				api.encoding.encodings.inputStreams.sidecar.dolbyVisionMetadataIngest.get(
					parent("encodingId"),
					id,
				),
			list: (api, { parent }, page) =>
				api.encoding.encodings.inputStreams.sidecar.dolbyVisionMetadataIngest.list(
					parent("encodingId"),
					page,
				),
			remove: (api, { id, parent }) =>
				api.encoding.encodings.inputStreams.sidecar.dolbyVisionMetadataIngest.delete(
					parent("encodingId"),
					id,
				),
		}),
	CREATE_TRIMMING_H264_PICTURE_TIMING:
		defineFamily<H264PictureTimingTrimmingInputStream>({
			parents: ["encodingId"],
			fields: ["createdAt", "id", "inputStreamId", "modifiedAt", "name"],
			get: (api, { id, parent }) =>
				api.encoding.encodings.inputStreams.trimming.h264PictureTiming.get(
					parent("encodingId"),
					id,
				),
			list: (api, { parent }, page) =>
				api.encoding.encodings.inputStreams.trimming.h264PictureTiming.list(
					parent("encodingId"),
					page,
				),
			remove: (api, { id, parent }) =>
				api.encoding.encodings.inputStreams.trimming.h264PictureTiming.delete(
					parent("encodingId"),
					id,
				),
		}),
	CREATE_TRIMMING_TIME_BASED: defineFamily<TimeBasedTrimmingInputStream>({
		parents: ["encodingId"],
		fields: ["createdAt", "id", "inputStreamId", "modifiedAt", "name"],
		get: (api, { id, parent }) =>
			api.encoding.encodings.inputStreams.trimming.timeBased.get(
				parent("encodingId"),
				id,
			),
		list: (api, { parent }, page) =>
			api.encoding.encodings.inputStreams.trimming.timeBased.list(
				parent("encodingId"),
				page,
			),
		remove: (api, { id, parent }) =>
			api.encoding.encodings.inputStreams.trimming.timeBased.delete(
				parent("encodingId"),
				id,
			),
	}),
	CREATE_TRIMMING_TIMECODE_TRACK:
		defineFamily<TimecodeTrackTrimmingInputStream>({
			parents: ["encodingId"],
			fields: ["createdAt", "id", "inputStreamId", "modifiedAt", "name"],
			get: (api, { id, parent }) =>
				api.encoding.encodings.inputStreams.trimming.timecodeTrack.get(
					parent("encodingId"),
					id,
				),
			list: (api, { parent }, page) =>
				api.encoding.encodings.inputStreams.trimming.timecodeTrack.list(
					parent("encodingId"),
					page,
				),
			remove: (api, { id, parent }) =>
				api.encoding.encodings.inputStreams.trimming.timecodeTrack.delete(
					parent("encodingId"),
					id,
				),
		}),
	CREATE_KEYFRAME: defineFamily<Keyframe>({
		parents: ["encodingId"],
		fields: ["createdAt", "id", "modifiedAt", "name", "time"],
		get: (api, { id, parent }) =>
			api.encoding.encodings.keyframes.get(parent("encodingId"), id),
		list: (api, { parent }, page) =>
			api.encoding.encodings.keyframes.list(parent("encodingId"), page),
		remove: (api, { id, parent }) =>
			api.encoding.encodings.keyframes.delete(parent("encodingId"), id),
	}),
	CREATE_MUXING_CHUNKED_TEXT: defineFamily<ChunkedTextMuxing>({
		parents: ["encodingId"],
		fields: ["createdAt", "id", "modifiedAt", "name", "segmentLength"],
		get: (api, { id, parent }) =>
			api.encoding.encodings.muxings.chunkedText.get(parent("encodingId"), id),
		list: (api, { parent }, page) =>
			api.encoding.encodings.muxings.chunkedText.list(
				parent("encodingId"),
				page,
			),
		remove: (api, { id, parent }) =>
			api.encoding.encodings.muxings.chunkedText.delete(
				parent("encodingId"),
				id,
			),
	}),
	CREATE_MUXING_CMAF: defineFamily<CmafMuxing>({
		parents: ["encodingId"],
		fields: ["createdAt", "id", "modifiedAt", "name", "segmentLength"],
		get: (api, { id, parent }) =>
			api.encoding.encodings.muxings.cmaf.get(parent("encodingId"), id),
		list: (api, { parent }, page) =>
			api.encoding.encodings.muxings.cmaf.list(parent("encodingId"), page),
		remove: (api, { id, parent }) =>
			api.encoding.encodings.muxings.cmaf.delete(parent("encodingId"), id),
	}),
	CREATE_MUXING_FMP4: defineFamily<Fmp4Muxing>({
		parents: ["encodingId"],
		fields: ["createdAt", "id", "modifiedAt", "name", "segmentLength"],
		get: (api, { id, parent }) =>
			api.encoding.encodings.muxings.fmp4.get(parent("encodingId"), id),
		list: (api, { parent }, page) =>
			api.encoding.encodings.muxings.fmp4.list(parent("encodingId"), page),
		remove: (api, { id, parent }) =>
			api.encoding.encodings.muxings.fmp4.delete(parent("encodingId"), id),
	}),
	CREATE_MUXING_MP4: defineFamily<Mp4Muxing>({
		parents: ["encodingId"],
		fields: ["createdAt", "id", "modifiedAt", "name"],
		get: (api, { id, parent }) =>
			api.encoding.encodings.muxings.mp4.get(parent("encodingId"), id),
		list: (api, { parent }, page) =>
			api.encoding.encodings.muxings.mp4.list(parent("encodingId"), page),
		remove: (api, { id, parent }) =>
			api.encoding.encodings.muxings.mp4.delete(parent("encodingId"), id),
	}),
	CREATE_MUXING_PROGRESSIVE_MOV: defineFamily<ProgressiveMovMuxing>({
		parents: ["encodingId"],
		fields: ["createdAt", "id", "modifiedAt", "name"],
		get: (api, { id, parent }) =>
			api.encoding.encodings.muxings.progressiveMov.get(
				parent("encodingId"),
				id,
			),
		list: (api, { parent }, page) =>
			api.encoding.encodings.muxings.progressiveMov.list(
				parent("encodingId"),
				page,
			),
		remove: (api, { id, parent }) =>
			api.encoding.encodings.muxings.progressiveMov.delete(
				parent("encodingId"),
				id,
			),
	}),
	CREATE_MUXING_PROGRESSIVE_TS: defineFamily<ProgressiveTsMuxing>({
		parents: ["encodingId"],
		fields: ["createdAt", "id", "modifiedAt", "name", "segmentLength"],
		get: (api, { id, parent }) =>
			api.encoding.encodings.muxings.progressiveTs.get(
				parent("encodingId"),
				id,
			),
		list: (api, { parent }, page) =>
			api.encoding.encodings.muxings.progressiveTs.list(
				parent("encodingId"),
				page,
			),
		remove: (api, { id, parent }) =>
			api.encoding.encodings.muxings.progressiveTs.delete(
				parent("encodingId"),
				id,
			),
	}),
	CREATE_MUXING_PROGRESSIVE_WEBM: defineFamily<ProgressiveWebmMuxing>({
		parents: ["encodingId"],
		fields: ["createdAt", "id", "modifiedAt", "name", "segmentLength"],
		get: (api, { id, parent }) =>
			api.encoding.encodings.muxings.progressiveWebm.get(
				parent("encodingId"),
				id,
			),
		list: (api, { parent }, page) =>
			api.encoding.encodings.muxings.progressiveWebm.list(
				parent("encodingId"),
				page,
			),
		remove: (api, { id, parent }) =>
			api.encoding.encodings.muxings.progressiveWebm.delete(
				parent("encodingId"),
				id,
			),
	}),
	CREATE_MUXING_TEXT: defineFamily<TextMuxing>({
		parents: ["encodingId"],
		fields: ["createdAt", "id", "modifiedAt", "name"],
		get: (api, { id, parent }) =>
			api.encoding.encodings.muxings.text.get(parent("encodingId"), id),
		list: (api, { parent }, page) =>
			api.encoding.encodings.muxings.text.list(parent("encodingId"), page),
		remove: (api, { id, parent }) =>
			api.encoding.encodings.muxings.text.delete(parent("encodingId"), id),
	}),
	CREATE_MUXING_TS: defineFamily<TsMuxing>({
		parents: ["encodingId"],
		fields: ["createdAt", "id", "modifiedAt", "name", "segmentLength"],
		get: (api, { id, parent }) =>
			api.encoding.encodings.muxings.ts.get(parent("encodingId"), id),
		list: (api, { parent }, page) =>
			api.encoding.encodings.muxings.ts.list(parent("encodingId"), page),
		remove: (api, { id, parent }) =>
			api.encoding.encodings.muxings.ts.delete(parent("encodingId"), id),
	}),
	CREATE_MUXING_WEBM: defineFamily<WebmMuxing>({
		parents: ["encodingId"],
		fields: ["createdAt", "id", "modifiedAt", "name", "segmentLength"],
		get: (api, { id, parent }) =>
			api.encoding.encodings.muxings.webm.get(parent("encodingId"), id),
		list: (api, { parent }, page) =>
			api.encoding.encodings.muxings.webm.list(parent("encodingId"), page),
		remove: (api, { id, parent }) =>
			api.encoding.encodings.muxings.webm.delete(parent("encodingId"), id),
	}),
	CREATE_BURN_IN_SRT: defineFamily<BurnInSubtitleSrt>({
		parents: ["encodingId", "streamId"],
		fields: ["createdAt", "id", "modifiedAt", "name"],
		get: (api, { id, parent }) =>
			api.encoding.encodings.streams.burnInSubtitles.srt.get(
				parent("encodingId"),
				parent("streamId"),
				id,
			),
		list: (api, { parent }, page) =>
			api.encoding.encodings.streams.burnInSubtitles.srt.list(
				parent("encodingId"),
				parent("streamId"),
				page,
			),
		remove: (api, { id, parent }) =>
			api.encoding.encodings.streams.burnInSubtitles.srt.delete(
				parent("encodingId"),
				parent("streamId"),
				id,
			),
	}),
	CREATE_STREAM: defineFamily<Stream>({
		parents: ["encodingId"],
		fields: ["codecConfigId", "createdAt", "id", "mode", "modifiedAt", "name"],
		get: (api, { id, parent }) =>
			api.encoding.encodings.streams.get(parent("encodingId"), id),
		list: (api, { parent }, page) =>
			api.encoding.encodings.streams.list(parent("encodingId"), page),
		remove: (api, { id, parent }) =>
			api.encoding.encodings.streams.delete(parent("encodingId"), id),
	}),
	CREATE_STREAM_HDR_DOLBY_VISION: defineFamily<DolbyVisionMetadata>({
		parents: ["encodingId", "streamId"],
		fields: [
			"createdAt",
			"id",
			"metadataSource",
			"modifiedAt",
			"name",
			"profile",
		],
		get: (api, { id, parent }) =>
			api.encoding.encodings.streams.hdr.dolbyVision.get(
				parent("encodingId"),
				parent("streamId"),
				id,
			),
		list: (api, { parent }, page) =>
			api.encoding.encodings.streams.hdr.dolbyVision.list(
				parent("encodingId"),
				parent("streamId"),
				page,
			),
		remove: (api, { id, parent }) =>
			api.encoding.encodings.streams.hdr.dolbyVision.delete(
				parent("encodingId"),
				parent("streamId"),
				id,
			),
	}),
	CREATE_SPRITE: defineFamily<Sprite>({
		parents: ["encodingId", "streamId"],
		fields: ["createdAt", "height", "id", "modifiedAt", "name", "width"],
		get: (api, { id, parent }) =>
			api.encoding.encodings.streams.sprites.get(
				parent("encodingId"),
				parent("streamId"),
				id,
			),
		list: (api, { parent }, page) =>
			api.encoding.encodings.streams.sprites.list(
				parent("encodingId"),
				parent("streamId"),
				page,
			),
		remove: (api, { id, parent }) =>
			api.encoding.encodings.streams.sprites.delete(
				parent("encodingId"),
				parent("streamId"),
				id,
			),
	}),
	CREATE_THUMBNAIL: defineFamily<Thumbnail>({
		parents: ["encodingId", "streamId"],
		fields: ["createdAt", "height", "id", "modifiedAt", "name", "width"],
		get: (api, { id, parent }) =>
			api.encoding.encodings.streams.thumbnails.get(
				parent("encodingId"),
				parent("streamId"),
				id,
			),
		list: (api, { parent }, page) =>
			api.encoding.encodings.streams.thumbnails.list(
				parent("encodingId"),
				parent("streamId"),
				page,
			),
		remove: (api, { id, parent }) =>
			api.encoding.encodings.streams.thumbnails.delete(
				parent("encodingId"),
				parent("streamId"),
				id,
			),
	}),
};
