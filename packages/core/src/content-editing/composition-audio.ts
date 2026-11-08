import type { CompositionAudioTrack } from "./composition-schema";

export type CompositionAudioAutomation = {
	timelineStartFrame: number;
	durationFrames: number;
	gainDb: number;
	fadeInFrames: number;
	fadeOutFrames: number;
	fadeWindow?: { offsetFrames: number; durationFrames: number };
	transitionInFrames?: number;
	transitionOut?: { fromFrame: number; durationFrames: number };
	ducking?: CompositionAudioTrack["ducking"];
};
export const compositionRamp = (progress: number) =>
	Math.max(0, Math.min(1, progress));
export function compositionTransitionWeight(
	localFrame: number,
	durationFrames: number,
) {
	return durationFrames === 1
		? localFrame < 0
			? 0
			: 1
		: compositionRamp(localFrame / (durationFrames - 1));
}

/** Fractional frame values describe actual audio samples; no word/voice timing is inferred. */
export function compositionAudioGainAt(
	automation: CompositionAudioAutomation,
	outputFrame: number,
) {
	if (!Number.isFinite(outputFrame))
		throw new RangeError("Invalid audio evaluation time");
	const local = outputFrame - automation.timelineStartFrame;
	if (local < 0 || local >= automation.durationFrames) return 0;
	let gain = 10 ** (automation.gainDb / 20);
	const fadeFrame = local + (automation.fadeWindow?.offsetFrames ?? 0);
	const fadeDuration =
		automation.fadeWindow?.durationFrames ?? automation.durationFrames;
	if (automation.fadeInFrames)
		gain *= compositionRamp(fadeFrame / automation.fadeInFrames);
	if (automation.fadeOutFrames)
		gain *= compositionRamp(
			(fadeDuration - fadeFrame) / automation.fadeOutFrames,
		);
	if (automation.transitionInFrames)
		gain *= compositionTransitionWeight(local, automation.transitionInFrames);
	if (automation.transitionOut)
		gain *=
			1 -
			compositionTransitionWeight(
				outputFrame - automation.transitionOut.fromFrame,
				automation.transitionOut.durationFrames,
			);
	if (automation.ducking) {
		const duck = automation.ducking;
		const low = 10 ** (duck.gainDb / 20);
		let envelope = 1;
		for (const interval of duck.intervals) {
			let value = 1;
			if (outputFrame >= interval.fromFrame && outputFrame < interval.toFrame)
				value = low;
			else if (
				duck.attackFrames &&
				outputFrame < interval.fromFrame &&
				outputFrame >= interval.fromFrame - duck.attackFrames
			)
				value =
					1 +
					(low - 1) *
						compositionRamp(
							(outputFrame - interval.fromFrame + duck.attackFrames) /
								duck.attackFrames,
						);
			else if (
				duck.releaseFrames &&
				outputFrame >= interval.toFrame &&
				outputFrame < interval.toFrame + duck.releaseFrames
			)
				value =
					low +
					(1 - low) *
						compositionRamp(
							(outputFrame - interval.toFrame) / duck.releaseFrames,
						);
			envelope = Math.min(envelope, value);
		}
		gain *= envelope;
	}
	return gain;
}
