import { describe, expect, it, vi } from "vitest";
import { compilePlan } from "./compiler";
import { encodingPlanSchema } from "./schema";
import { submitEncodingJob } from "./submit";
import { validatePlan } from "./validate";

// R43 request shape: only names/storage identities are replaced by local fixtures.
// No provider, database, queue or credential lookup is used by this regression.
function r43() {
	const destination = { outputKey: "origin", path: "qa/r43", acl: "PRIVATE" };
	return encodingPlanSchema.parse({
		planVersion: 1,
		name: "r43-regression",
		bitmovin: {
			accountId: "00000000-0000-4000-8000-000000000001",
			cloudRegion: "AWS_AP_NORTHEAST_1",
			encoderVersion: "2.284.0",
		},
		inputs: [
			{
				key: "main",
				kind: "S3",
				credentialId: "00000000-0000-4000-8000-000000000002",
				bucket: "fixture-input",
			},
		],
		outputs: [
			{
				key: "origin",
				kind: "GENERIC_S3",
				credentialId: "00000000-0000-4000-8000-000000000003",
				bucket: "fixture-output",
			},
		],
		ingest: [
			{
				key: "video",
				inputKey: "main",
				inputPath: "clip.mov",
				selectionMode: "VIDEO_RELATIVE",
				position: 0,
			},
			{
				key: "audio",
				inputKey: "main",
				inputPath: "clip.mov",
				selectionMode: "AUDIO_RELATIVE",
				position: 0,
			},
		],
		renditions: [
			{
				key: "v1080",
				ingestKey: "video",
				codec: "H264",
				width: 1920,
				height: 1080,
				bitrate: 4500000,
				presetConfiguration: "VOD_HIGH_QUALITY",
			},
			{
				key: "a128",
				ingestKey: "audio",
				codec: "AAC",
				bitrate: 128000,
				rate: 48000,
				channelLayout: "CL_STEREO",
			},
		],
		muxings: ["v1080", "a128"].map((key) => ({
			key,
			kind: "FMP4",
			streamKey: key,
			segmentLength: 6,
			segmentNaming: "segment_%number%.m4s",
			initSegmentName: "init.mp4",
			destination: { ...destination, path: `qa/r43/${key}` },
		})),
		manifests: [
			{
				key: "hls",
				kind: "HLS",
				manifestName: "stream.m3u8",
				destination,
				masterVersion: "HLS_V6",
				mediaVersion: "HLS_V6",
				audioGroupId: "audio",
				audioLanguage: "en",
				closedCaptions: "NONE",
				perTitleVariantUri: "AVG_BITRATE",
			},
		],
		generation: { timing: "POST_ENCODING", encodingMode: "THREE_PASS" },
	});
}
const conflict = "PLAN_ENCODING_MODE_PRESET_CONFLICT";
describe("preset mode cannot coexist with a START mode (R43 / provider 2025)", () => {
	it.each([
		"H264",
		"H265",
	])("rejects the provider-confirmed %s preset family", (codec) => {
		const plan = r43();
		const rendition = encodingPlanSchema.parse({
			...plan,
			renditions: [
				{
					key: "v1080",
					ingestKey: "video",
					codec,
					height: 1080,
					bitrate: 4500000,
					presetConfiguration: "VOD_HIGH_QUALITY",
				},
				plan.renditions[1],
			],
		}).renditions[0];
		if (!rendition) throw Error("fixture");
		plan.renditions[0] = rendition;
		expect(validatePlan(plan).map((i) => i.code)).toContain(conflict);
	});
	it("keeps VP9 presets rejected by the existing strict schema", () => {
		const plan = r43();
		expect(
			encodingPlanSchema.safeParse({
				...plan,
				renditions: [{ ...plan.renditions[0], codec: "VP9" }],
			}).success,
		).toBe(false);
	});
	it("rejects before job creation/enqueue/egress without rewriting quality intent", async () => {
		const plan = r43(),
			before = structuredClone(plan);
		const createJob = vi.fn(async () => ({ id: "local-only-job" })),
			enqueue = vi.fn(),
			recordEgress = vi.fn();
		const result = await submitEncodingJob(plan, {
			validationOptions: {},
			loadAccountDefaults: async () => ({ defaults: {} }),
			createJob,
			enqueue,
			recordEgress,
			markEnqueueFailed: vi.fn(),
		});
		expect(result).toMatchObject({
			ok: false,
			code: "VALIDATION",
			issues: expect.arrayContaining([
				expect.objectContaining({
					code: conflict,
					path: "generation.encodingMode",
				}),
			]),
		});
		expect(createJob).not.toHaveBeenCalled();
		expect(enqueue).not.toHaveBeenCalled();
		expect(recordEgress).not.toHaveBeenCalled();
		expect(plan).toEqual(before);
	});
	it("leaves default preset with omitted START mode unchanged", () => {
		const plan = r43();
		delete plan.generation.encodingMode;
		expect(validatePlan(plan).filter((i) => i.level === "error")).toEqual([]);
		const ops = compilePlan(plan);
		expect(
			ops.find((o) => o.kind === "CREATE_CODEC_H264")?.payload
				.presetConfiguration,
		).toBe("VOD_HIGH_QUALITY");
		expect(
			ops.find((o) => o.kind === "START_ENCODING")?.payload,
		).not.toHaveProperty("encodingMode");
	});
	it("preserves explicit START mode when the preset is absent", () => {
		const plan = r43();
		const video = plan.renditions[0];
		if (video?.codec !== "H264") throw Error("fixture");
		video.presetConfiguration = null;
		expect(validatePlan(plan).filter((i) => i.level === "error")).toEqual([]);
		const ops = compilePlan(plan);
		expect(
			ops.find((o) => o.kind === "CREATE_CODEC_H264")?.payload,
		).not.toHaveProperty("presetConfiguration");
		expect(
			ops.find((o) => o.kind === "START_ENCODING")?.payload.encodingMode,
		).toBe("THREE_PASS");
	});
	it.each([
		"STANDARD",
		"SINGLE_PASS",
		"TWO_PASS",
		"THREE_PASS",
	] as const)("also rejects %s rather than assuming equal modes may coexist", (mode) => {
		const plan = r43();
		plan.generation.encodingMode = mode;
		expect(validatePlan(plan).map((i) => i.code)).toContain(conflict);
	});
});
