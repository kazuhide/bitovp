import {
	type CfrTimeMap,
	type EditClip,
	type EditDocument,
	type EditFraming,
	MAX_EDIT_DURATION_FRAMES,
	MAX_EDIT_FRAMING_SEGMENTS,
	originalTimeToCfrFrame,
} from "@bitovp/core";
import { replaceClip } from "./edit-model";

export type TrimEdge = "IN" | "OUT";

function verifyMap(document: EditDocument, map: CfrTimeMap) {
	if (
		map.id !== document.timeMapId ||
		map.mediaVersionId !== document.mediaVersionId ||
		map.fps.num !== 30 ||
		map.fps.den !== 1
	)
		throw new RangeError("Mismatched editing time map");
}

export function clipSourceFrame(clip: EditClip, map: CfrTimeMap): number {
	return Number(
		originalTimeToCfrFrame(clip.sourceInUs, map.sourceStartUs, "FLOOR"),
	);
}

export function timelinePoint(
	document: EditDocument,
	requestedFrame: number,
	map: CfrTimeMap,
) {
	verifyMap(document, map);
	const total = document.clips.reduce(
		(sum, clip) => sum + clip.durationFrames,
		0,
	);
	if (!Number.isFinite(requestedFrame) || total < 1)
		throw new RangeError("Invalid timeline position");
	const frame = Math.max(0, Math.min(total - 1, Math.round(requestedFrame)));
	const index = document.clips.findIndex(
		(clip) => frame < clip.timelineStartFrame + clip.durationFrames,
	);
	const clip = document.clips[index];
	if (!clip) throw new RangeError("Missing timeline clip");
	const localFrame = frame - clip.timelineStartFrame;
	const sourceFrame =
		map.editingStartFrame + clipSourceFrame(clip, map) + localFrame;
	return {
		frame,
		index,
		localFrame,
		part: Math.max(
			0,
			clip.framing.findIndex(
				(part) => localFrame >= part.fromFrame && localFrame < part.toFrame,
			),
		),
		sourceFrame,
		sourceSeconds: sourceFrame / 30,
	};
}

/** Move one source boundary by whole frames; preserve framing only on overlap. */
export function trimTimelineClip(
	document: EditDocument,
	index: number,
	edge: TrimEdge,
	deltaFrames: number,
	map: CfrTimeMap,
): EditDocument {
	verifyMap(document, map);
	const clip = document.clips[index];
	if (!clip || !Number.isSafeInteger(deltaFrames))
		throw new RangeError("Invalid timeline trim");
	const start = clipSourceFrame(clip, map);
	const end = start + clip.durationFrames;
	const sourceFrames = Math.min(
		map.editingEndFrame - map.editingStartFrame,
		Number(originalTimeToCfrFrame(map.sourceEndUs, map.sourceStartUs, "FLOOR")),
	);
	const otherFrames = document.clips.reduce(
		(sum, item, position) =>
			sum + (position === index ? 0 : item.durationFrames),
		0,
	);
	const maximumLength = MAX_EDIT_DURATION_FRAMES - otherFrames;
	if (start < 0 || end > sourceFrames || maximumLength < 1)
		throw new RangeError("Invalid source range");
	const from =
		edge === "IN"
			? Math.max(0, end - maximumLength, Math.min(end - 1, start + deltaFrames))
			: start;
	const to =
		edge === "OUT"
			? Math.max(
					start + 1,
					Math.min(sourceFrames, start + maximumLength, end + deltaFrames),
				)
			: end;
	if (from === start && to === end) return document;
	const offset = from - start;
	const durationFrames = to - from;
	const framing: EditFraming[] = clip.framing
		.filter((part) => part.fromFrame < to - start && part.toFrame > offset)
		.map((part) => ({
			...part,
			fromFrame: Math.max(offset, part.fromFrame) - offset,
			toFrame: Math.min(to - start, part.toFrame) - offset,
		}));
	if (from < start)
		framing.unshift({
			fromFrame: 0,
			toFrame: start - from,
			mode: "FIT",
			origin: "MANUAL",
		});
	if (to > end)
		framing.push({
			fromFrame: end - from,
			toFrame: durationFrames,
			mode: "FIT",
			origin: "MANUAL",
		});
	const compact: EditFraming[] = [];
	for (const part of framing) {
		const previous = compact.at(-1);
		if (
			previous?.mode === "FIT" &&
			part.mode === "FIT" &&
			previous.origin === "MANUAL" &&
			part.origin === "MANUAL" &&
			previous.manualOverride !== true &&
			previous.manualOverride === part.manualOverride &&
			previous.toFrame === part.fromFrame
		)
			previous.toFrame = part.toFrame;
		else compact.push(part);
	}
	if (
		document.clips.reduce(
			(sum, item, position) =>
				sum + (position === index ? compact.length : item.framing.length),
			0,
		) > MAX_EDIT_FRAMING_SEGMENTS
	)
		throw new RangeError("Too many framing segments");
	const sourceInUs =
		map.sourceStartUs + Number((BigInt(from) * 1_000_000n + 29n) / 30n);
	return replaceClip(document, index, {
		...clip,
		sourceInUs,
		durationFrames,
		framing: compact,
	});
}

export function timelineTimecode(frame: number) {
	return [Math.floor(frame / 1800), Math.floor(frame / 30) % 60, frame % 30]
		.map((part) => String(part).padStart(2, "0"))
		.join(":");
}
