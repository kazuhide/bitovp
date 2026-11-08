import {
	type CfrTimeMap,
	type EditClip,
	type EditDocument,
	type EditFraming,
	type FramingGeometry,
	MAX_EDIT_CLIPS,
	originalTimeToCfrFrame,
	suggestShotFraming,
} from "@bitovp/core";

export function reflowClips(
	document: EditDocument,
	clips: EditClip[],
): EditDocument {
	let frame = 0;
	return {
		...document,
		clips: clips.map((clip) => {
			const next = { ...clip, timelineStartFrame: frame };
			frame += clip.durationFrames;
			return next;
		}),
	};
}
export function replaceClip(
	document: EditDocument,
	index: number,
	clip: EditClip,
): EditDocument {
	return reflowClips(
		document,
		document.clips.map((current, position) =>
			position === index ? clip : current,
		),
	);
}
export function moveClip(
	document: EditDocument,
	index: number,
	direction: -1 | 1,
): EditDocument {
	const clips = [...document.clips];
	const next = index + direction;
	const moving = clips[index];
	if (!moving || next < 0 || next >= clips.length) return document;
	clips.splice(index, 1);
	clips.splice(next, 0, moving);
	return reflowClips(document, clips);
}
export function removeClip(
	document: EditDocument,
	index: number,
): EditDocument {
	if (document.clips.length === 1)
		throw new RangeError("An edit needs at least one clip");
	return reflowClips(
		document,
		document.clips.filter((_, position) => position !== index),
	);
}
export function changeClipRange(
	document: EditDocument,
	index: number,
	inSeconds: number,
	outSeconds: number,
	mediaDurationUs: number,
	sourceStartUs = 0,
): EditDocument {
	const requestedInUs = Math.round(inSeconds * 1_000_000);
	const sourceOutUs = Math.round(outSeconds * 1_000_000);
	if (
		!Number.isSafeInteger(requestedInUs) ||
		!Number.isSafeInteger(sourceOutUs) ||
		!Number.isSafeInteger(sourceStartUs) ||
		sourceStartUs < 0 ||
		requestedInUs < sourceStartUs ||
		sourceOutUs > mediaDurationUs ||
		sourceOutUs <= requestedInUs
	)
		throw new RangeError("Invalid source interval");
	const startFrame = originalFrameAtUs(requestedInUs, sourceStartUs);
	const sourceInUs = originalUsAtFrame(startFrame, sourceStartUs);
	const durationFrames = Number(
		originalFrameAtUs(sourceOutUs, sourceStartUs) - startFrame,
	);
	const clip = document.clips[index];
	if (!clip || durationFrames < 1)
		throw new RangeError("The range must contain at least one output frame");
	return replaceClip(document, index, {
		...clip,
		sourceInUs,
		durationFrames,
		framing: [
			{ fromFrame: 0, toFrame: durationFrames, mode: "FIT", origin: "MANUAL" },
		],
	});
}
function originalFrameAtUs(us: number, sourceStartUs: number): bigint {
	return originalTimeToCfrFrame(us, sourceStartUs, "FLOOR");
}
function originalUsAtFrame(frame: bigint, sourceStartUs: number): number {
	const us = BigInt(sourceStartUs) + (frame * 1_000_000n + 29n) / 30n;
	if (us < 0n || us > BigInt(Number.MAX_SAFE_INTEGER))
		throw new RangeError("Invalid source time");
	return Number(us);
}
export function clipOutUs(clip: EditClip, sourceStartUs = 0): number {
	return originalUsAtFrame(
		originalFrameAtUs(clip.sourceInUs, sourceStartUs) +
			BigInt(clip.durationFrames),
		sourceStartUs,
	);
}
export function splitClip(
	document: EditDocument,
	index: number,
	atFrame: number,
	newClipId: string,
	map: CfrTimeMap,
): EditDocument {
	const clip = document.clips[index];
	if (
		!clip ||
		!Number.isSafeInteger(atFrame) ||
		atFrame <= 0 ||
		atFrame >= clip.durationFrames ||
		document.clips.length >= MAX_EDIT_CLIPS ||
		document.clips.some(
			(item) => item.id.toLowerCase() === newClipId.toLowerCase(),
		) ||
		map.id !== document.timeMapId ||
		map.mediaVersionId !== document.mediaVersionId ||
		clip.sourceInUs < map.sourceStartUs
	)
		throw new RangeError("Invalid split");
	const sliceFraming = (from: number, to: number): EditFraming[] =>
		clip.framing
			.filter((part) => part.fromFrame < to && part.toFrame > from)
			.map((part) => ({
				...part,
				fromFrame: Math.max(from, part.fromFrame) - from,
				toFrame: Math.min(to, part.toFrame) - from,
			}));
	const left: EditClip = {
		...clip,
		durationFrames: atFrame,
		framing: sliceFraming(0, atFrame),
	};
	const right: EditClip = {
		...clip,
		id: newClipId,
		sourceInUs: originalUsAtFrame(
			originalFrameAtUs(clip.sourceInUs, map.sourceStartUs) + BigInt(atFrame),
			map.sourceStartUs,
		),
		durationFrames: clip.durationFrames - atFrame,
		framing: sliceFraming(atFrame, clip.durationFrames),
	};
	return reflowClips(document, [
		...document.clips.slice(0, index),
		left,
		right,
		...document.clips.slice(index + 1),
	]);
}
export function secondsLabel(us: number): string {
	return (us / 1_000_000).toFixed(6).replace(/\.?0+$/, "");
}
type Shot = {
	startInSeconds: number;
	endInSeconds: number;
	mainSubjects: readonly {
		centerX?: unknown;
		centerY?: unknown;
		box2d?: unknown;
	}[];
};

/** Re-proposing may replace unadjusted fit ranges, but never an editor's framing. */
export function mergeShotFramingSuggestions(
	clip: EditClip,
	suggestions: readonly EditFraming[],
): EditFraming[] {
	return clip.framing.flatMap((current) => {
		if (
			current.manualOverride === true ||
			current.origin === "EDITOR_CONFIRMED" ||
			(current.origin === "MANUAL" && current.mode === "CROP")
		)
			return [current];
		const boundaries = [
			...new Set([
				current.fromFrame,
				current.toFrame,
				...suggestions
					.flatMap((part) => [part.fromFrame, part.toFrame])
					.filter(
						(frame) => frame > current.fromFrame && frame < current.toFrame,
					),
			]),
		].sort((a, b) => a - b);
		const result: EditFraming[] = [];
		for (let index = 1; index < boundaries.length; index++) {
			const fromFrame = boundaries[index - 1];
			const toFrame = boundaries[index];
			if (fromFrame === undefined || toFrame === undefined) continue;
			const proposed =
				suggestions.find(
					(part) => part.fromFrame <= fromFrame && part.toFrame >= toFrame,
				) ?? current;
			result.push({ ...proposed, fromFrame, toFrame });
		}
		return result;
	});
}

export function shotFramingForClip(
	clip: EditClip,
	shots: readonly Shot[],
	geometry: FramingGeometry,
	coordinateSpaceVerified: boolean,
	sourceStartUs = 0,
): EditFraming[] {
	const clipStartFrame = originalTimeToCfrFrame(
		clip.sourceInUs,
		sourceStartUs,
		"FLOOR",
	);
	const atFrame = (seconds: number) => {
		if (seconds < 0 || !Number.isSafeInteger(Math.round(seconds * 1_000_000)))
			throw new RangeError("Invalid original CFR time");
		// Keep provider precision until frame conversion. Rounding an exact
		// frame/30 boundary to integer microseconds can move it to the next frame.
		const frame = (seconds - sourceStartUs / 1_000_000) * 30;
		const nearest = Math.round(frame);
		const floatError =
			4 *
			Number.EPSILON *
			Math.max(
				1,
				Math.abs(seconds * 30),
				Math.abs((sourceStartUs * 30) / 1_000_000),
			);
		const boundary =
			Math.abs(frame - nearest) <= floatError ? nearest : Math.ceil(frame);
		return boundary - Number(clipStartFrame);
	};
	const intervals = shots
		.map((shot) => ({
			shot,
			from: Math.max(0, atFrame(shot.startInSeconds)),
			to: Math.min(clip.durationFrames, atFrame(shot.endInSeconds)),
		}))
		.filter((part) => part.to > part.from)
		.sort((a, b) => a.from - b.from || a.to - b.to);
	const boundaries = [
		...new Set([
			0,
			clip.durationFrames,
			...intervals.flatMap((part) => [part.from, part.to]),
		]),
	].sort((a, b) => a - b);
	const result: EditFraming[] = [];
	for (let index = 1; index < boundaries.length; index++) {
		const fromFrame = boundaries[index - 1];
		const toFrame = boundaries[index];
		if (fromFrame === undefined || toFrame === undefined) continue;
		const active = intervals.find(
			(part) => part.from <= fromFrame && part.to > fromFrame,
		);
		const suggestion = suggestShotFraming({
			...geometry,
			mainSubjects: active?.shot.mainSubjects ?? [],
			coordinateSpaceVerified,
		});
		result.push(
			suggestion.mode === "FIT"
				? { fromFrame, toFrame, mode: "FIT", origin: "AISA_PROPOSAL" }
				: {
						fromFrame,
						toFrame,
						mode: "CROP",
						rect: suggestion.rect,
						origin: "AISA_PROPOSAL",
					},
		);
	}
	return mergeShotFramingSuggestions(clip, result);
}
