import {
	MAX_VOD_TIMELINE_GAP_MS,
	type VodInputTimelineDocument,
	type VodInputTimelinePlacedClip,
	type VodInputTimelineSourceFacts,
	type VodInputTimelineTrack,
	type VodInputTimelineV2Document,
	vodInputPreviewRangeSchema,
} from "./contracts";

/** Explicit migration, deliberately not a wire-schema transform. */
export function normalizeVodInputTimelineDocument(
	document: VodInputTimelineDocument,
): VodInputTimelineV2Document {
	if (document.schemaVersion === 2) return document;
	let startMs = 0;
	const videoClips = document.clips.map((clip) => {
		const placed = { ...clip, startMs };
		startMs += clip.outMs - clip.inMs;
		return placed;
	});
	return {
		schemaVersion: 2,
		id: document.id,
		audioEnabled: document.audioEnabled,
		durationMs: startMs,
		videoClips,
		// Muting does not erase material needed when audio is enabled again.
		audioClips: videoClips.map((clip) => ({ ...clip })),
	};
}

export function getVodInputTimelineDurationMs(
	document: VodInputTimelineDocument,
): number {
	return document.schemaVersion === 2
		? document.durationMs
		: document.clips.reduce((sum, clip) => sum + clip.outMs - clip.inMs, 0);
}

export function getVodInputTimelineTrack(
	document: VodInputTimelineDocument,
	track: VodInputTimelineTrack,
): VodInputTimelinePlacedClip[] {
	const normalized = normalizeVodInputTimelineDocument(document);
	return track === "video" ? normalized.videoClips : normalized.audioClips;
}

export function getVodInputTimelineUsedSourceKeys(
	document: VodInputTimelineDocument,
): string[] {
	const normalized = normalizeVodInputTimelineDocument(document);
	return [
		...new Set([
			...normalized.videoClips.map((clip) => clip.sourceKey),
			...(normalized.audioEnabled
				? normalized.audioClips.map((clip) => clip.sourceKey)
				: []),
		]),
	];
}

export function getVodInputTimelineSourceDurationMs(
	source: VodInputTimelineSourceFacts,
	track: VodInputTimelineTrack,
): number {
	return source[track]?.durationMs ?? source.durationMs;
}

export function locateVodInputTimelineTime(
	document: VodInputTimelineDocument,
	timelineMs: number,
	track: VodInputTimelineTrack = "video",
): {
	clipIndex: number;
	clip: VodInputTimelinePlacedClip;
	sourceMs: number;
	timelineStartMs: number;
} | null {
	if (
		!Number.isFinite(timelineMs) ||
		timelineMs < 0 ||
		timelineMs >= getVodInputTimelineDurationMs(document)
	)
		return null;
	for (const [clipIndex, clip] of getVodInputTimelineTrack(
		document,
		track,
	).entries()) {
		if (
			timelineMs >= clip.startMs &&
			timelineMs < clip.startMs + clip.outMs - clip.inMs
		)
			return {
				clipIndex,
				clip,
				sourceMs: clip.inMs + timelineMs - clip.startMs,
				timelineStartMs: clip.startMs,
			};
	}
	return null;
}

export type VodInputTimelineSegment =
	| {
			kind: "source";
			id: string;
			sourceKey: string;
			startMs: number;
			inMs: number;
			outMs: number;
			durationMs: number;
	  }
	| { kind: "gap"; startMs: number; durationMs: number };
export type ResolvedVodInputTimeline = {
	startMs: number;
	durationMs: number;
	mainVideoSourceKey: string | null;
	hasAudio: boolean;
	videoSegments: VodInputTimelineSegment[];
	audioSegments: VodInputTimelineSegment[];
};

function clipWindow(
	clips: VodInputTimelinePlacedClip[],
	startMs: number,
	endMs: number,
) {
	return clips.flatMap((clip) => {
		const left = Math.max(startMs, clip.startMs);
		const right = Math.min(endMs, clip.startMs + clip.outMs - clip.inMs);
		return right > left
			? [
					{
						...clip,
						startMs: left - startMs,
						inMs: clip.inMs + left - clip.startMs,
						outMs: clip.inMs + right - clip.startMs,
					},
				]
			: [];
	});
}

function segments(
	clips: VodInputTimelinePlacedClip[],
	startMs: number,
	endMs: number,
): VodInputTimelineSegment[] {
	const result: VodInputTimelineSegment[] = [];
	let cursor = 0;
	for (const clip of clipWindow(clips, startMs, endMs)) {
		if (clip.startMs > cursor)
			result.push({
				kind: "gap",
				startMs: cursor,
				durationMs: clip.startMs - cursor,
			});
		const durationMs = clip.outMs - clip.inMs;
		result.push({ kind: "source", ...clip, durationMs });
		cursor = clip.startMs + durationMs;
	}
	if (cursor < endMs - startMs)
		result.push({
			kind: "gap",
			startMs: cursor,
			durationMs: endMs - startMs - cursor,
		});
	return result;
}

/** Resolve once for both native graphs and CPU preview. Main is chosen before slicing. */
export function resolveVodInputTimeline(
	input: VodInputTimelineDocument,
	range?: { startMs: number; durationMs: number },
): ResolvedVodInputTimeline {
	const document = normalizeVodInputTimelineDocument(input);
	const window = range
		? vodInputPreviewRangeSchema.parse(range)
		: { startMs: 0, durationMs: document.durationMs };
	const startMs = Math.min(window.startMs, document.durationMs);
	const endMs = Math.min(startMs + window.durationMs, document.durationMs);
	const hasAudio = document.audioEnabled && document.audioClips.length > 0;
	return {
		startMs,
		durationMs: endMs - startMs,
		mainVideoSourceKey: document.videoClips[0]?.sourceKey ?? null,
		hasAudio,
		videoSegments: segments(document.videoClips, startMs, endMs),
		audioSegments: hasAudio
			? segments(document.audioClips, startMs, endMs)
			: [],
	};
}

export function sliceVodInputTimeline(
	input: VodInputTimelineDocument,
	range: { startMs: number; durationMs: number },
): VodInputTimelineV2Document {
	const document = normalizeVodInputTimelineDocument(input);
	const resolved = resolveVodInputTimeline(document, range);
	const endMs = resolved.startMs + resolved.durationMs;
	return {
		...document,
		durationMs: resolved.durationMs,
		videoClips: clipWindow(document.videoClips, resolved.startMs, endMs),
		audioClips: clipWindow(document.audioClips, resolved.startMs, endMs),
	};
}

export type VodInputTimelineIssue = {
	code:
		| "TIMELINE_EMPTY"
		| "TIMELINE_VIDEO_MISSING"
		| "TIMELINE_GAP_TOO_LONG"
		| "SOURCE_NOT_READY"
		| "SOURCE_RANGE_INVALID"
		| "SOURCE_VIDEO_MISSING"
		| "SOURCE_AUDIO_MISSING";
	clipId?: string;
	sourceKey?: string;
	track?: VodInputTimelineTrack;
	startMs?: number;
	durationMs?: number;
};

export function validateVodInputTimeline(
	input: VodInputTimelineDocument,
	facts: readonly VodInputTimelineSourceFacts[],
	options: { requireVideo?: boolean } = {},
): VodInputTimelineIssue[] {
	const document = normalizeVodInputTimelineDocument(input);
	const issues: VodInputTimelineIssue[] = [];
	if (
		!document.durationMs ||
		(!document.videoClips.length &&
			(!document.audioEnabled || !document.audioClips.length))
	)
		issues.push({ code: "TIMELINE_EMPTY" });
	if (options.requireVideo && !document.videoClips.length)
		issues.push({ code: "TIMELINE_VIDEO_MISSING" });
	const byKey = new Map(facts.map((source) => [source.key, source]));
	for (const track of document.audioEnabled
		? (["video", "audio"] as const)
		: (["video"] as const)) {
		const clips = getVodInputTimelineTrack(document, track);
		for (const clip of clips) {
			const source = byKey.get(clip.sourceKey);
			const ref = { clipId: clip.id, sourceKey: clip.sourceKey, track };
			if (!source) issues.push({ code: "SOURCE_NOT_READY", ...ref });
			else {
				if (
					clip.inMs < 0 ||
					clip.outMs <= clip.inMs ||
					clip.outMs > getVodInputTimelineSourceDurationMs(source, track)
				)
					issues.push({ code: "SOURCE_RANGE_INVALID", ...ref });
				if (!source[track])
					issues.push({
						code:
							track === "video"
								? "SOURCE_VIDEO_MISSING"
								: "SOURCE_AUDIO_MISSING",
						...ref,
					});
			}
		}
		if (clips.length)
			for (const segment of segments(clips, 0, document.durationMs)) {
				if (
					segment.kind === "gap" &&
					segment.durationMs > MAX_VOD_TIMELINE_GAP_MS
				)
					issues.push({
						code: "TIMELINE_GAP_TOO_LONG",
						track,
						startMs: segment.startMs,
						durationMs: segment.durationMs,
					});
			}
	}
	return issues;
}
