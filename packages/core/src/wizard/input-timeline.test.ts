import { describe, expect, it } from "vitest";
import { encodingPlanSchema } from "../plan/schema";
import { validatePlan } from "../plan/validate";
import {
	buildPlan,
	DEFAULT_WIZARD_STATE,
	type WizardState,
} from "./build-plan";
import {
	applyVodInputTimeline,
	WizardInputTimelineError,
} from "./input-timeline";

const id = "00000000-0000-4000-8000-000000000001";
const state: WizardState = {
	...DEFAULT_WIZARD_STATE,
	name: "Manual sequence",
	accountId: id,
	inputFiles: ["a", "b"].map((key) => ({
		key,
		inputKey: "main",
		kind: "S3",
		credentialId: id,
		bucket: "input",
		path: `${key}.mov`,
	})),
	output: {
		...DEFAULT_WIZARD_STATE.output,
		credentialId: id,
		bucket: "output",
	},
	videos: [
		{
			codec: "H264",
			height: 720,
			bitrate: 1_000_000,
			muxing: {
				kind: "MP4",
				filename: "sequence.mp4",
				muxedAudioKeys: ["a128"],
			},
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
};
const sequence = {
	schemaVersion: 1 as const,
	id,
	audioEnabled: true,
	clips: [
		{
			id: "00000000-0000-4000-8000-000000000002",
			sourceKey: "a",
			inMs: 1200,
			outMs: 2400,
		},
		{
			id: "00000000-0000-4000-8000-000000000003",
			sourceKey: "b",
			inMs: 300,
			outMs: 2800,
		},
		{
			id: "00000000-0000-4000-8000-000000000004",
			sourceKey: "a",
			inMs: 0,
			outMs: 800,
		},
	],
};

describe("VOD manual input graph", () => {
	it("lowers A/B/A to identical video/audio ranges and explicit concat order", () => {
		const input = { ...state, inputTimeline: sequence };
		const snapshot = structuredClone(input);
		const plan = encodingPlanSchema.parse(buildPlan(input));
		expect(
			validatePlan(plan).filter((issue) => issue.level === "error"),
		).toEqual([]);
		expect(
			plan.trimmingStreams?.map((trim) =>
				trim.kind === "TIME_BASED" ? [trim.offset, trim.duration] : null,
			),
		).toEqual([
			[1.2, 1.2],
			[0.3, 2.5],
			[0, 0.8],
			[1.2, 1.2],
			[0.3, 2.5],
			[0, 0.8],
		]);
		expect(plan.concatenationStreams).toHaveLength(2);
		for (const concat of plan.concatenationStreams ?? []) {
			expect(
				concat.sources.map((part) => [part.position, part.isMain]),
			).toEqual([
				[0, true],
				[1, false],
				[2, false],
			]);
		}
		expect(plan.ingest.map((track) => track.selectionMode)).toEqual([
			"VIDEO_RELATIVE",
			"VIDEO_RELATIVE",
			"AUDIO_RELATIVE",
			"AUDIO_RELATIVE",
		]);
		expect(plan.renditions.map((rendition) => rendition.ingestKey)).toEqual(
			plan.concatenationStreams?.map((concat) => concat.key),
		);
		expect(plan.manifests).toEqual([]);
		expect(input).toEqual(snapshot);
	});
	it("keeps the ordinary wizard byte-identical when the timeline is absent", () => {
		expect(applyVodInputTimeline(state)).toBe(state);
		expect(buildPlan({ ...state, inputTimeline: undefined })).toEqual(
			buildPlan(state),
		);
	});
	it("does not fall back to the first file or overwrite an advanced graph", () => {
		const firstClip = sequence.clips[0];
		if (!firstClip) throw new Error("Fixture requires a first clip");
		expect(() =>
			buildPlan({
				...state,
				inputTimeline: {
					...sequence,
					clips: [{ ...firstClip, sourceKey: "missing" }],
				},
			}),
		).toThrow(WizardInputTimelineError);
		expect(() =>
			buildPlan({
				...state,
				sources: { encodings: [{ key: "other", name: "other" }] },
				inputTimeline: sequence,
			}),
		).toThrow(WizardInputTimelineError);
	});
	it("explicit video-only sequence removes audio renditions and retains native source graphs", () => {
		const plan = encodingPlanSchema.parse(
			buildPlan({
				...state,
				sources: {
					tracks: [
						{
							key: "existing",
							inputFile: "b",
							selectionMode: "VIDEO_RELATIVE",
							position: 0,
						},
					],
				},
				inputTimeline: { ...sequence, audioEnabled: false },
			}),
		);
		expect(plan.renditions).toHaveLength(1);
		expect(plan.ingest.some((track) => track.key === "existing")).toBe(true);
		expect(plan.concatenationStreams).toHaveLength(1);
		expect(
			validatePlan(plan).filter((issue) => issue.level === "error"),
		).toEqual([]);
	});
});
