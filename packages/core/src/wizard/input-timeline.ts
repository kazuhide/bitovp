import {
	MAX_VOD_TIMELINE_GAP_MS,
	type VodInputPreviewTask,
	vodInputTimelineDocumentSchema,
} from "../vod-input-timeline/contracts";
import {
	isVodInputTimelineGapSupported,
	normalizeVodInputTimelineDocument,
	resolveVodInputTimeline,
} from "../vod-input-timeline/model";
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
			| "TIMELINE_GRAPH_CONFLICT"
			| "TIMELINE_VIDEO_MISSING"
			| "TIMELINE_GAP_TOO_LONG",
	) {
		super(code);
		this.name = "WizardInputTimelineError";
	}
}

/** Use one physical shared ingest, without altering the editor's source document. */
export function applyPreparedVodInputTimeline(
	state: WizardState,
	task: VodInputPreviewTask,
): WizardState {
	if (state.sources?.hdr10PlusStreams?.length)
		throw new WizardInputTimelineError("TIMELINE_GRAPH_CONFLICT");
	if (
		!["S3", "GENERIC_S3", "GCS"].includes(state.output.kind) ||
		state.output.kind === "SFTP"
	)
		throw new WizardInputTimelineError("TIMELINE_INVALID");
	const prepared = task.result?.preparation;
	if (
		!state.inputTimeline ||
		task.kind !== "TIMELINE_PREPARE" ||
		task.status !== "SUCCEEDED" ||
		!prepared
	)
		throw new WizardInputTimelineError("TIMELINE_INVALID");
	const normalized = normalizeVodInputTimelineDocument(state.inputTimeline);
	if (normalized.durationMs !== prepared.durationMs)
		throw new WizardInputTimelineError("TIMELINE_INVALID");
	const key = prepared.source.key,
		ingestKey = `${key}_av`;
	return {
		...state,
		inputTimeline: undefined,
		inputTimelinePreparation: {
			taskId: task.id,
			requestHash: task.requestHash,
		},
		inputFiles: [
			{
				key,
				inputKey: key,
				kind: state.output.kind,
				credentialId: prepared.source.credentialId,
				bucket: prepared.source.bucket,
				path: prepared.source.objectKey,
				...(state.output.region ? { region: state.output.region } : {}),
			},
			...state.inputFiles,
		],
		audioInputFile: undefined,
		sources: {
			tracks: [
				{ key: ingestKey, inputFile: key, selectionMode: "AUTO", position: 0 },
			],
		},
		videos: state.videos.map((video) => ({
			...video,
			extras: { ...video.extras, source: ingestKey },
		})),
		audios:
			normalized.audioEnabled && normalized.audioClips.length
				? state.audios.map((audio) => ({
						...audio,
						extras: { ...audio.extras, source: ingestKey },
					}))
				: [],
	};
}

/** Derive the native graph from the same independent program the preview resolves. */
export function applyVodInputTimeline(state: WizardState): WizardState {
	if (!state.inputTimeline) return state;
	// This editor derives a new video sequence and cannot preserve the sidecar's
	// source/frame relationship. Keep the selected HDR10+ source explicit.
	if (state.sources?.hdr10PlusStreams?.length)
		throw new WizardInputTimelineError("TIMELINE_GRAPH_CONFLICT");
	const parsed = vodInputTimelineDocumentSchema.safeParse(state.inputTimeline);
	if (!parsed.success) throw new WizardInputTimelineError("TIMELINE_INVALID");
	const document = normalizeVodInputTimelineDocument(parsed.data);
	const resolved = resolveVodInputTimeline(document);
	if (
		!document.durationMs ||
		(!document.videoClips.length && !resolved.hasAudio)
	)
		throw new WizardInputTimelineError("TIMELINE_EMPTY");
	if (state.videos.length && !document.videoClips.length)
		throw new WizardInputTimelineError("TIMELINE_VIDEO_MISSING");
	const sources = state.sources ?? {};
	if (
		(sources.encodings?.length ?? 0) > 0 ||
		[...state.videos, ...state.audios].some((row) => row.extras?.encodingKey)
	)
		throw new WizardInputTimelineError("TIMELINE_GRAPH_CONFLICT");
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
	const files = new Map(state.inputFiles.map((file) => [file.key, file]));
	const tracks: WizardIngestTrack[] = [];
	const trims: WizardTrimmingStream[] = [];
	const concats: WizardConcatenationStream[] = [];
	for (const [media, segments] of [
		["v", resolved.videoSegments],
		["a", resolved.audioSegments],
	] as const) {
		const real = segments.filter((segment) => segment.kind === "source");
		if (!real.length) continue;
		if (
			segments.some(
				(segment) =>
					segment.kind === "gap" &&
					!isVodInputTimelineGapSupported(segment, document.durationMs),
			)
		)
			throw new WizardInputTimelineError("TIMELINE_GAP_TOO_LONG");
		const usedKeys = [...new Set(real.map((clip) => clip.sourceKey))];
		if (usedKeys.some((key) => !files.has(key)))
			throw new WizardInputTimelineError("TIMELINE_SOURCE_MISSING");
		usedKeys.forEach((key, index) => {
			tracks.push({
				key: `${prefix}${media}_src_${index}`,
				inputFile: key,
				selectionMode: media === "v" ? "VIDEO_RELATIVE" : "AUDIO_RELATIVE",
				position: 0,
			});
		});
		real.forEach((clip, index) => {
			trims.push({
				key: `${prefix}${media}_clip_${index}`,
				kind: "TIME_BASED",
				sourceKey: `${prefix}${media}_src_${usedKeys.indexOf(clip.sourceKey)}`,
				offset: clip.inMs / 1000,
				duration: clip.durationMs / 1000,
			});
		});
		concats.push({
			key: `${prefix}${media}_sequence`,
			sources: real.map((clip, index) => {
				const previous = real[index - 1];
				const gapBefore =
					clip.startMs -
					(previous ? previous.startMs + previous.durationMs : 0);
				const next = real[index + 1];
				const before = previous
					? Math.min(gapBefore, MAX_VOD_TIMELINE_GAP_MS)
					: gapBefore;
				const after = next
					? Math.max(
							0,
							next.startMs -
								clip.startMs -
								clip.durationMs -
								MAX_VOD_TIMELINE_GAP_MS,
						)
					: document.durationMs - clip.startMs - clip.durationMs;
				if (
					before < 0 ||
					after < 0 ||
					before > MAX_VOD_TIMELINE_GAP_MS ||
					after > MAX_VOD_TIMELINE_GAP_MS
				)
					throw new WizardInputTimelineError("TIMELINE_GAP_TOO_LONG");
				return {
					sourceKey: `${prefix}${media}_clip_${index}`,
					position: index,
					isMain: index === 0,
					aspectMode: "PAD" as const,
					...(before > 0
						? {
								paddingBefore: {
									duration: before / 1000,
									unit: "SECONDS" as const,
								},
							}
						: {}),
					...(after > 0
						? {
								paddingAfter: {
									duration: after / 1000,
									unit: "SECONDS" as const,
								},
							}
						: {}),
				};
			}),
		});
	}
	const withoutAudio = <T extends { muxedAudioKeys?: string[] }>(
		muxing: T | undefined,
	): T | undefined =>
		muxing ? { ...muxing, muxedAudioKeys: undefined } : undefined;
	return {
		...state,
		inputTimeline: undefined,
		inputTimelinePreparation: undefined,
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
			...(!resolved.hasAudio
				? {
						muxing: withoutAudio(video.muxing),
						extraMuxings: video.extraMuxings?.map(
							(muxing) => withoutAudio(muxing) ?? muxing,
						),
					}
				: {}),
		})),
		audios: resolved.hasAudio
			? state.audios.map((audio) => ({
					...audio,
					extras: { ...audio.extras, source: `${prefix}a_sequence` },
				}))
			: [],
	};
}
