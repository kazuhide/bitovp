import { beforeEach, expect, it } from "vitest";
import {
	buildPlan,
	DEFAULT_WIZARD_STATE,
	type WizardState,
} from "@/app/vod/new/build-plan";
import {
	mergeWizardDraft,
	readWizardDraft,
	writeWizardDraft,
} from "./wizard-draft";

/**
 * A browser draft is an ALLOWLIST: a field the projection does not name is
 * dropped on save, silently. `startOffset` is the one field the whole-file TS
 * container added to the muxing shape, so without its entry a reload would
 * hand back a form that looks the same and builds a different plan.
 */

beforeEach(() => localStorage.clear());

const fileState = (): WizardState =>
	({
		...DEFAULT_WIZARD_STATE,
		videos: [
			{
				height: 360,
				bitrate: 800000,
				codec: "H264",
				muxing: {
					kind: "PROGRESSIVE_TS",
					filename: "movie.ts",
					segmentLength: 8,
					// Zero is the value most likely to be lost to a truthiness test.
					startOffset: 0,
					muxedAudioKeys: ["a128"],
				},
				extraMuxings: [
					{
						kind: "PROGRESSIVE_MOV",
						key: "v360-mov",
						filename: "movie.mov",
						path: "files",
					},
				],
			},
		],
		audios: [
			{
				codec: "AAC",
				bitrate: 128000,
				rate: 48000,
				muxing: { ownContainer: false },
			},
		],
		manifests: { hls: false, dash: false },
	}) as WizardState;

function reload(state: WizardState): WizardState {
	writeWizardDraft("file-output", "vod", state, 2);
	const draft = readWizardDraft("file-output", "vod");
	if (!draft) throw new Error("Missing file-output draft");
	return mergeWizardDraft(DEFAULT_WIZARD_STATE, draft.value, "vod");
}

it("restores both whole-file kinds with every field the form set", () => {
	const state = fileState();
	const restored = reload(state);
	expect(restored.videos[0]?.muxing).toEqual(state.videos[0]?.muxing);
	expect(restored.videos[0]?.extraMuxings).toEqual(
		state.videos[0]?.extraMuxings,
	);
});

it("builds the same plan after a reload", () => {
	const state = fileState();
	const before = buildPlan(state).muxings;
	expect(before).toMatchObject([
		{ kind: "PROGRESSIVE_TS", segmentLength: 8, startOffset: 0 },
		{ kind: "PROGRESSIVE_MOV", filename: "movie.mov" },
	]);
	expect(buildPlan(reload(state)).muxings).toEqual(before);
});

it("restores a WebM file with the Opus track still inside it, and builds the same plan", () => {
	// The kind added no field of its own: `kind`, `filename` and the carried
	// track were on the list already. This is the evidence that they are enough.
	const state = {
		...DEFAULT_WIZARD_STATE,
		videos: [
			{
				height: 360,
				bitrate: 800000,
				codec: "VP9",
				muxing: {
					kind: "PROGRESSIVE_WEBM",
					filename: "movie.webm",
					muxedAudioKeys: ["a128"],
				},
			},
		],
		audios: [
			{
				codec: "OPUS",
				bitrate: 128000,
				rate: 48000,
				muxing: { ownContainer: false },
			},
		],
		manifests: { hls: false, dash: false },
	} as WizardState;
	const restored = reload(state);
	expect(restored.videos[0]?.muxing).toEqual(state.videos[0]?.muxing);
	const before = buildPlan(state).muxings;
	expect(before).toEqual([
		expect.objectContaining({
			kind: "PROGRESSIVE_WEBM",
			filename: "movie.webm",
			additionalStreamKeys: ["a128"],
		}),
	]);
	expect(buildPlan(restored).muxings).toEqual(before);
	expect(buildPlan(restored).renditions).toEqual(buildPlan(state).renditions);
});

it("the counterfactual — a muxing field the projection does not name is dropped", () => {
	// Proves the arms above pass because `startOffset` is on the list, not
	// because the draft keeps whatever it is handed.
	const state = fileState();
	const video = state.videos[0];
	if (!video?.muxing) throw new Error("Fixture missing its muxing");
	(video.muxing as Record<string, unknown>).notAMuxingField = 10;
	const restored = reload(state);
	expect(restored.videos[0]?.muxing).not.toHaveProperty("notAMuxingField");
	expect(restored.videos[0]?.muxing).toMatchObject({ startOffset: 0 });
});
