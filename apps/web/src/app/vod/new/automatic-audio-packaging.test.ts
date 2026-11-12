import { describe, expect, it } from "vitest";
import {
	followRenamedAudioKeys,
	reconcileAutomaticAudioPackaging,
} from "./automatic-audio-packaging";
import {
	audioKeys,
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

describe("audio keys carried by a video container", () => {
	const low = { bitrate: 128000, rate: 48000 };
	const high = { bitrate: 192000, rate: 48000 };
	const carrying = (...keys: string[]): WizardState["videos"] => [
		{
			height: 360,
			bitrate: 800000,
			muxing: { kind: "TS", muxedAudioKeys: keys },
			extraMuxings: [{ kind: "MP4", muxedAudioKeys: keys }],
		},
	];

	it("follow a bitrate edit, so the track stays inside the container", () => {
		const before = { videos: carrying("a128"), audios: [low] };
		const after = { ...before, audios: [high] };
		const state: WizardState = {
			...DEFAULT_WIZARD_STATE,
			...after,
			videos: followRenamedAudioKeys(before, after),
		};
		state.audios = reconcileAutomaticAudioPackaging(state);
		// Both containers of the rendition carry the track; none is made for it alone.
		expect(
			buildPlan(state).muxings.map((muxing) => [
				muxing.kind,
				muxing.streamKey,
				"additionalStreamKeys" in muxing
					? muxing.additionalStreamKeys
					: undefined,
			]),
		).toEqual([
			["TS", "v360", ["a192"]],
			["MP4", "v360", ["a192"]],
		]);
	});

	it("rename only the track that changed", () => {
		const before = { videos: carrying("a128", "a192"), audios: [low, high] };
		const after = {
			...before,
			audios: [low, { bitrate: 256000, rate: 48000 }],
		};
		expect(
			followRenamedAudioKeys(before, after).map((video) => [
				video.muxing?.muxedAudioKeys,
				video.extraMuxings?.map((leg) => leg.muxedAudioKeys),
			]),
		).toEqual([[["a128", "a256"], [["a128", "a256"]]]]);
	});

	it("keep the track a container carries while another bitrate is typed through its value", () => {
		// 640 kbps typed into the second row is "64000" for one keystroke: for that
		// moment both rows derive one key, and it names neither of them.
		const small = { bitrate: 64000, rate: 48000 };
		const typed = [6400, 64000, 640000].map((bitrate) => ({
			bitrate,
			rate: 48000,
		}));
		let state = { videos: carrying("a64"), audios: [small, high] };
		for (const second of typed) {
			const next = { ...state, audios: [small, second] };
			state = { ...next, videos: followRenamedAudioKeys(state, next) };
		}
		expect(audioKeys(state.audios)).toEqual(["a64", "a640"]);
		expect(
			state.videos.map((video) => [
				video.muxing?.muxedAudioKeys,
				video.extraMuxings?.map((leg) => leg.muxedAudioKeys),
			]),
		).toEqual([[["a64"], [["a64"]]]]);
	});

	it("leave a key two rows share where it is, whichever row is edited", () => {
		const twin = { bitrate: 128000, rate: 48000 };
		const before = {
			videos: carrying("a128_48000"),
			audios: [low, twin],
		};
		const after = { ...before, audios: [low, high] };
		expect(followRenamedAudioKeys(before, after)).toBe(after.videos);
	});

	it.each([
		[
			"a typed key, which the edit does not change",
			[{ ...low, extras: { key: "main" } }],
			[{ ...high, extras: { key: "main" } }],
		],
		["a removed track", [low, high], [high]],
		["an added track", [low], [low, high]],
		// The same keys in another order: which track a key means has not changed.
		["tracks that change places", [low, high], [high, low]],
	] satisfies [
		string,
		WizardState["audios"],
		WizardState["audios"],
	][])("leave the containers as they are for %s", (_case, from, to) => {
		const before = { videos: carrying("a128"), audios: from };
		const after = { ...before, audios: to };
		expect(followRenamedAudioKeys(before, after)).toBe(after.videos);
	});
});
