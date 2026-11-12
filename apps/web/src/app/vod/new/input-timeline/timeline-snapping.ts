import type {
	VodInputTimelineTrack,
	VodInputTimelineV2Document,
} from "@bitovp/core/vod-input-timeline";

export function timelineSnapCandidates(
	document: VodInputTimelineV2Document,
	exclude?: { track: VodInputTimelineTrack; id: string },
	playheadMs?: number,
): number[] {
	const candidates = new Set([0, document.durationMs]);
	const tracks = [
		["video", document.videoClips],
		["audio", document.audioClips],
	] as const;
	for (const [track, clips] of tracks) {
		for (const clip of clips) {
			if (exclude?.track === track && exclude.id === clip.id) continue;
			candidates.add(clip.startMs);
			candidates.add(clip.startMs + clip.outMs - clip.inMs);
		}
	}
	if (
		playheadMs !== undefined &&
		Number.isInteger(playheadMs) &&
		playheadMs >= 0 &&
		playheadMs <= document.durationMs
	)
		candidates.add(playheadMs);
	return [...candidates].sort((a, b) => a - b);
}

function screenDistance(
	positionMs: number,
	candidateMs: number,
	scale: number,
) {
	const distance = Math.abs(candidateMs - positionMs);
	// Subtraction can overflow for opposite finite extremes; scaling first is safe here.
	return Number.isFinite(distance)
		? distance * scale
		: Math.abs(positionMs * scale) + candidateMs * scale;
}

export function snapTimelineTime(
	positionMs: number,
	candidates: readonly number[],
	pixelsPerMs: number,
	previousMs?: number | null,
): number | null {
	if (
		!Number.isFinite(positionMs) ||
		!Number.isFinite(pixelsPerMs) ||
		pixelsPerMs <= 0
	)
		return null;
	const valid = candidates.filter(
		(candidate) => Number.isInteger(candidate) && candidate >= 0,
	);
	if (
		previousMs != null &&
		valid.includes(previousMs) &&
		screenDistance(positionMs, previousMs, pixelsPerMs) <= 12
	)
		return previousMs;

	let nearest: number | null = null;
	let nearestDistance = Infinity;
	for (const candidate of valid) {
		const distance = Math.abs(candidate - positionMs);
		if (
			nearest === null ||
			distance < nearestDistance ||
			(distance === nearestDistance && candidate < nearest)
		) {
			nearest = candidate;
			nearestDistance = distance;
		}
	}
	return nearest !== null &&
		screenDistance(positionMs, nearest, pixelsPerMs) <= 8
		? nearest
		: null;
}

export type TimelineBodySnap = { edge: "in" | "out"; timeMs: number };

export function snapTimelineBody(
	startMs: number,
	durationMs: number,
	programDurationMs: number,
	candidates: readonly number[],
	pixelsPerMs: number,
	previous: TimelineBodySnap | null,
): TimelineBodySnap | null {
	const choices = (["in", "out"] as const).map((edge) => {
		const offset = edge === "in" ? 0 : durationMs;
		const valid = candidates.filter(
			(time) =>
				time >= offset && time <= programDurationMs - durationMs + offset,
		);
		return { edge, position: startMs + offset, valid };
	});
	if (previous) {
		const anchor = choices.find((choice) => choice.edge === previous.edge);
		if (
			anchor &&
			snapTimelineTime(
				anchor.position,
				anchor.valid,
				pixelsPerMs,
				previous.timeMs,
			) === previous.timeMs
		)
			return previous;
	}
	let nearest: (TimelineBodySnap & { distance: number }) | null = null;
	for (const choice of choices) {
		const timeMs = snapTimelineTime(choice.position, choice.valid, pixelsPerMs);
		if (timeMs === null) continue;
		const distance = Math.abs(timeMs - choice.position);
		if (!nearest || distance < nearest.distance)
			nearest = { edge: choice.edge, timeMs, distance };
	}
	return nearest && { edge: nearest.edge, timeMs: nearest.timeMs };
}
