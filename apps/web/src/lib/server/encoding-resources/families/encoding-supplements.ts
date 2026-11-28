import { defineFamily } from "../family";

export const encodingSupplements = {
	SCC_CONVERSION: defineFamily({
		parents: ["encodingId"],
		fields: [],
		get: (api, { id, parent }) =>
			api.encoding.encodings.captions.scc.get(parent("encodingId"), id),
		remove: (api, { id, parent }) =>
			api.encoding.encodings.captions.scc.delete(parent("encodingId"), id),
	}),
	SIDECAR: defineFamily({
		parents: ["encodingId"],
		fields: [],
		get: (api, { id, parent }) =>
			api.encoding.encodings.sidecars.get(parent("encodingId"), id),
		remove: (api, { id, parent }) =>
			api.encoding.encodings.sidecars.delete(parent("encodingId"), id),
	}),
	WEBVTT_SIDECAR: defineFamily({
		parents: ["encodingId"],
		fields: [],
		get: (api, { id, parent }) =>
			api.encoding.encodings.sidecars.webvtt.get(parent("encodingId"), id),
		remove: (api, { id, parent }) =>
			api.encoding.encodings.sidecars.webvtt.delete(parent("encodingId"), id),
	}),
	SCTE35_TRIGGER: defineFamily({
		parents: ["encodingId"],
		fields: [],
		get: (api, { id, parent }) =>
			api.encoding.encodings.scte35Triggers.get(parent("encodingId"), id),
		remove: (api, { id, parent }) =>
			api.encoding.encodings.scte35Triggers.delete(parent("encodingId"), id),
	}),
	BIF: defineFamily({
		parents: ["encodingId", "streamId"],
		fields: [],
		get: (api, { id, parent }) =>
			api.encoding.encodings.streams.bifs.get(
				parent("encodingId"),
				parent("streamId"),
				id,
			),
		remove: (api, { id, parent }) =>
			api.encoding.encodings.streams.bifs.delete(
				parent("encodingId"),
				parent("streamId"),
				id,
			),
	}),
	BURN_IN_ASSA: defineFamily({
		parents: ["encodingId", "streamId"],
		fields: [],
		get: (api, { id, parent }) =>
			api.encoding.encodings.streams.burnInSubtitles.assa.get(
				parent("encodingId"),
				parent("streamId"),
				id,
			),
		remove: (api, { id, parent }) =>
			api.encoding.encodings.streams.burnInSubtitles.assa.delete(
				parent("encodingId"),
				parent("streamId"),
				id,
			),
	}),
	BURN_IN_DVBSUB: defineFamily({
		parents: ["encodingId", "streamId"],
		fields: [],
		get: (api, { id, parent }) =>
			api.encoding.encodings.streams.burnInSubtitles.dvbsub.get(
				parent("encodingId"),
				parent("streamId"),
				id,
			),
		remove: (api, { id, parent }) =>
			api.encoding.encodings.streams.burnInSubtitles.dvbsub.delete(
				parent("encodingId"),
				parent("streamId"),
				id,
			),
	}),
	CEA_SCC: defineFamily({
		parents: ["encodingId", "streamId"],
		fields: [],
		get: (api, { id, parent }) =>
			api.encoding.encodings.streams.captions.cea.scc.get(
				parent("encodingId"),
				parent("streamId"),
				id,
			),
		remove: (api, { id, parent }) =>
			api.encoding.encodings.streams.captions.cea.scc.delete(
				parent("encodingId"),
				parent("streamId"),
				id,
			),
	}),
	CEA_SRT: defineFamily({
		parents: ["encodingId", "streamId"],
		fields: [],
		get: (api, { id, parent }) =>
			api.encoding.encodings.streams.captions.cea.srt.get(
				parent("encodingId"),
				parent("streamId"),
				id,
			),
		remove: (api, { id, parent }) =>
			api.encoding.encodings.streams.captions.cea.srt.delete(
				parent("encodingId"),
				parent("streamId"),
				id,
			),
	}),
	NEXGUARD: defineFamily({
		parents: ["encodingId", "streamId"],
		fields: [],
		get: (api, { id, parent }) =>
			api.encoding.encodings.streams.watermarking.nexguardFileMarker.get(
				parent("encodingId"),
				parent("streamId"),
				id,
			),
		remove: (api, { id, parent }) =>
			api.encoding.encodings.streams.watermarking.nexguardFileMarker.delete(
				parent("encodingId"),
				parent("streamId"),
				id,
			),
	}),
	KANTAR: defineFamily({
		parents: ["encodingId"],
		fields: [],
		fixedDetailPath: ({ parent }) =>
			`/v1/encoding/encodings/${parent("encodingId")}/kantar-watermark`,
		get: (api, { parent }) =>
			api.encoding.encodings.kantarWatermark.get(parent("encodingId")),
		remove: (api, { parent }) =>
			api.encoding.encodings.kantarWatermark.delete(parent("encodingId")),
	}),
};
