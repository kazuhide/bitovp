import {
	type BroadcastTsMuxing,
	type ConvertSccCaption,
	InputStreamType,
	type Mp3Muxing,
	MuxingType,
	type MxfMuxing,
	type PackedAudioMuxing,
	type SegmentedRawMuxing,
	SidecarErrorMode,
	SidecarFileType,
	StreamCaptionOutputFormat,
	type WebVttSidecarFile,
} from "@bitmovin/api-sdk";
import {
	defineChildCollection,
	type ResourceChildren,
} from "../child-collection";

const muxingFields = {
	avgBitrate: "number",
	minBitrate: "number",
	maxBitrate: "number",
} as const;

const sidecarFields = {
	errorMode: Object.values(SidecarErrorMode),
};

export const encodingChildren: ResourceChildren = {
	CREATE_ENCODING: {
		muxings: defineChildCollection({
			label: "Muxings",
			fields: { ...muxingFields, type: Object.values(MuxingType) },
			list: (api, address, page) =>
				api.encoding.encodings.muxings.list(address.id, page),
			get: (api, address, childId) =>
				api.encoding.encodings.muxings.get(address.id, childId),
		}),
		"muxings.broadcastTs": defineChildCollection<BroadcastTsMuxing>({
			label: "Broadcast TS",
			expectedDiscriminator: { field: "type", value: MuxingType.BROADCAST_TS },
			fields: { ...muxingFields, segmentLength: "number" },
			list: (api, address, page) =>
				api.encoding.encodings.muxings.broadcastTs.list(address.id, page),
			get: (api, address, childId) =>
				api.encoding.encodings.muxings.broadcastTs.get(address.id, childId),
		}),
		"muxings.mp3": defineChildCollection<Mp3Muxing>({
			label: "MP3",
			expectedDiscriminator: { field: "type", value: MuxingType.MP3 },
			fields: muxingFields,
			list: (api, address, page) =>
				api.encoding.encodings.muxings.mp3.list(address.id, page),
			get: (api, address, childId) =>
				api.encoding.encodings.muxings.mp3.get(address.id, childId),
		}),
		"muxings.mxf": defineChildCollection<MxfMuxing>({
			label: "MXF",
			expectedDiscriminator: { field: "type", value: MuxingType.MXF },
			fields: muxingFields,
			list: (api, address, page) =>
				api.encoding.encodings.muxings.mxf.list(address.id, page),
			get: (api, address, childId) =>
				api.encoding.encodings.muxings.mxf.get(address.id, childId),
		}),
		"muxings.packedAudio": defineChildCollection<PackedAudioMuxing>({
			label: "Packed Audio",
			expectedDiscriminator: { field: "type", value: MuxingType.PACKED_AUDIO },
			fields: {
				...muxingFields,
				segmentLength: "number",
				startOffset: "number",
				segmentsMuxed: "number",
			},
			list: (api, address, page) =>
				api.encoding.encodings.muxings.packedAudio.list(address.id, page),
			get: (api, address, childId) =>
				api.encoding.encodings.muxings.packedAudio.get(address.id, childId),
		}),
		"muxings.segmentedRaw": defineChildCollection<SegmentedRawMuxing>({
			label: "Segmented RAW",
			expectedDiscriminator: { field: "type", value: MuxingType.SEGMENTED_RAW },
			fields: {
				...muxingFields,
				segmentLength: "number",
				segmentsMuxed: "number",
			},
			list: (api, address, page) =>
				api.encoding.encodings.muxings.segmentedRaw.list(address.id, page),
			get: (api, address, childId) =>
				api.encoding.encodings.muxings.segmentedRaw.get(address.id, childId),
		}),
		inputStreams: defineChildCollection({
			label: "Input Streams",
			fields: { type: Object.values(InputStreamType) },
			list: (api, address, page) =>
				api.encoding.encodings.inputStreams.list(address.id, page),
			get: (api, address, childId) =>
				api.encoding.encodings.inputStreams.get(address.id, childId),
		}),
		sidecars: defineChildCollection({
			label: "Sidecar Files",
			fields: { ...sidecarFields, type: Object.values(SidecarFileType) },
			list: (api, address, page) =>
				api.encoding.encodings.sidecars.list(address.id, page),
			get: (api, address, childId) =>
				api.encoding.encodings.sidecars.get(address.id, childId),
		}),
		"sidecars.webvtt": defineChildCollection<WebVttSidecarFile>({
			label: "WebVTT Sidecars",
			expectedDiscriminator: { field: "type", value: SidecarFileType.WEB_VTT },
			fields: sidecarFields,
			list: (api, address, page) =>
				api.encoding.encodings.sidecars.webvtt.list(address.id, page),
			get: (api, address, childId) =>
				api.encoding.encodings.sidecars.webvtt.get(address.id, childId),
		}),
		"captions.scc": defineChildCollection<ConvertSccCaption>({
			label: "SCC Captions",
			fields: { outputFormat: Object.values(StreamCaptionOutputFormat) },
			list: (api, address, page) =>
				api.encoding.encodings.captions.scc.list(address.id, page),
			get: (api, address, childId) =>
				api.encoding.encodings.captions.scc.get(address.id, childId),
		}),
	},
};
