import {
	cfrTimeMapSchema,
	type EditClip,
	type EditDocument,
	editingDocumentSchema,
	type NormalizedCropRect,
} from "./schema";
import { originalTimeToCfrFrame } from "./time";

export class ContentEditingError extends Error {
	constructor(
		public readonly code:
			| "TIME_MAP_MISMATCH"
			| "SOURCE_OUT_OF_BOUNDS"
			| "UNCONFIRMED_FRAMING",
	) {
		super(code);
		this.name = "ContentEditingError";
	}
}
export type RenderSegment = {
	clipId: string;
	editingStartFrame: number;
	editingEndFrame: number;
	timelineStartFrame: number;
	durationFrames: number;
	framing: { mode: "FIT" } | { mode: "CROP"; rect: NormalizedCropRect };
	audio: EditClip["audio"];
};
export type RenderRecipe = {
	schemaVersion: 1;
	compilerVersion: "content-editing-v1";
	mediaVersionId: string;
	timeMapId: string;
	canvas: EditDocument["canvas"];
	fps: EditDocument["fps"];
	durationFrames: number;
	segments: RenderSegment[];
};

/** Converts source presentation time to fixed material frames once, before rendering. */
export function compileEditDocument(
	input: unknown,
	inputMap: unknown,
): RenderRecipe {
	const document = editingDocumentSchema.parse(input);
	const map = cfrTimeMapSchema.parse(inputMap);
	if (
		document.mediaVersionId !== map.mediaVersionId ||
		document.timeMapId !== map.id
	) {
		throw new ContentEditingError("TIME_MAP_MISMATCH");
	}
	const segments: RenderSegment[] = [];
	for (const clip of document.clips) {
		if (
			clip.sourceInUs < map.sourceStartUs ||
			clip.sourceInUs >= map.sourceEndUs
		) {
			throw new ContentEditingError("SOURCE_OUT_OF_BOUNDS");
		}
		const startFrame =
			BigInt(map.editingStartFrame) +
			originalTimeToCfrFrame(clip.sourceInUs, map.sourceStartUs, "FLOOR");
		// Bounds follow the same snapped frame interval the renderer consumes.
		// A rational 30 fps boundary rounded up to integer microseconds may differ
		// by less than one microsecond without adding a source frame.
		if (
			startFrame + BigInt(clip.durationFrames) >
			BigInt(map.editingEndFrame)
		) {
			throw new ContentEditingError("SOURCE_OUT_OF_BOUNDS");
		}
		const editingStartFrame = Number(startFrame);
		for (const framing of clip.framing) {
			if (framing.origin === "AISA_PROPOSAL") {
				throw new ContentEditingError("UNCONFIRMED_FRAMING");
			}
			segments.push({
				clipId: clip.id,
				editingStartFrame: editingStartFrame + framing.fromFrame,
				editingEndFrame: editingStartFrame + framing.toFrame,
				timelineStartFrame: clip.timelineStartFrame + framing.fromFrame,
				durationFrames: framing.toFrame - framing.fromFrame,
				framing:
					framing.mode === "FIT"
						? { mode: "FIT" }
						: { mode: "CROP", rect: { ...framing.rect } },
				audio: { ...clip.audio },
			});
		}
	}
	return {
		schemaVersion: 1,
		compilerVersion: "content-editing-v1",
		mediaVersionId: document.mediaVersionId,
		timeMapId: document.timeMapId,
		canvas: document.canvas,
		fps: document.fps,
		durationFrames: document.clips.reduce(
			(sum, clip) => sum + clip.durationFrames,
			0,
		),
		segments,
	};
}
