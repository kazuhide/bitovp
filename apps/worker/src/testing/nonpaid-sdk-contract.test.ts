import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	compileLiveChannel,
	compilePlan,
	type EncodingPlan,
	encodingPlanSchema,
	initStepLog,
	liveChannelPlanSchema,
} from "@bitovp/core";
import { describe, expect, it } from "vitest";
import {
	assertCompiledStart,
	assertSdkContract,
	type CapturedSdkRequests,
	captureSdkCreates,
	verifyNonpaidSdkContract,
} from "./nonpaid-sdk-contract";

const ACCOUNT = "33333333-3333-4333-8333-333333333333";
const CREDENTIAL = "44444444-4444-4444-8444-444444444444";
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const first = <T>(values: T[]): T => {
	const value = values[0];
	if (value === undefined) throw new Error("Missing fixture row");
	return value;
};

function fixture() {
	const load = (kind: "plan" | "live", name: string) =>
		JSON.parse(
			readFileSync(
				join(
					__dirname,
					`../../../../packages/core/src/${kind}/__fixtures__/${name}.plan.json`,
				),
				"utf8",
			),
		);
	const vod = load("plan", "fixed-bitrate-hls-on-aws");
	const live = load("live", "live-rtmp-simple");
	for (const manifest of live.liveManifests) {
		manifest.liveEdgeOffset = 0;
		if (manifest.kind === "HLS") manifest.insertProgramDateTime = false;
		else manifest.suggestedPresentationDelay = 0;
	}
	live.start.autoRestart = { restartOnEncoderError: false };
	vod.manifests.push({
		key: "dash",
		kind: "DASH",
		manifestName: "stream.mpd",
		name: "Synthetic DASH",
		destination: structuredClone(vod.manifests[0].destination),
		representationType: "TEMPLATE",
	});
	for (const plan of [vod, live]) {
		plan.bitmovin.accountId = ACCOUNT;
		for (const item of [...(plan.inputs ?? []), ...plan.outputs])
			item.credentialId = CREDENTIAL;
		plan.outputs.push({
			...plan.outputs[0],
			key: "mirror",
			bucket: "synthetic-mirror-bucket",
		});
		plan.deliveryMirrors = [{ outputKey: "mirror" }];
		Object.assign(plan.renditions[0], {
			level: "L4_1",
			minGop: 0,
			openGop: false,
			cabac: false,
			colorConfig: { copyColorSpaceFlag: false },
			hlsVariantUri: "main-video.m3u8",
		});
	}
	const vodPlan = json(encodingPlanSchema.parse(vod));
	const livePlan = json(liveChannelPlanSchema.parse(live));
	const submission = (id: string, plan: unknown) => ({
		id,
		requestPlan: json(plan),
		savedPlan: json(plan),
	});
	return {
		version: 1,
		vod: submission("55555555-5555-4555-8555-555555555555", vodPlan),
		live: submission("66666666-6666-4666-8666-666666666666", livePlan),
		database: {
			counts: { accounts: 1, credentials: 1, vod: 1, live: 1 },
			vod: [
				{
					id: "55555555-5555-4555-8555-555555555555",
					plan: vodPlan,
					stepLog: json(initStepLog(compilePlan(vodPlan))),
					status: "QUEUED",
					bitmovinEncodingId: null,
				},
			],
			live: [
				{
					id: "66666666-6666-4666-8666-666666666666",
					plan: livePlan,
					stepLog: json(initStepLog(compileLiveChannel(livePlan))),
					status: "CREATED",
					bitmovinEncodingId: null,
				},
			],
		},
	};
}

describe("nonpaid submission SDK contract", () => {
	it("checks persisted VOD and Live through the installed SDK without START", async () => {
		const original = globalThis.fetch;
		const result = await verifyNonpaidSdkContract(fixture());
		expect(result).toMatchObject({
			version: 1,
			status: "passed",
			providerRequests: 0,
			startRequests: 0,
		});
		expect(globalThis.fetch).toBe(original);
	});

	it("rejects a stored plan that differs from the authenticated response", async () => {
		const input = fixture();
		first(input.database.vod).plan.name = "different";
		await expect(verifyNonpaidSdkContract(input)).rejects.toThrow();
	});

	it("rejects an omitted optional value in the saved step log", async () => {
		const input = fixture();
		const codec = first(input.database.vod).stepLog.find(
			(step) => step.kind === "CREATE_CODEC_H264",
		);
		if (!codec) throw new Error("Missing codec fixture");
		delete codec.payload.openGop;
		await expect(verifyNonpaidSdkContract(input)).rejects.toThrow();
	});

	it("rejects evidence that a normal worker executed the queued job", async () => {
		const input = fixture();
		first(input.database.vod).status = "RUNNING";
		await expect(verifyNonpaidSdkContract(input)).rejects.toThrow();
	});

	it("restores fetch after an unsupported synthetic credential fails", async () => {
		const original = globalThis.fetch;
		await expect(
			captureSdkCreates([
				{
					step: "output:unsupported",
					kind: "CREATE_OUTPUT_AZURE",
					payload: { credentialId: CREDENTIAL },
					refs: {},
				},
			]),
		).rejects.toThrow("needs an AZURE_BLOB credential");
		expect(globalThis.fetch).toBe(original);
	});

	it("detects a dropped zero-valued Live start option without dispatching START", () => {
		const plan = liveChannelPlanSchema.parse(fixture().live.savedPlan);
		const operations = compileLiveChannel(plan);
		expect(() => assertCompiledStart(plan, operations)).not.toThrow();
		const start = operations.find(
			(operation) => operation.kind === "START_LIVE_ENCODING",
		);
		if (!start) throw new Error("Missing START fixture");
		const manifests = start.payload.hlsManifests as Record<
			string,
			Record<string, unknown>
		>;
		delete first(Object.values(manifests)).liveEdgeOffset;
		expect(() => assertCompiledStart(plan, operations)).toThrow();
	});

	const vodStart = (operations: ReturnType<typeof compilePlan>) => {
		const start = operations.find(
			(operation) => operation.kind === "START_ENCODING",
		);
		if (!start) throw new Error("Missing VOD START fixture");
		return start;
	};
	it.each([
		{
			name: "a false variable-FPS control",
			configure: (plan: EncodingPlan) => {
				plan.generation.handleVariableInputFps = false;
			},
		},
		{
			name: "a START encoding mode",
			configure: (plan: EncodingPlan) => {
				plan.generation.encodingMode = "TWO_PASS";
			},
		},
		{
			name: "an audio/video synchronization tweak",
			configure: (plan: EncodingPlan) => {
				plan.generation.audioVideoSyncMode = "RESYNC_AT_START";
			},
		},
		{
			name: "a zero scheduling priority",
			configure: (plan: EncodingPlan) => {
				plan.bitmovin.schedulingPriority = 0;
			},
		},
		{
			name: "prewarmed encoder pools",
			configure: (plan: EncodingPlan) => {
				plan.bitmovin.prewarmedEncoderPoolIds = ["synthetic-pool"];
			},
		},
		{
			name: "explicitly empty prewarmed encoder pools",
			configure: (plan: EncodingPlan) => {
				plan.bitmovin.prewarmedEncoderPoolIds = [];
			},
		},
		{
			name: "Per-Title settings",
			configure: (plan: EncodingPlan) => {
				plan.perTitle = { h264Configuration: { autoRepresentations: {} } };
			},
		},
		{
			name: "AI Scene Analysis settings",
			configure: (plan: EncodingPlan) => {
				plan.aiSceneAnalysis = {
					assetDescription: {
						filename: "analysis.json",
						destination: { outputKey: "origin", path: "synthetic-analysis/" },
					},
				};
			},
		},
	])("refuses unverified $name even if the compiler omits it", ({
		configure,
	}) => {
		const input = encodingPlanSchema.parse(fixture().vod.savedPlan);
		configure(input);
		const plan = encodingPlanSchema.parse(input);
		const operations = compilePlan(plan);
		// Simulate the same omission in persistence and re-compilation.
		vodStart(operations).payload = { manifestGenerator: "V2" };
		expect(() => assertCompiledStart(plan, operations)).toThrow(
			"The VOD fixture does not verify optional START settings",
		);
	});

	it.each([
		["handleVariableInputFps", false],
		["encodingMode", "TWO_PASS"],
		["tweaks", { audioVideoSyncMode: "RESYNC_AT_START" }],
		["scheduling", { priority: 0 }],
		["perTitle", { h264Configuration: { autoRepresentations: {} } }],
		["aiSceneAnalysis", {}],
		["unverifiedFutureOption", 0],
	])("rejects an unconfigured VOD START payload field %s", (field, value) => {
		const plan = encodingPlanSchema.parse(fixture().vod.savedPlan);
		const operations = compilePlan(plan);
		vodStart(operations).payload[String(field)] = value;
		expect(() => assertCompiledStart(plan, operations)).toThrow();
	});

	it("continues to allow settings owned by encoding and codec creation", () => {
		const plan = encodingPlanSchema.parse(fixture().vod.savedPlan);
		plan.bitmovin.cloudRegion = "AUTO";
		plan.bitmovin.fallbackCloudRegions = ["AWS_US_EAST_1"];
		plan.bitmovin.labels = ["synthetic-label"];
		const video = plan.renditions.find(
			(rendition) => rendition.codec === "H264",
		);
		if (!video) throw new Error("Missing H264 fixture");
		video.encodingMode = "TWO_PASS";
		expect(() => assertCompiledStart(plan, compilePlan(plan))).not.toThrow();
	});

	it("rejects an unconfigured VOD START reference outside manifest generation", () => {
		const plan = encodingPlanSchema.parse(fixture().vod.savedPlan);
		const operations = compilePlan(plan);
		vodStart(operations).refs.aiAssetDescriptionOutputId = "output:origin";
		expect(() => assertCompiledStart(plan, operations)).toThrow();
	});
	it.each([
		{
			name: "a missing JIT manifest generator",
			mutate: (start: ReturnType<typeof vodStart>) => {
				delete start.payload.manifestGenerator;
			},
		},
		{
			name: "a different JIT manifest generator",
			mutate: (start: ReturnType<typeof vodStart>) => {
				start.payload.manifestGenerator = "V1";
			},
		},
		{
			name: "missing VOD HLS references",
			mutate: (start: ReturnType<typeof vodStart>) => {
				delete start.refs.vodHlsManifestIds;
			},
		},
		{
			name: "missing VOD DASH references",
			mutate: (start: ReturnType<typeof vodStart>) => {
				delete start.refs.vodDashManifestIds;
			},
		},
		{
			name: "VOD HLS references bound to DASH",
			mutate: (start: ReturnType<typeof vodStart>) => {
				start.refs.vodHlsManifestIds = ["manifest:dash"];
			},
		},
		{
			name: "an extra VOD manifest reference",
			mutate: (start: ReturnType<typeof vodStart>) => {
				start.refs.vodDashManifestIds = ["manifest:dash", "manifest:hls"];
			},
		},
		{
			name: "unrequested preview references",
			mutate: (start: ReturnType<typeof vodStart>) => {
				start.refs.previewHlsManifestIds = ["manifest:hls"];
			},
		},
		{
			name: "a START bound to the wrong encoding",
			mutate: (start: ReturnType<typeof vodStart>) => {
				start.refs.encodingId = "output:origin";
			},
		},
	])("detects $name without dispatching VOD START", ({ mutate }) => {
		const plan = encodingPlanSchema.parse(fixture().vod.savedPlan);
		const operations = compilePlan(plan);
		expect(() => assertCompiledStart(plan, operations)).not.toThrow();
		mutate(vodStart(operations));
		expect(() => assertCompiledStart(plan, operations)).toThrow();
	});

	it.each([
		"liveHlsManifestIds",
		"liveDashManifestIds",
		"encodingId",
	])("detects a missing Live %s binding without dispatching START", (reference) => {
		const plan = liveChannelPlanSchema.parse(fixture().live.savedPlan);
		const operations = compileLiveChannel(plan);
		expect(() => assertCompiledStart(plan, operations)).not.toThrow();
		const start = operations.find(
			(operation) => operation.kind === "START_LIVE_ENCODING",
		);
		if (!start) throw new Error("Missing Live START fixture");
		delete start.refs[reference];
		expect(() => assertCompiledStart(plan, operations)).toThrow();
	});

	it.each([
		{
			name: "manifest generator",
			mutate: (start: ReturnType<typeof vodStart>) => {
				start.payload.manifestGenerator = "V2";
			},
		},
		{
			name: "HLS references",
			mutate: (start: ReturnType<typeof vodStart>) => {
				start.refs.vodHlsManifestIds = ["manifest:hls"];
			},
		},
	])("rejects unexpected $name for post-encoding manifests", ({ mutate }) => {
		const plan = encodingPlanSchema.parse(fixture().vod.savedPlan);
		plan.generation.timing = "POST_ENCODING";
		const operations = compilePlan(plan);
		expect(() => assertCompiledStart(plan, operations)).not.toThrow();
		mutate(vodStart(operations));
		expect(() => assertCompiledStart(plan, operations)).toThrow();
	});

	it("keeps VOD and preview manifest placement separate", () => {
		const plan = encodingPlanSchema.parse(fixture().vod.savedPlan);
		for (const manifest of plan.manifests) {
			if (manifest.kind === "HLS") manifest.jitPlacement = "PREVIEW";
			if (manifest.kind === "DASH") manifest.jitPlacement = "VOD_AND_PREVIEW";
		}
		const operations = compilePlan(plan);
		expect(() => assertCompiledStart(plan, operations)).not.toThrow();
		const start = vodStart(operations);
		expect(start.refs).toMatchObject({
			previewHlsManifestIds: ["manifest:hls"],
			vodDashManifestIds: ["manifest:dash"],
			previewDashManifestIds: ["manifest:dash"],
		});
		expect(start.refs).not.toHaveProperty("vodHlsManifestIds");
		start.refs.vodHlsManifestIds = ["manifest:hls"];
		expect(() => assertCompiledStart(plan, operations)).toThrow();
	});

	const body = (captured: CapturedSdkRequests, step: string) => {
		const found = captured.requests.find(
			(request) => request.step === step && request.method === "POST",
		);
		if (!found) throw new Error("Missing captured request");
		return found.body;
	};
	it.each([
		{
			name: "a lost codec level",
			mutate: (captured: CapturedSdkRequests) => {
				delete body(captured, "codec:v360").level;
			},
		},
		{
			name: "a lost false value",
			mutate: (captured: CapturedSdkRequests) => {
				delete body(captured, "codec:v360").openGop;
			},
		},
		{
			name: "a lost zero value",
			mutate: (captured: CapturedSdkRequests) => {
				delete body(captured, "codec:v360").minGop;
			},
		},
		{
			name: "an invented unset value",
			mutate: (captured: CapturedSdkRequests) => {
				body(captured, "codec:v360").width = 640;
			},
		},
		{
			name: "an enum name instead of its wire value",
			mutate: (captured: CapturedSdkRequests) => {
				body(captured, "codec:a128").channelLayout = "CL_STEREO";
			},
		},
		{
			name: "an HLS enum name instead of its wire value",
			mutate: (captured: CapturedSdkRequests) => {
				body(captured, "manifest:hls").hlsMasterPlaylistVersion = "HLS_V4";
			},
		},
		{
			name: "a mirror bound to the primary output",
			mutate: (captured: CapturedSdkRequests) => {
				const outputs = body(captured, "muxing:v360").outputs as Record<
					string,
					unknown
				>[];
				const mirror = outputs[1];
				if (!mirror) throw new Error("Missing mirror fixture");
				mirror.outputId = first(outputs).outputId;
			},
		},
		{
			name: "a changed HLS variant URI",
			mutate: (captured: CapturedSdkRequests) => {
				body(captured, "hls-variant:hls:v360").uri = "different.m3u8";
			},
		},
		{
			name: "a stream bound to another codec configuration",
			mutate: (captured: CapturedSdkRequests) => {
				body(captured, "stream:v360").codecConfigId = "wrong-codec";
			},
		},
	])("detects $name after actual SDK serialization", async ({ mutate }) => {
		const plan = encodingPlanSchema.parse(fixture().vod.savedPlan);
		const captured = await captureSdkCreates(compilePlan(plan));
		expect(() => assertSdkContract(plan, captured)).not.toThrow();
		mutate(captured);
		expect(() => assertSdkContract(plan, captured)).toThrow();
	});
});
