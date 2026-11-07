import { describe, expect, it } from "vitest";
import {
	buildAisaManagedCreateRequest,
	compileAisaManagedLiveChannel,
	isAisaManagedLivePlan,
	validateAisaManagedLivePlan,
} from "./aisa";
import { compileLiveChannel } from "./compiler";
import { compileLiveRunStepLog } from "./run-rebase";
import { liveChannelPlanSchema } from "./schema";
import { validateLiveChannel } from "./validate";

const accountId = "eeeeeeee-eeee-4eee-aeee-eeeeeeeeeeee";
const outputId = "cccccccc-cccc-4ccc-accc-cccccccccccc";
function managedPlan() {
	return {
		planVersion: 1,
		name: "Normal Live with AISA",
		bitmovin: {
			accountId,
			cloudRegion: "GOOGLE_EUROPE_WEST_1",
			encoderVersion: "2.291.0",
		},
		liveInput: { key: "main", kind: "RTMP" },
		outputs: [],
		ingest: [],
		renditions: [],
		muxings: [],
		liveManifests: [],
		start: {
			streamKey: "synthetickey",
			aiSceneAnalysisLive: {
				preset: "AISA_PREVIEW_MANAGED",
				outputId,
				recordingPath: "channel/recording",
				analysisPath: "channel/analysis",
			},
		},
	};
}

describe("the explicit AISA preset inside a normal Live plan", () => {
	it("accepts the explicit empty managed graph and validates it without normal ladder errors", () => {
		const plan = liveChannelPlanSchema.parse(managedPlan());
		expect(isAisaManagedLivePlan(plan)).toBe(true);
		expect(validateLiveChannel(plan)).toEqual([]);
	});
	it("accepts an empty shared stream key for managed HLS, while requiring a valid key for managed RTMP", () => {
		const raw = managedPlan();
		const hls = {
			...raw,
			liveInput: {
				key: "main",
				kind: "HLS",
				url: "https://example.invalid/live.m3u8",
			},
			start: { ...raw.start, streamKey: "" },
		};
		expect(liveChannelPlanSchema.safeParse(hls).success).toBe(true);
		expect(
			liveChannelPlanSchema.safeParse({
				...raw,
				start: { ...raw.start, streamKey: "" },
			}).success,
		).toBe(false);
	});
	it("keeps the empty-graph rejection for ordinary Live plans", () => {
		const input = managedPlan();
		const { aiSceneAnalysisLive: _, ...start } = input.start;
		expect(liveChannelPlanSchema.safeParse({ ...input, start }).success).toBe(
			false,
		);
	});
	it("never sends an AISA plan through the ordinary compiler", () => {
		const plan = liveChannelPlanSchema.parse(managedPlan());
		expect(() => compileLiveChannel(plan)).toThrow(/dedicated AISA/i);
	});
	it("compiles only the named Analysis lifecycle with an explicit provider Encoding resolution", () => {
		const plan = liveChannelPlanSchema.parse(managedPlan());
		const ops = compileAisaManagedLiveChannel(plan);
		expect(ops.map((op) => op.kind)).toEqual([
			"CREATE_AISA_LIVE_ANALYSIS",
			"RESOLVE_AISA_LIVE_ENCODING",
			"START_AISA_LIVE_ANALYSIS",
			"AWAIT_LIVE_RUNNING",
		]);
		expect(ops[1]?.refs).toEqual({ analysisId: "analysis" });
		expect(ops[2]?.refs).toEqual({
			analysisId: "analysis",
			encodingId: "encoding",
		});
		expect(ops.some((op) => op.kind === "CREATE_ENCODING")).toBe(false);
	});
	it("gives a re-air distinct recording/analysis paths within the normal run subtree", () => {
		const plan = liveChannelPlanSchema.parse(managedPlan());
		const first = compileLiveRunStepLog(plan, {
			seq: 1,
			runId: "11111111-1111-4111-a111-111111111111",
		});
		const second = compileLiveRunStepLog(plan, {
			seq: 2,
			runId: "22222222-2222-4222-a222-222222222222",
		});
		expect(first.outputPrefix).toBe("");
		expect(second.outputPrefix).toBe("channel/runs/2-22222222");
		const body = second.entries[0]?.payload.request as ReturnType<
			typeof buildAisaManagedCreateRequest
		>;
		expect(body.recording.outputs[0]?.outputPath).toBe(
			"channel/runs/2-22222222/recording",
		);
		expect(body.outputs[0]?.outputPath).toBe(
			"channel/runs/2-22222222/analysis",
		);
	});
	it.each([
		"outputs",
		"ingest",
		"renditions",
		"muxings",
		"liveManifests",
		"drm",
		"deliveryMirrors",
	])("rejects a supplied custom %s instead of ignoring it", (field) => {
		const raw = { ...managedPlan(), [field]: [{}] };
		expect(liveChannelPlanSchema.safeParse(raw).success).toBe(false);
		expect(
			validateAisaManagedLivePlan(raw as never).some(
				(issue) => issue.path === field,
			),
		).toBe(true);
	});
	it.each([
		"autoRestart",
		"autoShutdown",
		"reupload",
		"esam",
		"cacheControl",
		"adInsertion",
		"encodingOption",
		"liveEncodingMode",
	])("rejects unrepresentable start.%s", (field) => {
		const raw = {
			...managedPlan(),
			start: { ...managedPlan().start, [field]: {} },
		};
		expect(
			validateAisaManagedLivePlan(raw as never).some(
				(issue) => issue.path === `start.${field}`,
			),
		).toBe(true);
	});
	it.each([
		"staticIpId",
		"labels",
		"fallbackCloudRegions",
		"infrastructure",
	])("rejects unrepresentable bitmovin.%s", (field) => {
		const raw = {
			...managedPlan(),
			bitmovin: { ...managedPlan().bitmovin, [field]: "unsupported" },
		};
		expect(
			validateAisaManagedLivePlan(raw as never).some(
				(issue) => issue.path === `bitmovin.${field}`,
			),
		).toBe(true);
	});
	it("maps the shared input, account-independent fields and private output destinations exactly", () => {
		const plan = liveChannelPlanSchema.parse(managedPlan());
		expect(buildAisaManagedCreateRequest(plan)).toEqual({
			name: plan.name,
			input: { type: "RTMP", streamKey: "synthetickey" },
			cloudRegion: "GOOGLE_EUROPE_WEST_1",
			encoderVersion: "2.291.0",
			recording: {
				outputs: [
					{
						outputId,
						outputPath: "channel/recording",
						acl: [{ permission: "PRIVATE" }],
					},
				],
			},
			outputs: [
				{
					outputId,
					outputPath: "channel/analysis",
					acl: [{ permission: "PRIVATE" }],
				},
			],
		});
	});
	it("maps a selected RTMP input as a reference, rather than losing the selected resource", () => {
		const inputId = "dddddddd-dddd-4ddd-addd-dddddddddddd";
		const plan = liveChannelPlanSchema.parse({
			...managedPlan(),
			liveInput: { key: "main", kind: "RTMP", inputId },
		});
		expect(buildAisaManagedCreateRequest(plan).input).toEqual({
			type: "REFERENCE",
			inputId,
			streamKey: "synthetickey",
		});
	});
	it("preserves HLS URL and name while rejecting its unsupported marker setting", () => {
		const liveInput = {
			key: "main",
			kind: "HLS",
			name: "Selected source",
			url: "https://example.invalid/live.m3u8?sig=synthetic",
		};
		const plan = liveChannelPlanSchema.parse({ ...managedPlan(), liveInput });
		expect(buildAisaManagedCreateRequest(plan).input).toEqual({
			type: "HLS",
			name: liveInput.name,
			url: liveInput.url,
		});
		expect(
			liveChannelPlanSchema.safeParse({
				...managedPlan(),
				liveInput: { ...liveInput, adMarkersSource: "MANIFEST" },
			}).success,
		).toBe(false);
	});
	it("rejects unsupported source/region and inconsistent output paths", () => {
		expect(
			liveChannelPlanSchema.safeParse({
				...managedPlan(),
				bitmovin: { ...managedPlan().bitmovin, cloudRegion: "EXTERNAL" },
			}).success,
		).toBe(false);
		expect(
			liveChannelPlanSchema.safeParse({
				...managedPlan(),
				liveInput: { key: "main", kind: "SRT", mode: "LISTENER", port: 2088 },
			}).success,
		).toBe(false);
		const raw = managedPlan();
		raw.start.aiSceneAnalysisLive.analysisPath =
			raw.start.aiSceneAnalysisLive.recordingPath;
		expect(liveChannelPlanSchema.safeParse(raw).success).toBe(false);
	});
	it("refuses to build a request from an unsupported settings combination", () => {
		const raw = {
			...managedPlan(),
			start: {
				...managedPlan().start,
				esam: { poisEndpoint: "https://example.invalid" },
			},
		};
		expect(() => buildAisaManagedCreateRequest(raw as never)).toThrow(
			/unsupported/i,
		);
	});
});
