import { expect, it } from "vitest";
import {
	type CompositionAudioAutomation,
	compositionAudioGainAt,
} from "./composition-audio";

const base: CompositionAudioAutomation = {
	timelineStartFrame: 10,
	durationFrames: 90,
	gainDb: -6,
	fadeInFrames: 10,
	fadeOutFrames: 10,
};
it("evaluates continuous audio fades at the same output-frame boundaries", () => {
	expect(compositionAudioGainAt(base, 9)).toBe(0);
	expect(compositionAudioGainAt(base, 10)).toBe(0);
	expect(compositionAudioGainAt(base, 15)).toBeCloseTo(
		10 ** (-6 / 20) * 0.5,
		12,
	);
	expect(compositionAudioGainAt(base, 20)).toBeCloseTo(10 ** (-6 / 20), 12);
	expect(compositionAudioGainAt(base, 99)).toBeCloseTo(
		10 ** (-6 / 20) * 0.1,
		12,
	);
	expect(compositionAudioGainAt(base, 100)).toBe(0);
});
it("applies declared duck intervals with attack/release and minimum overlap gain", () => {
	const automation = {
		...base,
		gainDb: 0,
		fadeInFrames: 0,
		fadeOutFrames: 0,
		ducking: {
			gainDb: -12,
			attackFrames: 10,
			releaseFrames: 10,
			intervals: [
				{ fromFrame: 30, toFrame: 50 },
				{ fromFrame: 40, toFrame: 60 },
			],
		},
	};
	const low = 10 ** (-12 / 20);
	expect(compositionAudioGainAt(automation, 20)).toBe(1);
	expect(compositionAudioGainAt(automation, 25)).toBeCloseTo((1 + low) / 2, 12);
	expect(compositionAudioGainAt(automation, 45)).toBeCloseTo(low, 12);
	expect(compositionAudioGainAt(automation, 65)).toBeCloseTo((1 + low) / 2, 12);
	expect(compositionAudioGainAt(automation, 70)).toBe(1);
});
it("uses the same crossfade weights as discrete video frames", () => {
	const incoming = {
		...base,
		gainDb: 0,
		fadeInFrames: 0,
		fadeOutFrames: 0,
		transitionInFrames: 5,
	};
	const outgoing = {
		...base,
		timelineStartFrame: 0,
		durationFrames: 15,
		gainDb: 0,
		fadeInFrames: 0,
		fadeOutFrames: 0,
		transitionOut: { fromFrame: 10, durationFrames: 5 },
	};
	for (const frame of [10, 11, 12, 13, 14])
		expect(
			compositionAudioGainAt(incoming, frame) +
				compositionAudioGainAt(outgoing, frame),
		).toBeCloseTo(1, 12);
	expect(compositionAudioGainAt(incoming, 10)).toBe(0);
	expect(compositionAudioGainAt(incoming, 14)).toBe(1);
});
it("treats a one-frame crossfade as a cut only at its declared frame", () => {
	const automation = {
		...base,
		timelineStartFrame: 0,
		durationFrames: 15,
		gainDb: 0,
		fadeInFrames: 0,
		fadeOutFrames: 0,
		transitionOut: { fromFrame: 14, durationFrames: 1 },
	};
	expect(compositionAudioGainAt(automation, 13)).toBe(1);
	expect(compositionAudioGainAt(automation, 14)).toBe(0);
});
