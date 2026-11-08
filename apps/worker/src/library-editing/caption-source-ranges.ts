import { type CfrTimeMap, originalTimeToCfrFrame } from "@bitovp/core";
import { MediaOperationError } from "./process";

/** The source audio follows compiled CFR frames, not a sum of rounded durations. */
export function selectedCaptionAudioRanges(
	clips: readonly { sourceInUs: number; durationFrames: number }[],
	map: Pick<
		CfrTimeMap,
		"sourceStartUs" | "sourceEndUs" | "editingStartFrame" | "editingEndFrame"
	>,
) {
	const origin = BigInt(map.sourceStartUs);
	const sourceEnd = BigInt(map.sourceEndUs);
	const availableFrames =
		BigInt(map.editingEndFrame) - BigInt(map.editingStartFrame);
	const atFrame = (frame: bigint) => {
		const time = origin + (frame * 1_000_000n + 29n) / 30n;
		// A verified final CFR frame may extend past the source's actual audio.
		return Number(time < sourceEnd ? time : sourceEnd);
	};
	return clips.flatMap((clip) => {
		const from = originalTimeToCfrFrame(
			clip.sourceInUs,
			map.sourceStartUs,
			"FLOOR",
		);
		if (
			!Number.isSafeInteger(clip.durationFrames) ||
			clip.durationFrames < 1 ||
			from < 0n ||
			from + BigInt(clip.durationFrames) > availableFrames
		)
			throw new MediaOperationError("SOURCE_OUT_OF_BOUNDS");
		const startUs = atFrame(from);
		const endUs = atFrame(from + BigInt(clip.durationFrames));
		return endUs > startUs ? [{ startUs, endUs }] : [];
	});
}
