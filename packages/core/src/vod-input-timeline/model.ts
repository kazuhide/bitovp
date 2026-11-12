import {
	type VodInputTimelineDocument,
	type VodInputTimelineSourceFacts,
	vodInputPreviewRangeSchema,
	vodInputTimelineDocumentSchema,
} from "./contracts";

export function getVodInputTimelineDurationMs(
	document: VodInputTimelineDocument,
): number {
	return document.clips.reduce((sum, clip) => sum + clip.outMs - clip.inMs, 0);
}

export function locateVodInputTimelineTime(
	document: VodInputTimelineDocument,
	timelineMs: number,
): { clipIndex: number; sourceMs: number; timelineStartMs: number } | null {
	if (!Number.isFinite(timelineMs) || timelineMs < 0) return null;
	let startMs = 0;
	for (const [clipIndex, clip] of document.clips.entries()) {
		const endMs = startMs + clip.outMs - clip.inMs;
		if (timelineMs < endMs)
			return {
				clipIndex,
				sourceMs: clip.inMs + timelineMs - startMs,
				timelineStartMs: startMs,
			};
		startMs = endMs;
	}
	return null;
}

/** Trim the sequence to a bounded preview window without changing source timestamps. */
export function sliceVodInputTimeline(
	document: VodInputTimelineDocument,
	range: { startMs: number; durationMs: number },
): VodInputTimelineDocument {
	const parsed = vodInputTimelineDocumentSchema.parse(document);
	const window = vodInputPreviewRangeSchema.parse(range);
	let timelineStartMs = 0;
	const clips = parsed.clips.flatMap((clip) => {
		const timelineEndMs = timelineStartMs + clip.outMs - clip.inMs;
		const startMs = Math.max(timelineStartMs, window.startMs);
		const endMs = Math.min(timelineEndMs, window.startMs + window.durationMs);
		const trimmed =
			endMs > startMs
				? [
						{
							...clip,
							inMs: clip.inMs + startMs - timelineStartMs,
							outMs: clip.inMs + endMs - timelineStartMs,
						},
					]
				: [];
		timelineStartMs = timelineEndMs;
		return trimmed;
	});
	return { ...parsed, clips };
}

export type VodInputTimelineIssue = {
	code:
		| "TIMELINE_EMPTY"
		| "SOURCE_NOT_READY"
		| "SOURCE_RANGE_INVALID"
		| "SOURCE_AUDIO_MISSING";
	clipId?: string;
	sourceKey?: string;
};

export function validateVodInputTimeline(
	document: VodInputTimelineDocument,
	facts: readonly VodInputTimelineSourceFacts[],
): VodInputTimelineIssue[] {
	const issues: VodInputTimelineIssue[] = [];
	if (!document.clips.length) issues.push({ code: "TIMELINE_EMPTY" });
	const byKey = new Map(facts.map((source) => [source.key, source]));
	for (const clip of document.clips) {
		const source = byKey.get(clip.sourceKey);
		const ref = { clipId: clip.id, sourceKey: clip.sourceKey };
		if (!source) issues.push({ code: "SOURCE_NOT_READY", ...ref });
		else {
			if (
				clip.inMs < 0 ||
				clip.outMs <= clip.inMs ||
				clip.outMs > source.durationMs
			)
				issues.push({ code: "SOURCE_RANGE_INVALID", ...ref });
			if (document.audioEnabled && !source.audio)
				issues.push({ code: "SOURCE_AUDIO_MISSING", ...ref });
		}
	}
	return issues;
}
