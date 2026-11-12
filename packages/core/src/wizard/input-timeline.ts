import { vodInputTimelineDocumentSchema } from "../vod-input-timeline/contracts";
import type {
	WizardConcatenationStream,
	WizardIngestTrack,
	WizardState,
	WizardTrimmingStream,
} from "./build-plan";

export class WizardInputTimelineError extends Error {
	constructor(
		public readonly code:
			| "TIMELINE_EMPTY"
			| "TIMELINE_INVALID"
			| "TIMELINE_SOURCE_MISSING"
			| "TIMELINE_GRAPH_CONFLICT",
	) {
		super(code);
		this.name = "WizardInputTimelineError";
	}
}

/** Derive native input-stream graphs once; the UI document remains the only editing truth. */
export function applyVodInputTimeline(state: WizardState): WizardState {
	if (!state.inputTimeline) return state;
	const parsed = vodInputTimelineDocumentSchema.safeParse(state.inputTimeline);
	if (!parsed.success) throw new WizardInputTimelineError("TIMELINE_INVALID");
	const document = parsed.data;
	if (!document.clips.length)
		throw new WizardInputTimelineError("TIMELINE_EMPTY");
	const sources = state.sources ?? {};
	if (
		(sources.encodings?.length ?? 0) > 0 ||
		[...state.videos, ...state.audios].some((row) => row.extras?.encodingKey)
	) {
		throw new WizardInputTimelineError("TIMELINE_GRAPH_CONFLICT");
	}
	const prefix = `vt_${document.id.replaceAll("-", "")}_`;
	const owned = [
		...(sources.tracks ?? []),
		...(sources.trimmingStreams ?? []),
		...(sources.concatenationStreams ?? []),
		...(sources.fileStreams ?? []),
		...(sources.dolbyStreams ?? []),
		...(sources.audioMixStreams ?? []),
	];
	if (owned.some((row) => row.key.startsWith(prefix)))
		throw new WizardInputTimelineError("TIMELINE_GRAPH_CONFLICT");
	const byKey = new Map(state.inputFiles.map((file) => [file.key, file]));
	const usedKeys = [...new Set(document.clips.map((clip) => clip.sourceKey))];
	if (usedKeys.some((key) => !byKey.has(key)))
		throw new WizardInputTimelineError("TIMELINE_SOURCE_MISSING");
	const tracks: WizardIngestTrack[] = [];
	const trims: WizardTrimmingStream[] = [];
	const concats: WizardConcatenationStream[] = [];
	for (const media of document.audioEnabled
		? (["v", "a"] as const)
		: (["v"] as const)) {
		usedKeys.forEach((key, index) => {
			tracks.push({
				key: `${prefix}${media}_src_${index}`,
				inputFile: key,
				selectionMode: media === "v" ? "VIDEO_RELATIVE" : "AUDIO_RELATIVE",
				position: 0,
			});
		});
		document.clips.forEach((clip, index) => {
			trims.push({
				key: `${prefix}${media}_clip_${index}`,
				kind: "TIME_BASED",
				sourceKey: `${prefix}${media}_src_${usedKeys.indexOf(clip.sourceKey)}`,
				offset: clip.inMs / 1000,
				duration: (clip.outMs - clip.inMs) / 1000,
			});
		});
		concats.push({
			key: `${prefix}${media}_sequence`,
			sources: document.clips.map((_, index) => ({
				sourceKey: `${prefix}${media}_clip_${index}`,
				position: index,
				isMain: index === 0,
				aspectMode: "PAD",
			})),
		});
	}
	const withoutAudio = <T extends { muxedAudioKeys?: string[] }>(
		muxing: T | undefined,
	): T | undefined =>
		muxing ? { ...muxing, muxedAudioKeys: undefined } : undefined;
	return {
		...state,
		inputTimeline: undefined,
		sources: {
			...sources,
			tracks: [...(sources.tracks ?? []), ...tracks],
			trimmingStreams: [...(sources.trimmingStreams ?? []), ...trims],
			concatenationStreams: [
				...(sources.concatenationStreams ?? []),
				...concats,
			],
		},
		videos: state.videos.map((video) => ({
			...video,
			extras: { ...video.extras, source: `${prefix}v_sequence` },
			...(!document.audioEnabled
				? {
						muxing: withoutAudio(video.muxing),
						extraMuxings: video.extraMuxings?.map(
							(muxing) => withoutAudio(muxing) ?? muxing,
						),
					}
				: {}),
		})),
		audios: document.audioEnabled
			? state.audios.map((audio) => ({
					...audio,
					extras: { ...audio.extras, source: `${prefix}a_sequence` },
				}))
			: [],
	};
}
