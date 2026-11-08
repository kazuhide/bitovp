import {
	cfrTimeMapSchema,
	type EditClip,
	type EditDocument,
	editingDocumentSchema,
} from "@bitovp/core";
import type { EditingMediaView } from "@/lib/library-editing";
import { timelinePoint } from "./timeline-model";

export type PreviewClip = {
	clip: EditClip;
	outputFrom: number;
	outputTo: number;
	sourceFrom: number;
	sourceTo: number;
};
export type PreviewPlan = {
	document: EditDocument;
	sourceKey: string;
	width: number;
	height: number;
	total: number;
	clips: PreviewClip[];
};

export function buildPreviewPlan(
	document: EditDocument,
	media: EditingMediaView,
): PreviewPlan {
	editingDocumentSchema.parse(document);
	const map = cfrTimeMapSchema.parse(media.timeMap);
	if (
		media.state !== "READY" ||
		!media.url ||
		media.id !== document.mediaVersionId ||
		!media.width ||
		!media.height
	)
		throw new RangeError("Editing media unavailable");
	const clips = document.clips.map((clip) => {
		const from = timelinePoint(
			document,
			clip.timelineStartFrame,
			map,
		).sourceFrame;
		if (
			clip.sourceInUs < map.sourceStartUs ||
			clip.sourceInUs >= map.sourceEndUs ||
			from + clip.durationFrames > map.editingEndFrame
		)
			throw new RangeError("Source interval unavailable");
		return {
			clip,
			outputFrom: clip.timelineStartFrame,
			outputTo: clip.timelineStartFrame + clip.durationFrames,
			sourceFrom: from,
			sourceTo: from + clip.durationFrames,
		};
	});
	return {
		document,
		sourceKey: JSON.stringify([
			media.id,
			media.url,
			media.width,
			media.height,
			map,
		]),
		width: media.width,
		height: media.height,
		total: clips.reduce((sum, c) => sum + c.clip.durationFrames, 0),
		clips,
	};
}

export function previewLocation(plan: PreviewPlan, requested: number) {
	const frame = Math.max(
		0,
		Math.min(
			plan.total - 1,
			Math.round(Number.isFinite(requested) ? requested : 0),
		),
	);
	const clipIndex = plan.clips.findIndex((c) => frame < c.outputTo);
	const item = plan.clips[clipIndex];
	if (!item) throw new RangeError("Missing preview interval");
	const local = frame - item.outputFrom;
	const framing = item.clip.framing.find(
		(f) => local >= f.fromFrame && local < f.toFrame,
	);
	if (!framing) throw new RangeError("Missing preview framing");
	const { width, height } = plan.document.canvas;
	let geometry: {
		sx: number;
		sy: number;
		sw: number;
		sh: number;
		dx: number;
		dy: number;
		dw: number;
		dh: number;
	};
	if (framing.mode === "CROP") {
		// Keep the encoder's rounded edges, including odd-sized exact crops.
		const sx = Math.round(framing.rect.x * plan.width);
		const sy = Math.round(framing.rect.y * plan.height);
		const sw = Math.round((framing.rect.x + framing.rect.w) * plan.width) - sx;
		const sh = Math.round((framing.rect.y + framing.rect.h) * plan.height) - sy;
		if (sw < 1 || sh < 1) throw new RangeError("Empty crop");
		geometry = { sx, sy, sw, sh, dx: 0, dy: 0, dw: width, dh: height };
	} else {
		const dw = Math.max(
			2,
			Math.floor(
				Math.min(width, Math.round((height * plan.width) / plan.height)) / 2,
			) * 2,
		);
		const dh = Math.max(
			2,
			Math.floor(
				Math.min(height, Math.round((width * plan.height) / plan.width)) / 2,
			) * 2,
		);
		geometry = {
			sx: 0,
			sy: 0,
			sw: plan.width,
			sh: plan.height,
			// FFmpeg yuv420p padding rounds down to the chroma grid.
			dx: Math.floor((width - dw) / 4) * 2,
			dy: Math.floor((height - dh) / 4) * 2,
			dw,
			dh,
		};
	}
	return {
		frame,
		clipIndex,
		sourceFrame: item.sourceFrom + local,
		sourceSeconds: (item.sourceFrom + local) / 30,
		muted: item.clip.audio.mode === "MUTE",
		geometry,
	};
}
