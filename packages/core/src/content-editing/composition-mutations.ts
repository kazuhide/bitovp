import {
	type CompositionSourceFacts,
	compileComposition,
} from "./composition-frame";
import { interpolateCompositionCrop } from "./composition-geometry";
import {
	type CompositionClip,
	type CompositionDocument,
	compositionClipOrder,
	compositionDocumentSchema,
} from "./composition-schema";
import type { EditFraming } from "./schema";
import { originalTimeToCfrFrame } from "./time";

function atSourceFrame(frame: number, source: CompositionSourceFacts) {
	const value =
		BigInt(source.timeMap.sourceStartUs) +
		(BigInt(frame - source.timeMap.editingStartFrame) * 1000000n + 29n) / 30n;
	const result = Number(value);
	if (!Number.isSafeInteger(result) || result < 0)
		throw new RangeError("Invalid source frame");
	return result;
}
function sourceFor(
	document: CompositionDocument,
	clip: CompositionClip,
	sources: readonly CompositionSourceFacts[],
) {
	const source = sources.find(
		(item) =>
			item.mediaVersionId === (clip.mediaVersionId ?? document.mediaVersionId),
	);
	if (!source) throw new RangeError("Missing source geometry");
	return source;
}
function pick(document: CompositionDocument, id: string) {
	const clip = document.clips.find((c) => c.id === id);
	if (!clip) throw new RangeError("Unknown composition clip");
	return clip;
}
function normalizeTransitions(document: CompositionDocument) {
	const tracks = new Set(document.clips.map((c) => c.trackId ?? "main"));
	for (const track of tracks) {
		const clips = document.clips
			.filter((c) => (c.trackId ?? "main") === track)
			.sort(compositionClipOrder);
		clips.forEach((clip, index) => {
			if (!clip.transitionIn) return;
			const previous = clips[index - 1];
			const overlap = previous
				? previous.timelineStartFrame +
					previous.durationFrames -
					clip.timelineStartFrame
				: 0;
			if (overlap <= 0) delete clip.transitionIn;
			else clip.transitionIn.durationFrames = overlap;
		});
	}
	return compositionDocumentSchema.parse(document);
}
function slicedFraming(
	clip: CompositionClip,
	from: number,
	duration: number,
): EditFraming[] {
	const result: EditFraming[] = [];
	const to = from + duration;
	if (from < 0)
		result.push({
			fromFrame: 0,
			toFrame: Math.min(duration, -from),
			mode: "FIT",
			origin: "MANUAL",
			manualOverride: true,
		});
	for (const part of clip.framing) {
		const start = Math.max(from, part.fromFrame);
		const end = Math.min(to, part.toFrame);
		if (end > start)
			result.push({ ...part, fromFrame: start - from, toFrame: end - from });
	}
	if (to > clip.durationFrames)
		result.push({
			fromFrame: Math.max(0, clip.durationFrames - from),
			toFrame: duration,
			mode: "FIT",
			origin: "MANUAL",
			manualOverride: true,
		});
	return result;
}
function slicedKeys(clip: CompositionClip, from: number, duration: number) {
	const keys = clip.cropKeyframes;
	if (!keys?.length) return undefined;
	const fallback = keys[0]?.rect ?? { x: 0, y: 0, w: 1, h: 1 };
	const end = from + duration - 1;
	const frames = [
		...new Set([
			from,
			...keys
				.filter((k) => k.frame > from && k.frame < end)
				.map((k) => k.frame),
			end,
		]),
	].sort((a, b) => a - b);
	return frames.map((frame, index) => {
		const next = frames[index + 1];
		const segment = keys.findIndex(
			(key, i) =>
				key.frame <= frame && (keys[i + 1]?.frame ?? -Infinity) > frame,
		);
		const left = keys[segment];
		const right = keys[segment + 1];
		if (next !== undefined && left && right) {
			const start = left.curveStart ?? 0;
			const extent = (left.curveEnd ?? 1) - start;
			const p = (frame - left.frame) / (right.frame - left.frame);
			const q = (next - left.frame) / (right.frame - left.frame);
			return {
				frame: frame - from,
				rect: interpolateCompositionCrop(keys, frame, fallback),
				easing: left.easing,
				curveStart: start + extent * p,
				curveEnd: start + extent * q,
			};
		}
		return {
			frame: frame - from,
			rect: interpolateCompositionCrop(keys, frame, fallback),
			easing: "LINEAR" as const,
		};
	});
}
function sliceClip(
	clip: CompositionClip,
	from: number,
	duration: number,
	source: CompositionSourceFacts,
): CompositionClip {
	const sourceFrame =
		Number(
			originalTimeToCfrFrame(
				clip.sourceInUs,
				source.timeMap.sourceStartUs,
				"FLOOR",
			),
		) + source.timeMap.editingStartFrame;
	return {
		...clip,
		sourceInUs: atSourceFrame(sourceFrame + from, source),
		durationFrames: duration,
		framing: slicedFraming(clip, from, duration),
		cropKeyframes: slicedKeys(clip, from, duration),
		audio: {
			...clip.audio,
			fadeWindow: {
				offsetFrames: (clip.audio.fadeWindow?.offsetFrames ?? 0) + from,
				durationFrames:
					clip.audio.fadeWindow?.durationFrames ?? clip.durationFrames,
			},
		},
	};
}
function remapAnchored(
	document: CompositionDocument,
	clipId: string,
	shift: number,
	from: number,
	to: number,
	sources?: readonly CompositionSourceFacts[],
) {
	document.captions = (document.captions ?? []).flatMap((item) => {
		if (item.anchorClipId !== clipId) return [item];
		const start = Math.max(from, item.fromFrame + shift);
		const end = Math.min(to, item.toFrame + shift);
		if (end <= start) return [];
		const words = item.words?.flatMap((word) => {
			const a = Math.max(start, word.fromFrame + shift);
			const b = Math.min(end, word.toFrame + shift);
			return b > a ? [{ ...word, fromFrame: a, toFrame: b }] : [];
		});
		return [
			{
				...item,
				fromFrame: start,
				toFrame: end,
				words: words?.length ? words : undefined,
			},
		];
	});
	document.overlays = (document.overlays ?? []).flatMap((item) => {
		if (item.anchorClipId !== clipId) return [item];
		const a = Math.max(from, item.fromFrame + shift);
		const b = Math.min(to, item.toFrame + shift);
		return b > a ? [{ ...item, fromFrame: a, toFrame: b }] : [];
	});
	document.audioTracks = (document.audioTracks ?? []).flatMap((item) => {
		if (item.anchorClipId !== clipId) return [item];
		const shifted = item.timelineStartFrame + shift;
		const a = Math.max(from, shifted);
		const b = Math.min(to, shifted + item.durationFrames);
		if (b <= a) return [];
		const cut = a - shifted;
		let sourceInUs = item.sourceInUs;
		if (cut) {
			const source = sources?.find(
				(s) => s.mediaVersionId === item.mediaVersionId,
			);
			if (!source) throw new RangeError("Missing audio source geometry");
			const frame =
				Number(
					originalTimeToCfrFrame(
						item.sourceInUs,
						source.timeMap.sourceStartUs,
						"FLOOR",
					),
				) + source.timeMap.editingStartFrame;
			sourceInUs = atSourceFrame(frame + cut, source);
		}
		const ducking = item.ducking
			? {
					...item.ducking,
					intervals: item.ducking.intervals.flatMap((i) => {
						const start = Math.max(0, i.fromFrame + shift);
						const end = Math.min(5400, i.toFrame + shift);
						return end > start ? [{ fromFrame: start, toFrame: end }] : [];
					}),
				}
			: undefined;
		return [
			{
				...item,
				sourceInUs,
				timelineStartFrame: a,
				durationFrames: b - a,
				fadeWindow: {
					offsetFrames: (item.fadeWindow?.offsetFrames ?? 0) + cut,
					durationFrames:
						item.fadeWindow?.durationFrames ?? item.durationFrames,
				},
				ducking,
			},
		];
	});
}

/** Other tracks and unanchored items retain their global output positions. */
export function trimCompositionClip(
	input: CompositionDocument,
	clipId: string,
	range: { sourceInUs: number; durationFrames: number },
	sources: readonly CompositionSourceFacts[],
): CompositionDocument {
	const document = compositionDocumentSchema.parse(input);
	const clip = pick(document, clipId);
	const source = sourceFor(document, clip, sources);
	const oldFrame = originalTimeToCfrFrame(
		clip.sourceInUs,
		source.timeMap.sourceStartUs,
		"FLOOR",
	);
	const newFrame = originalTimeToCfrFrame(
		range.sourceInUs,
		source.timeMap.sourceStartUs,
		"FLOOR",
	);
	const delta = Number(newFrame - oldFrame);
	const replacement = sliceClip(clip, delta, range.durationFrames, source);
	replacement.sourceInUs = range.sourceInUs;
	if (
		(document.presentation?.fallbackFraming === "AISA_STATIC_V1" ||
			document.presentation?.fallbackFraming === "PRESERVE_SOURCE_V1") &&
		(delta !== 0 || delta + range.durationFrames > clip.durationFrames)
	) {
		// The changed source window no longer owns the original shot positions.
		// Keep scene-level evidence for any remaining AUTO_POLICY framing.
		if (replacement.evidence) {
			replacement.evidence = { ...replacement.evidence };
			delete replacement.evidence.shotIndex;
		}
		document.presentation.centerCropConfirmed = false;
	}
	document.clips = document.clips.map((item) =>
		item.id === clipId ? replacement : item,
	);
	remapAnchored(
		document,
		clipId,
		-delta,
		clip.timelineStartFrame,
		clip.timelineStartFrame + range.durationFrames,
		sources,
	);
	const result = normalizeTransitions(document);
	compileComposition(result, sources, { allowUnconfirmed: true });
	return result;
}

/** Spanning timed items stay exact on the global clock; contained items reanchor. */
export function splitCompositionClip(
	input: CompositionDocument,
	clipId: string,
	localFrame: number,
	rightClipId: string,
	sources: readonly CompositionSourceFacts[],
): CompositionDocument {
	const document = compositionDocumentSchema.parse(input);
	const clip = pick(document, clipId);
	if (
		!Number.isSafeInteger(localFrame) ||
		localFrame < 1 ||
		localFrame >= clip.durationFrames
	)
		throw new RangeError("Split must be inside clip");
	const source = sourceFor(document, clip, sources);
	const left = sliceClip(clip, 0, localFrame, source);
	const right = sliceClip(
		clip,
		localFrame,
		clip.durationFrames - localFrame,
		source,
	);
	right.id = rightClipId;
	right.timelineStartFrame += localFrame;
	delete right.transitionIn;
	document.clips = document.clips.flatMap((item) =>
		item.id === clipId ? [left, right] : [item],
	);
	const cut = right.timelineStartFrame;
	const reanchor = (
		item: { anchorClipId?: string },
		start: number,
		end: number,
	) => {
		if (item.anchorClipId !== clipId) return;
		if (start >= cut) item.anchorClipId = rightClipId;
		else if (end > cut) delete item.anchorClipId;
	};
	for (const item of document.captions ?? [])
		reanchor(item, item.fromFrame, item.toFrame);
	for (const item of document.overlays ?? [])
		reanchor(item, item.fromFrame, item.toFrame);
	for (const item of document.audioTracks ?? [])
		reanchor(
			item,
			item.timelineStartFrame,
			item.timelineStartFrame + item.durationFrames,
		);
	const result = normalizeTransitions(document);
	compileComposition(result, sources, { allowUnconfirmed: true });
	return result;
}
export function moveCompositionClip(
	input: CompositionDocument,
	clipId: string,
	position: {
		timelineStartFrame: number;
		trackId?: string;
		transitionIn?: CompositionClip["transitionIn"] | null;
	},
): CompositionDocument {
	const document = compositionDocumentSchema.parse(input);
	const clip = pick(document, clipId);
	const delta = position.timelineStartFrame - clip.timelineStartFrame;
	clip.timelineStartFrame = position.timelineStartFrame;
	if (position.trackId !== undefined) clip.trackId = position.trackId;
	if ("transitionIn" in position)
		clip.transitionIn = position.transitionIn ?? undefined;
	remapAnchored(document, clipId, delta, 0, 5400);
	return normalizeTransitions(document);
}
export function removeCompositionClip(
	input: CompositionDocument,
	clipId: string,
): CompositionDocument {
	const document = compositionDocumentSchema.parse(input);
	pick(document, clipId);
	document.clips = document.clips.filter((c) => c.id !== clipId);
	document.captions = (document.captions ?? []).filter(
		(c) => c.anchorClipId !== clipId,
	);
	document.overlays = (document.overlays ?? []).filter(
		(c) => c.anchorClipId !== clipId,
	);
	document.audioTracks = (document.audioTracks ?? []).filter(
		(c) => c.anchorClipId !== clipId,
	);
	return normalizeTransitions(document);
}
