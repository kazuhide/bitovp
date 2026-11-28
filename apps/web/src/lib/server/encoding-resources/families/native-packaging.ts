import type {
	AesEncryptionDrm,
	BroadcastTsMuxing,
	ClearKeyDrm,
	FrameIdId3Tag,
	MarlinDrm,
	Mp3Muxing,
	MxfMuxing,
	PackedAudioMuxing,
	PlaintextId3Tag,
	PlayReadyDrm,
	PrimeTimeDrm,
	RawId3Tag,
	SegmentedRawMuxing,
	WidevineDrm,
} from "@bitmovin/api-sdk";
import { defineFamily, type ResourceFamily } from "../family";

const parentRefs = ["encodingId", "muxingId"] as const;
const timestamps = ["createdAt", "modifiedAt"] as const;

export const recordedDeliveryMuxings = {
	CREATE_MUXING_BROADCAST_TS: defineFamily<BroadcastTsMuxing>({
		parents: ["encodingId"],
		fields: timestamps,
		expectedDiscriminator: { field: "type", value: "BROADCAST_TS" },
		get: (api, { id, parent }) =>
			api.encoding.encodings.muxings.broadcastTs.get(parent("encodingId"), id),
		customData: (api, { id, parent }) =>
			api.encoding.encodings.muxings.broadcastTs.customdata.get(
				parent("encodingId"),
				id,
			),
		list: (api, { parent }, page) =>
			api.encoding.encodings.muxings.broadcastTs.list(
				parent("encodingId"),
				page,
			),
		remove: (api, { id, parent }) =>
			api.encoding.encodings.muxings.broadcastTs.delete(
				parent("encodingId"),
				id,
			),
	}),
	CREATE_MUXING_MP3: defineFamily<Mp3Muxing>({
		parents: ["encodingId"],
		fields: timestamps,
		expectedDiscriminator: { field: "type", value: "MP3" },
		get: (api, { id, parent }) =>
			api.encoding.encodings.muxings.mp3.get(parent("encodingId"), id),
		customData: (api, { id, parent }) =>
			api.encoding.encodings.muxings.mp3.customdata.get(
				parent("encodingId"),
				id,
			),
		list: (api, { parent }, page) =>
			api.encoding.encodings.muxings.mp3.list(parent("encodingId"), page),
		remove: (api, { id, parent }) =>
			api.encoding.encodings.muxings.mp3.delete(parent("encodingId"), id),
	}),
	CREATE_MUXING_MXF: defineFamily<MxfMuxing>({
		parents: ["encodingId"],
		fields: timestamps,
		expectedDiscriminator: { field: "type", value: "MXF" },
		get: (api, { id, parent }) =>
			api.encoding.encodings.muxings.mxf.get(parent("encodingId"), id),
		customData: (api, { id, parent }) =>
			api.encoding.encodings.muxings.mxf.customdata.get(
				parent("encodingId"),
				id,
			),
		list: (api, { parent }, page) =>
			api.encoding.encodings.muxings.mxf.list(parent("encodingId"), page),
		remove: (api, { id, parent }) =>
			api.encoding.encodings.muxings.mxf.delete(parent("encodingId"), id),
	}),
	CREATE_MUXING_PACKED_AUDIO: defineFamily<PackedAudioMuxing>({
		parents: ["encodingId"],
		fields: timestamps,
		expectedDiscriminator: { field: "type", value: "PACKED_AUDIO" },
		get: (api, { id, parent }) =>
			api.encoding.encodings.muxings.packedAudio.get(parent("encodingId"), id),
		customData: (api, { id, parent }) =>
			api.encoding.encodings.muxings.packedAudio.customdata.get(
				parent("encodingId"),
				id,
			),
		list: (api, { parent }, page) =>
			api.encoding.encodings.muxings.packedAudio.list(
				parent("encodingId"),
				page,
			),
		remove: (api, { id, parent }) =>
			api.encoding.encodings.muxings.packedAudio.delete(
				parent("encodingId"),
				id,
			),
	}),
	CREATE_MUXING_SEGMENTED_RAW: defineFamily<SegmentedRawMuxing>({
		parents: ["encodingId"],
		fields: timestamps,
		expectedDiscriminator: { field: "type", value: "SEGMENTED_RAW" },
		get: (api, { id, parent }) =>
			api.encoding.encodings.muxings.segmentedRaw.get(parent("encodingId"), id),
		customData: (api, { id, parent }) =>
			api.encoding.encodings.muxings.segmentedRaw.customdata.get(
				parent("encodingId"),
				id,
			),
		list: (api, { parent }, page) =>
			api.encoding.encodings.muxings.segmentedRaw.list(
				parent("encodingId"),
				page,
			),
		remove: (api, { id, parent }) =>
			api.encoding.encodings.muxings.segmentedRaw.delete(
				parent("encodingId"),
				id,
			),
	}),
};

export const recordedTypedDrm: Record<string, ResourceFamily> = {
	"FMP4.AES": defineFamily<AesEncryptionDrm>({
		parents: parentRefs,
		fields: timestamps,
		expectedDiscriminator: { field: "type", value: "AES" },
		get: (api, { id, parent }) =>
			api.encoding.encodings.muxings.fmp4.drm.aes.get(
				parent("encodingId"),
				parent("muxingId"),
				id,
			),
		customData: (api, { id, parent }) =>
			api.encoding.encodings.muxings.fmp4.drm.aes.customdata.get(
				parent("encodingId"),
				parent("muxingId"),
				id,
			),
		remove: (api, { id, parent }) =>
			api.encoding.encodings.muxings.fmp4.drm.aes.delete(
				parent("encodingId"),
				parent("muxingId"),
				id,
			),
	}),
	"TS.AES": defineFamily<AesEncryptionDrm>({
		parents: parentRefs,
		fields: timestamps,
		expectedDiscriminator: { field: "type", value: "AES" },
		get: (api, { id, parent }) =>
			api.encoding.encodings.muxings.ts.drm.aes.get(
				parent("encodingId"),
				parent("muxingId"),
				id,
			),
		customData: (api, { id, parent }) =>
			api.encoding.encodings.muxings.ts.drm.aes.customdata.get(
				parent("encodingId"),
				parent("muxingId"),
				id,
			),
		remove: (api, { id, parent }) =>
			api.encoding.encodings.muxings.ts.drm.aes.delete(
				parent("encodingId"),
				parent("muxingId"),
				id,
			),
	}),
	"PROGRESSIVE_TS.AES": defineFamily<AesEncryptionDrm>({
		parents: parentRefs,
		fields: timestamps,
		expectedDiscriminator: { field: "type", value: "AES" },
		get: (api, { id, parent }) =>
			api.encoding.encodings.muxings.progressiveTs.drm.aes.get(
				parent("encodingId"),
				parent("muxingId"),
				id,
			),
		customData: (api, { id, parent }) =>
			api.encoding.encodings.muxings.progressiveTs.drm.aes.customdata.get(
				parent("encodingId"),
				parent("muxingId"),
				id,
			),
		remove: (api, { id, parent }) =>
			api.encoding.encodings.muxings.progressiveTs.drm.aes.delete(
				parent("encodingId"),
				parent("muxingId"),
				id,
			),
	}),
	"PACKED_AUDIO.AES": defineFamily<AesEncryptionDrm>({
		parents: parentRefs,
		fields: timestamps,
		expectedDiscriminator: { field: "type", value: "AES" },
		get: (api, { id, parent }) =>
			api.encoding.encodings.muxings.packedAudio.drm.aes.get(
				parent("encodingId"),
				parent("muxingId"),
				id,
			),
		customData: (api, { id, parent }) =>
			api.encoding.encodings.muxings.packedAudio.drm.aes.customdata.get(
				parent("encodingId"),
				parent("muxingId"),
				id,
			),
		remove: (api, { id, parent }) =>
			api.encoding.encodings.muxings.packedAudio.drm.aes.delete(
				parent("encodingId"),
				parent("muxingId"),
				id,
			),
	}),
	"FMP4.CLEARKEY": defineFamily<ClearKeyDrm>({
		parents: parentRefs,
		fields: timestamps,
		expectedDiscriminator: { field: "type", value: "CLEARKEY" },
		get: (api, { id, parent }) =>
			api.encoding.encodings.muxings.fmp4.drm.clearkey.get(
				parent("encodingId"),
				parent("muxingId"),
				id,
			),
		customData: (api, { id, parent }) =>
			api.encoding.encodings.muxings.fmp4.drm.clearkey.customdata.get(
				parent("encodingId"),
				parent("muxingId"),
				id,
			),
		remove: (api, { id, parent }) =>
			api.encoding.encodings.muxings.fmp4.drm.clearkey.delete(
				parent("encodingId"),
				parent("muxingId"),
				id,
			),
	}),
	"MP4.CLEARKEY": defineFamily<ClearKeyDrm>({
		parents: parentRefs,
		fields: timestamps,
		expectedDiscriminator: { field: "type", value: "CLEARKEY" },
		get: (api, { id, parent }) =>
			api.encoding.encodings.muxings.mp4.drm.clearkey.get(
				parent("encodingId"),
				parent("muxingId"),
				id,
			),
		customData: (api, { id, parent }) =>
			api.encoding.encodings.muxings.mp4.drm.clearkey.customdata.get(
				parent("encodingId"),
				parent("muxingId"),
				id,
			),
		remove: (api, { id, parent }) =>
			api.encoding.encodings.muxings.mp4.drm.clearkey.delete(
				parent("encodingId"),
				parent("muxingId"),
				id,
			),
	}),
	"FMP4.MARLIN": defineFamily<MarlinDrm>({
		parents: parentRefs,
		fields: timestamps,
		expectedDiscriminator: { field: "type", value: "MARLIN" },
		get: (api, { id, parent }) =>
			api.encoding.encodings.muxings.fmp4.drm.marlin.get(
				parent("encodingId"),
				parent("muxingId"),
				id,
			),
		customData: (api, { id, parent }) =>
			api.encoding.encodings.muxings.fmp4.drm.marlin.customdata.get(
				parent("encodingId"),
				parent("muxingId"),
				id,
			),
		remove: (api, { id, parent }) =>
			api.encoding.encodings.muxings.fmp4.drm.marlin.delete(
				parent("encodingId"),
				parent("muxingId"),
				id,
			),
	}),
	"MP4.MARLIN": defineFamily<MarlinDrm>({
		parents: parentRefs,
		fields: timestamps,
		expectedDiscriminator: { field: "type", value: "MARLIN" },
		get: (api, { id, parent }) =>
			api.encoding.encodings.muxings.mp4.drm.marlin.get(
				parent("encodingId"),
				parent("muxingId"),
				id,
			),
		customData: (api, { id, parent }) =>
			api.encoding.encodings.muxings.mp4.drm.marlin.customdata.get(
				parent("encodingId"),
				parent("muxingId"),
				id,
			),
		remove: (api, { id, parent }) =>
			api.encoding.encodings.muxings.mp4.drm.marlin.delete(
				parent("encodingId"),
				parent("muxingId"),
				id,
			),
	}),
	"FMP4.PLAYREADY": defineFamily<PlayReadyDrm>({
		parents: parentRefs,
		fields: timestamps,
		expectedDiscriminator: { field: "type", value: "PLAYREADY" },
		get: (api, { id, parent }) =>
			api.encoding.encodings.muxings.fmp4.drm.playready.get(
				parent("encodingId"),
				parent("muxingId"),
				id,
			),
		customData: (api, { id, parent }) =>
			api.encoding.encodings.muxings.fmp4.drm.playready.customdata.get(
				parent("encodingId"),
				parent("muxingId"),
				id,
			),
		remove: (api, { id, parent }) =>
			api.encoding.encodings.muxings.fmp4.drm.playready.delete(
				parent("encodingId"),
				parent("muxingId"),
				id,
			),
	}),
	"MP4.PLAYREADY": defineFamily<PlayReadyDrm>({
		parents: parentRefs,
		fields: timestamps,
		expectedDiscriminator: { field: "type", value: "PLAYREADY" },
		get: (api, { id, parent }) =>
			api.encoding.encodings.muxings.mp4.drm.playready.get(
				parent("encodingId"),
				parent("muxingId"),
				id,
			),
		customData: (api, { id, parent }) =>
			api.encoding.encodings.muxings.mp4.drm.playready.customdata.get(
				parent("encodingId"),
				parent("muxingId"),
				id,
			),
		remove: (api, { id, parent }) =>
			api.encoding.encodings.muxings.mp4.drm.playready.delete(
				parent("encodingId"),
				parent("muxingId"),
				id,
			),
	}),
	"FMP4.PRIMETIME": defineFamily<PrimeTimeDrm>({
		parents: parentRefs,
		fields: timestamps,
		expectedDiscriminator: { field: "type", value: "PRIMETIME" },
		get: (api, { id, parent }) =>
			api.encoding.encodings.muxings.fmp4.drm.primetime.get(
				parent("encodingId"),
				parent("muxingId"),
				id,
			),
		customData: (api, { id, parent }) =>
			api.encoding.encodings.muxings.fmp4.drm.primetime.customdata.get(
				parent("encodingId"),
				parent("muxingId"),
				id,
			),
		remove: (api, { id, parent }) =>
			api.encoding.encodings.muxings.fmp4.drm.primetime.delete(
				parent("encodingId"),
				parent("muxingId"),
				id,
			),
	}),
	"FMP4.WIDEVINE": defineFamily<WidevineDrm>({
		parents: parentRefs,
		fields: timestamps,
		expectedDiscriminator: { field: "type", value: "WIDEVINE" },
		get: (api, { id, parent }) =>
			api.encoding.encodings.muxings.fmp4.drm.widevine.get(
				parent("encodingId"),
				parent("muxingId"),
				id,
			),
		customData: (api, { id, parent }) =>
			api.encoding.encodings.muxings.fmp4.drm.widevine.customdata.get(
				parent("encodingId"),
				parent("muxingId"),
				id,
			),
		remove: (api, { id, parent }) =>
			api.encoding.encodings.muxings.fmp4.drm.widevine.delete(
				parent("encodingId"),
				parent("muxingId"),
				id,
			),
	}),
	"MP4.WIDEVINE": defineFamily<WidevineDrm>({
		parents: parentRefs,
		fields: timestamps,
		expectedDiscriminator: { field: "type", value: "WIDEVINE" },
		get: (api, { id, parent }) =>
			api.encoding.encodings.muxings.mp4.drm.widevine.get(
				parent("encodingId"),
				parent("muxingId"),
				id,
			),
		customData: (api, { id, parent }) =>
			api.encoding.encodings.muxings.mp4.drm.widevine.customdata.get(
				parent("encodingId"),
				parent("muxingId"),
				id,
			),
		remove: (api, { id, parent }) =>
			api.encoding.encodings.muxings.mp4.drm.widevine.delete(
				parent("encodingId"),
				parent("muxingId"),
				id,
			),
	}),
};

export const recordedProgressiveTsId3: Record<string, ResourceFamily> = {
	FRAME_ID: defineFamily<FrameIdId3Tag>({
		parents: parentRefs,
		fields: timestamps,
		expectedDiscriminator: { field: "type", value: "FRAME_ID" },
		get: (api, { id, parent }) =>
			api.encoding.encodings.muxings.progressiveTs.id3.frameId.get(
				parent("encodingId"),
				parent("muxingId"),
				id,
			),
		customData: (api, { id, parent }) =>
			api.encoding.encodings.muxings.progressiveTs.id3.frameId.customdata.get(
				parent("encodingId"),
				parent("muxingId"),
				id,
			),
		remove: (api, { id, parent }) =>
			api.encoding.encodings.muxings.progressiveTs.id3.frameId.delete(
				parent("encodingId"),
				parent("muxingId"),
				id,
			),
	}),
	PLAIN_TEXT: defineFamily<PlaintextId3Tag>({
		parents: parentRefs,
		fields: timestamps,
		expectedDiscriminator: { field: "type", value: "PLAIN_TEXT" },
		get: (api, { id, parent }) =>
			api.encoding.encodings.muxings.progressiveTs.id3.plainText.get(
				parent("encodingId"),
				parent("muxingId"),
				id,
			),
		customData: (api, { id, parent }) =>
			api.encoding.encodings.muxings.progressiveTs.id3.plainText.customdata.get(
				parent("encodingId"),
				parent("muxingId"),
				id,
			),
		remove: (api, { id, parent }) =>
			api.encoding.encodings.muxings.progressiveTs.id3.plainText.delete(
				parent("encodingId"),
				parent("muxingId"),
				id,
			),
	}),
	RAW: defineFamily<RawId3Tag>({
		parents: parentRefs,
		fields: timestamps,
		expectedDiscriminator: { field: "type", value: "RAW" },
		get: (api, { id, parent }) =>
			api.encoding.encodings.muxings.progressiveTs.id3.raw.get(
				parent("encodingId"),
				parent("muxingId"),
				id,
			),
		customData: (api, { id, parent }) =>
			api.encoding.encodings.muxings.progressiveTs.id3.raw.customdata.get(
				parent("encodingId"),
				parent("muxingId"),
				id,
			),
		remove: (api, { id, parent }) =>
			api.encoding.encodings.muxings.progressiveTs.id3.raw.delete(
				parent("encodingId"),
				parent("muxingId"),
				id,
			),
	}),
};
