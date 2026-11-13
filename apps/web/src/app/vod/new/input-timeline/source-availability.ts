import {
	MAX_VOD_TIMELINE_CLIPS,
	type VodInputTimelineSourceFacts,
	type VodInputTimelineTrack,
	type VodInputTimelineV2Document,
} from "@bitovp/core/vod-input-timeline";

export type SourceTarget = "both" | VodInputTimelineTrack;
export function availableSourceDuration(
	source: VodInputTimelineSourceFacts,
	target: SourceTarget,
	audioEnabled = true,
): number {
	const tracks: VodInputTimelineTrack[] =
		target === "both"
			? audioEnabled
				? ["video", "audio"]
				: ["video"]
			: [target];
	return Math.min(
		...tracks.map((track) =>
			source[track] ? (source[track].durationMs ?? source.durationMs) : 0,
		),
	);
}
export function canAppendTarget(
	document: VodInputTimelineV2Document,
	target: SourceTarget,
): boolean {
	return (
		(target === "audio" ||
			document.videoClips.length < MAX_VOD_TIMELINE_CLIPS) &&
		(target === "video" || document.audioClips.length < MAX_VOD_TIMELINE_CLIPS)
	);
}
