import {
	type Bif,
	type BurnInSubtitleAssa,
	type BurnInSubtitleDvbSub,
	CaptionCharacterEncoding,
	Cea608ChannelType,
	type NexGuardFileMarker,
	NexGuardWatermarkingStrength,
	NexGuardWatermarkingType,
	type SccCaption,
	SmpteTimecodeFlavor,
	type SrtToCea608708Caption,
	ThumbnailAspectMode,
} from "@bitmovin/api-sdk";
import {
	defineChildCollection,
	type ResourceChildren,
} from "../child-collection";

export const streamChildren: ResourceChildren = {
	CREATE_STREAM: {
		bif: defineChildCollection<Bif>({
			label: "BIF thumbnails",
			fields: {
				width: "number",
				height: "number",
				distance: "number",
				aspectMode: Object.values(ThumbnailAspectMode),
			},
			list: (api, { id, parent }, page) =>
				api.encoding.encodings.streams.bifs.list(
					parent("encodingId"),
					id,
					page,
				),
			get: (api, { id, parent }, childId) =>
				api.encoding.encodings.streams.bifs.get(
					parent("encodingId"),
					id,
					childId,
				),
		}),
		"burnInSubtitles.assa": defineChildCollection<BurnInSubtitleAssa>({
			label: "Burn-in subtitles (ASSA)",
			fields: { characterEncoding: Object.values(CaptionCharacterEncoding) },
			list: (api, { id, parent }, page) =>
				api.encoding.encodings.streams.burnInSubtitles.assa.list(
					parent("encodingId"),
					id,
					page,
				),
			get: (api, { id, parent }, childId) =>
				api.encoding.encodings.streams.burnInSubtitles.assa.get(
					parent("encodingId"),
					id,
					childId,
				),
		}),
		"burnInSubtitles.dvbsub": defineChildCollection<BurnInSubtitleDvbSub>({
			label: "Burn-in subtitles (DVB-SUB)",
			fields: {},
			list: (api, { id, parent }, page) =>
				api.encoding.encodings.streams.burnInSubtitles.dvbsub.list(
					parent("encodingId"),
					id,
					page,
				),
			get: (api, { id, parent }, childId) =>
				api.encoding.encodings.streams.burnInSubtitles.dvbsub.get(
					parent("encodingId"),
					id,
					childId,
				),
		}),
		"captions.cea.scc": defineChildCollection<SccCaption>({
			label: "CEA-608/708 captions (SCC)",
			fields: { smpteTimecodeFlavor: Object.values(SmpteTimecodeFlavor) },
			list: (api, { id, parent }, page) =>
				api.encoding.encodings.streams.captions.cea.scc.list(
					parent("encodingId"),
					id,
					page,
				),
			get: (api, { id, parent }, childId) =>
				api.encoding.encodings.streams.captions.cea.scc.get(
					parent("encodingId"),
					id,
					childId,
				),
		}),
		"captions.cea.srt": defineChildCollection<SrtToCea608708Caption>({
			label: "CEA-608/708 captions (SRT)",
			fields: {
				ccChannel: Object.values(Cea608ChannelType),
				characterEncoding: Object.values(CaptionCharacterEncoding),
			},
			list: (api, { id, parent }, page) =>
				api.encoding.encodings.streams.captions.cea.srt.list(
					parent("encodingId"),
					id,
					page,
				),
			get: (api, { id, parent }, childId) =>
				api.encoding.encodings.streams.captions.cea.srt.get(
					parent("encodingId"),
					id,
					childId,
				),
		}),
		"watermarking.nexguardFileMarker":
			defineChildCollection<NexGuardFileMarker>({
				label: "NexGuard watermark",
				fields: {
					watermarkType: Object.values(NexGuardWatermarkingType),
					strength: Object.values(NexGuardWatermarkingStrength),
				},
				list: (api, { id, parent }, page) =>
					api.encoding.encodings.streams.watermarking.nexguardFileMarker.list(
						parent("encodingId"),
						id,
						page,
					),
				get: (api, { id, parent }, childId) =>
					api.encoding.encodings.streams.watermarking.nexguardFileMarker.get(
						parent("encodingId"),
						id,
						childId,
					),
			}),
	},
};
