import { describe, expect, it } from "vitest";
import { encodingPlanSchema } from "../plan/schema";
import { validatePlan } from "../plan/validate";
import {
	normalizeVodInputTimelineDocument,
	overwriteVodInputTimelineTrack,
} from "../vod-input-timeline";
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
	it.each([
		"audio",
		"video",
	] as const)("lowers only the overwritten %s track into three parts", (track) => {
		const document = normalizeVodInputTimelineDocument({
			...sequence,
			clips: [
				{
					id: "00000000-0000-4000-8000-000000000002",
					sourceKey: "a",
					inMs: 0,
					outMs: 10_000,
				},
			],
		});
		const facts = ["a", "b"].map((key) => ({
			key,
			durationMs: 20_000,
			video: { streamIndex: 0, width: 1920, height: 1080 },
			audio: { streamIndex: 1, sampleRate: 48000, channels: 2 },
			identity: { size: 100, etag: '"fixed"' },
		}));
		const edited = overwriteVodInputTimelineTrack(
			document,
			{
				track,
				atMs: 2000,
				sourceKey: "b",
				inMs: 1000,
				outMs: 4000,
				id: "00000000-0000-4000-8000-000000000020",
				splitId: "00000000-0000-4000-8000-000000000021",
			},
			facts,
		);
		const plan = encodingPlanSchema.parse(
			buildPlan({ ...state, inputTimeline: edited }),
		);
		const changed = plan.concatenationStreams?.find((item) =>
			item.key.endsWith(track === "video" ? "v_sequence" : "a_sequence"),
		);
		const other = plan.concatenationStreams?.find((item) => item !== changed);
		expect(changed?.sources).toHaveLength(3);
		expect(other?.sources).toHaveLength(1);
		expect(
			plan.trimmingStreams
				?.filter((item) => item.kind === "TIME_BASED")
				.map((item) =>
					item.kind === "TIME_BASED" ? [item.offset, item.duration] : null,
				),
		).toEqual(
			track === "video"
				? [
						[0, 2],
						[1, 3],
						[5, 5],
						[0, 10],
					]
				: [
						[0, 10],
						[0, 2],
						[1, 3],
						[5, 5],
					],
		);
		expect(
			validatePlan(plan).filter((issue) => issue.level === "error"),
		).toEqual([]);
	});
	it("uses native black/silence padding up to exactly ten seconds and rejects a longer active gap", () => {
		const base = normalizeVodInputTimelineDocument({
			...sequence,
			clips: [
				{
					id: "00000000-0000-4000-8000-000000000002",
					sourceKey: "a",
					inMs: 0,
					outMs: 1000,
				},
			],
			audioEnabled: false,
		});
		const allowed = { ...base, durationMs: 11_000 };
		const plan = encodingPlanSchema.parse(
			buildPlan({ ...state, inputTimeline: allowed }),
		);
		expect(plan.concatenationStreams?.[0]?.sources[0]?.paddingAfter).toEqual({
			duration: 10,
			unit: "SECONDS",
		});
		expect(() =>
			buildPlan({
				...state,
				inputTimeline: { ...allowed, durationMs: 11_001 },
			}),
		).toThrowError(expect.objectContaining({ code: "TIMELINE_GAP_TOO_LONG" }));
	});
	it("omits empty audio instead of emitting an empty concat or dangling muxed audio", () => {
		const base = normalizeVodInputTimelineDocument(sequence);
		const plan = encodingPlanSchema.parse(
			buildPlan({ ...state, inputTimeline: { ...base, audioClips: [] } }),
		);
		expect(plan.concatenationStreams).toHaveLength(1);
		expect(plan.renditions).toHaveLength(1);
		expect(plan.renditions.every((item) => item.codec === "H264")).toBe(true);
		expect(plan.muxings[0]?.kind).toBe("MP4");
		expect(
			plan.muxings.every(
				(item) => item.kind !== "MP4" || !item.additionalStreamKeys?.length,
			),
		).toBe(true);
		expect(
			validatePlan(plan).filter((issue) => issue.level === "error"),
		).toEqual([]);
	});
	it("refuses a video-output program with no real video before native resources are created", () => {
		const base = normalizeVodInputTimelineDocument(sequence);
		expect(() =>
			buildPlan({ ...state, inputTimeline: { ...base, videoClips: [] } }),
		).toThrowError(expect.objectContaining({ code: "TIMELINE_VIDEO_MISSING" }));
	});
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
