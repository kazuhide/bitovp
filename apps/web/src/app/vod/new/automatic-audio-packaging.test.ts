import { describe, expect, it } from "vitest";
import { reconcileAutomaticAudioPackaging } from "./automatic-audio-packaging";
import {
	buildPlan,
	DEFAULT_WIZARD_STATE,
	type WizardState,
} from "./build-plan";

const initial = (): WizardState => ({
	...DEFAULT_WIZARD_STATE,
	videos: [
		{
			height: 360,
			bitrate: 800000,
			muxing: { kind: "TS", muxedAudioKeys: ["a128"] },
		},
	],
	audios: [{ bitrate: 128000, rate: 48000 }],
});

describe("automatic audio packaging across wizard steps", () => {
	it("restores automatic audio output when a new default fMP4 rendition is added", () => {
		const state = initial();
		state.audios = reconcileAutomaticAudioPackaging(state);
		expect(state.audios[0]?.muxing).toMatchObject({
			ownContainer: false,
			autoOwnContainer: true,
		});
		state.videos.push({ height: 720, bitrate: 1500000 });
		state.audios = reconcileAutomaticAudioPackaging(state);
		expect(state.audios[0]?.muxing?.ownContainer).toBeUndefined();
		expect(
			buildPlan(state).muxings.some((muxing) => muxing.streamKey === "a128"),
		).toBe(true);
	});
	it("preserves imported or manually disabled audio output without automatic provenance", () => {
		const state = initial();
		state.audios = state.audios.map((audio) => ({
			...audio,
			muxing: { ownContainer: false },
		}));
		state.videos.push({ height: 720, bitrate: 1500000 });
		expect(reconcileAutomaticAudioPackaging(state)[0]?.muxing).toEqual({
			ownContainer: false,
		});
	});
	it.each([
		{ kind: "TS" as const },
		{ path: "custom/audio" },
		{ filename: "sound.mp4" },
	])("preserves explicit primary audio configuration %j", (muxing) => {
		const state = initial();
		state.audios = state.audios.map((audio) => ({ ...audio, muxing }));
		expect(reconcileAutomaticAudioPackaging(state)[0]?.muxing).toEqual(muxing);
	});
	it("restores automatic output when its primary settings are customized later", () => {
		const state = initial();
		state.audios = reconcileAutomaticAudioPackaging(state);
		state.audios = state.audios.map((audio) => ({
			...audio,
			muxing: { ...audio.muxing, path: "custom/audio" },
		}));
		expect(reconcileAutomaticAudioPackaging(state)[0]?.muxing).toEqual({
			path: "custom/audio",
			ownContainer: undefined,
			autoOwnContainer: undefined,
		});
	});
	it("never emits wizard provenance into the encoding plan", () => {
		const state = initial();
		state.audios = reconcileAutomaticAudioPackaging(state);
		expect(JSON.stringify(buildPlan(state))).not.toContain("autoOwnContainer");
	});
});
