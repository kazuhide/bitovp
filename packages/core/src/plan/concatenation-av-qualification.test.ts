import { describe, expect, it, vi } from "vitest";
import type { VodInputTimelinePlacedClip } from "../vod-input-timeline/contracts";
import {
	buildPlan,
	DEFAULT_WIZARD_STATE,
	type WizardState,
} from "../wizard/build-plan";
import { type EncodingPlan, encodingPlanSchema } from "./schema";
import { submitEncodingJob } from "./submit";
import { validatePlan } from "./validate";

const credentialId = "00000000-0000-4000-8000-000000000001";
const code = "PLAN_CONCATENATION_AV_UNQUALIFIED";
const clip = (
	n: number,
	sourceKey: string,
	startMs: number,
	inMs: number,
	outMs: number,
): VodInputTimelinePlacedClip => ({
	id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
	sourceKey,
	startMs,
	inMs,
	outMs,
});

function timelinePlan(aligned = false) {
	// The failed real 24-second qualification: five V1 sections, three A1
	// sections, with uninterrupted replacement audio beneath a two-second still.
	const videoClips = [
		clip(2, "bbb", 0, 10_000, 18_000),
		clip(3, "normalized", 8000, 0, 2000),
		clip(4, "still", 10_000, 0, 2000),
		clip(5, "normalized", 12_000, 4000, 8000),
		clip(6, "bbb", 16_000, 60_000, 68_000),
	];
	const document = {
		schemaVersion: 2 as const,
		id: credentialId,
		audioEnabled: true,
		durationMs: 24_000,
		videoClips,
		audioClips: aligned
			? structuredClone(videoClips)
			: [
					clip(7, "bbb", 0, 10_000, 18_000),
					clip(8, "normalized", 8000, 0, 8000),
					clip(9, "bbb", 16_000, 60_000, 68_000),
				],
	};
	const state: WizardState = {
		...structuredClone(DEFAULT_WIZARD_STATE),
		name: "Independent AV qualification",
		accountId: credentialId,
		inputFiles: ["bbb", "normalized", "still"].map((key) => ({
			key,
			inputKey: "source",
			kind: "S3",
			credentialId,
			bucket: "input",
			path: `${key}.mp4`,
		})),
		output: { ...DEFAULT_WIZARD_STATE.output, credentialId, bucket: "output" },
		videos: [
			{
				codec: "H264",
				height: 360,
				bitrate: 400_000,
				muxing: {
					kind: "MP4",
					filename: "sequence.mp4",
					muxedAudioKeys: ["a96"],
				},
			},
		],
		audios: [
			{
				codec: "AAC",
				bitrate: 96_000,
				rate: 48_000,
				muxing: { ownContainer: false },
			},
		],
		manifests: { hls: false, dash: false },
		inputTimeline: document,
	};
	const snapshot = structuredClone(document);
	const plan = encodingPlanSchema.parse(buildPlan(state));
	expect(document).toEqual(snapshot);
	return plan;
}

const qualificationIssues = (plan: EncodingPlan) =>
	validatePlan(plan).filter((issue) => issue.code === code);
const audioConcat = (plan: EncodingPlan) => {
	const result = plan.concatenationStreams.find((item) =>
		item.key.endsWith("a_sequence"),
	);
	if (!result) throw new Error("fixture audio concat is missing");
	return result;
};
const audioTrim = (plan: EncodingPlan) => {
	const result = plan.trimmingStreams.find((item) =>
		item.key.endsWith("a_clip_0"),
	);
	if (result?.kind !== "TIME_BASED")
		throw new Error("fixture audio trim is missing");
	return result;
};

describe("paired concatenation qualification before cloud billing", () => {
	it("withholds the actual five-video/three-audio programme without changing its edit graph", () => {
		const plan = timelinePlan();
		expect(
			plan.concatenationStreams.map((item) => item.sources.length),
		).toEqual([5, 3]);
		const snapshot = structuredClone(plan);
		expect(qualificationIssues(plan)).toContainEqual(
			expect.objectContaining({ code, level: "error" }),
		);
		expect(plan).toEqual(snapshot);
	});

	it("still withholds equal five-by-five durations when source offsets differ beneath the still", () => {
		const plan = timelinePlan(true);
		const still = plan.trimmingStreams.find((item) =>
			item.key.endsWith("a_clip_2"),
		);
		if (still?.kind !== "TIME_BASED")
			throw new Error("fixture still trim is missing");
		const normalized = plan.ingest.find((item) => item.key.endsWith("a_src_1"));
		if (!normalized) throw new Error("fixture normalized input is missing");
		still.sourceKey = normalized.key;
		still.offset = 2;
		expect(
			plan.concatenationStreams.map((item) => item.sources.length),
		).toEqual([5, 5]);
		expect(qualificationIssues(plan)).toHaveLength(1);
	});

	it.each([
		[
			"source file",
			(plan: EncodingPlan) => {
				const input = plan.ingest.find((item) => item.key.endsWith("a_src_0"));
				if (!input) throw new Error("fixture");
				input.inputPath = "replacement.mp4";
			},
		],
		[
			"offset",
			(plan: EncodingPlan) => {
				audioTrim(plan).offset = 11;
			},
		],
		[
			"duration",
			(plan: EncodingPlan) => {
				audioTrim(plan).duration = 7;
			},
		],
		[
			"position count",
			(plan: EncodingPlan) => {
				audioConcat(plan).sources.pop();
			},
		],
		[
			"padding before",
			(plan: EncodingPlan) => {
				const first = audioConcat(plan).sources[0];
				if (!first) throw new Error("fixture");
				first.paddingBefore = { duration: 1, unit: "SECONDS" };
			},
		],
		[
			"padding after",
			(plan: EncodingPlan) => {
				const first = audioConcat(plan).sources[0];
				if (!first) throw new Error("fixture");
				first.paddingAfter = { duration: 1, unit: "SECONDS" };
			},
		],
	] as const)("withholds a different paired %s programme", (_label, change) => {
		const plan = timelinePlan(true);
		change(plan);
		expect(qualificationIssues(plan)).toHaveLength(1);
	});

	it("accepts separate AV ingest selectors with the same physical source and cut programme", () => {
		const plan = timelinePlan(true);
		expect(
			validatePlan(plan).filter((issue) => issue.level === "error"),
		).toEqual([]);
	});

	it("compares ordered positions rather than JSON array order or input labels", () => {
		const plan = timelinePlan(true);
		audioConcat(plan).sources.reverse();
		const input = plan.inputs[0];
		if (!input) throw new Error("fixture");
		plan.inputs.push({ ...input, key: "same_storage", name: "Another label" });
		for (const ingest of plan.ingest)
			if (ingest.key.includes("_a_src_")) ingest.inputKey = "same_storage";
		expect(
			validatePlan(plan).filter((issue) => issue.level === "error"),
		).toEqual([]);
	});

	it("does not turn a known Dolby leaf into an unknown programme that bypasses qualification", () => {
		const plan = timelinePlan(true);
		const input = plan.ingest.find((item) => item.key.endsWith("a_src_0"));
		if (!input) throw new Error("fixture");
		plan.ingest = plan.ingest.filter((item) => item !== input);
		plan.dolbyStreams.push({
			key: input.key,
			kind: "ATMOS",
			inputKey: input.inputKey,
			inputPath: "other.adm",
			inputFormat: "ADM",
		});
		expect(qualificationIssues(plan)).toHaveLength(1);
	});

	it("withholds a concatenated picture paired with an unrelated ordinary audio stream", () => {
		const plan = timelinePlan(true);
		const audio = plan.renditions.find((item) => item.codec === "AAC");
		const input = plan.ingest.find((item) => item.key.endsWith("a_src_0"));
		if (!audio || !input) throw new Error("fixture");
		audio.ingestKey = input.key;
		expect(qualificationIssues(plan)).toHaveLength(1);
	});

	it("keeps existing malformed graph errors without recursing through cycles", () => {
		const plan = timelinePlan(true);
		const trim = audioTrim(plan);
		trim.sourceKey = trim.key;
		expect(validatePlan(plan)).toContainEqual(
			expect.objectContaining({
				code: "PLAN_TRIMMING_UNRESOLVED_SOURCE",
				level: "error",
			}),
		);
	});

	it("accepts the documented shared AV concatenation even with unused different graphs", () => {
		const plan = timelinePlan();
		const video = plan.renditions.find((item) => item.codec === "H264");
		const audio = plan.renditions.find((item) => item.codec === "AAC");
		if (!video || !audio) throw new Error("fixture");
		audio.ingestKey = video.ingestKey;
		expect(
			validatePlan(plan).filter((issue) => issue.level === "error"),
		).toEqual([]);
	});

	it("keeps ordinary independent AV sources without concatenation available", () => {
		const plan = timelinePlan();
		plan.concatenationStreams = [];
		plan.trimmingStreams = [];
		for (const rendition of plan.renditions) {
			const suffix = rendition.codec === "AAC" ? "a_src_1" : "v_src_0";
			const input = plan.ingest.find((item) => item.key.endsWith(suffix));
			if (!input) throw new Error("fixture");
			rendition.ingestKey = input.key;
		}
		expect(
			validatePlan(plan).filter((issue) => issue.level === "error"),
		).toEqual([]);
	});

	it.each([
		"H264",
		"AAC",
	])("does not impose AV pairing on %s-only output", (codec) => {
		const plan = timelinePlan();
		plan.renditions = plan.renditions.filter((item) => item.codec === codec);
		const rendition = plan.renditions[0];
		if (!rendition) throw new Error("fixture");
		plan.muxings = [
			{
				key: "only",
				kind: "MP4",
				streamKey: rendition.key,
				filename: "only.mp4",
				destination: { outputKey: "origin", path: "only" },
			},
		];
		expect(
			validatePlan(plan).filter((issue) => issue.level === "error"),
		).toEqual([]);
	});

	it("rejects the failed programme in the shared submit pipeline before job creation or enqueue", async () => {
		const createJob = vi.fn(async () => ({ id: "unused" }));
		const enqueue = vi.fn(async () => {});
		const result = await submitEncodingJob(timelinePlan(), {
			validationOptions: {},
			loadAccountDefaults: async () => ({ defaults: {} }),
			recordEgress: vi.fn(async () => {}),
			createJob,
			enqueue,
			markEnqueueFailed: vi.fn(async () => {}),
		});
		expect(result).toMatchObject({
			ok: false,
			code: "VALIDATION",
			issues: expect.arrayContaining([
				expect.objectContaining({ code, level: "error" }),
			]),
		});
		expect(createJob).not.toHaveBeenCalled();
		expect(enqueue).not.toHaveBeenCalled();
	});
});
