import {
	type AnyEditDocument,
	compositionDurationFrames,
	compositionVideoFit,
} from "@bitovp/core";
import { z } from "zod";

const frame = z.number().int().nonnegative();
const positiveFrame = frame.min(1);
const fit = z.enum(["AUTO", "FILL", "FIT"]);

export const storedEditingSettingsSchema = z.object({
	canvas: z.object({ width: positiveFrame, height: positiveFrame }),
	fps: z.object({ num: positiveFrame, den: positiveFrame }),
	durationFrames: positiveFrame,
	captionCount: frame,
	captionDisplayLanguage: z.enum(["ORIGINAL", "ja"]).optional(),
	captionPlacement: z.enum(["OVERLAY", "BANDS"]).optional(),
	audioTrackCount: frame,
	videoFit: fit.optional(),
	clips: z
		.array(
			z.object({
				id: z.uuid(),
				sourceNumber: positiveFrame,
				sourceInUs: frame,
				timelineStartFrame: frame,
				durationFrames: positiveFrame,
				audio: z.enum(["SOURCE", "MUTE"]),
				framing: z.array(z.enum(["FIT", "CROP"])).nonempty(),
				videoFit: fit.optional(),
			}),
		)
		.min(1)
		.max(20),
});

export type StoredEditingSettings = z.infer<typeof storedEditingSettingsSchema>;

/** Project only display settings. Neither source locators nor edit evidence belong here. */
export function storedEditingSettings(
	document: AnyEditDocument,
): StoredEditingSettings {
	const composition = document.schemaVersion === 2 ? document : undefined;
	const sourceIds = [
		document.mediaVersionId,
		...(composition?.sources ?? []).map((source) => source.mediaVersionId),
	];
	const clips = composition
		? composition.clips.map((clip) => ({
				...clip,
				sourceNumber:
					sourceIds.indexOf(clip.mediaVersionId ?? document.mediaVersionId) + 1,
				videoFit: compositionVideoFit(composition, clip),
			}))
		: document.clips.map((clip) => ({
				...clip,
				sourceNumber: 1,
				videoFit: undefined,
			}));
	return {
		canvas: document.canvas,
		fps: document.fps,
		durationFrames: composition
			? compositionDurationFrames(composition)
			: clips.reduce((sum, clip) => sum + clip.durationFrames, 0),
		captionCount: composition?.captions?.length ?? 0,
		captionDisplayLanguage: composition?.captionDisplayLanguage,
		captionPlacement: composition?.presentation?.captionPlacement,
		audioTrackCount: composition?.audioTracks?.length ?? 0,
		videoFit: composition?.presentation?.videoFit,
		clips: clips.map((clip) => ({
			id: clip.id,
			sourceNumber: clip.sourceNumber,
			sourceInUs: clip.sourceInUs,
			timelineStartFrame: clip.timelineStartFrame,
			durationFrames: clip.durationFrames,
			audio: clip.audio.mode,
			framing: [...new Set(clip.framing.map((part) => part.mode))],
			videoFit: clip.videoFit,
		})),
	};
}
