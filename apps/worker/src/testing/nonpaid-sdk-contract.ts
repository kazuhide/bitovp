import assert from "node:assert/strict";
import { LevelH264, LevelH265 } from "@bitmovin/api-sdk";
import {
	type CompiledOperation,
	compileLiveChannel,
	compilePlan,
	type EncodingPlan,
	encodingPlanSchema,
	initStepLog,
	type LiveChannelPlan,
	liveChannelPlanSchema,
	validateLiveChannel,
	validatePlan,
} from "@bitovp/core";
import { executeStep } from "../orchestrator/executor";
import { createBitmovinSdkOps } from "../orchestrator/sdk-ops";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => {
	assert(value !== null && typeof value === "object" && !Array.isArray(value));
	return value as ObjectValue;
};
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const SYNTHETIC_KEY = "nonpaid-synthetic-only";
const MANIFEST_REFS = [
	"vodHlsManifestIds",
	"vodDashManifestIds",
	"vodSmoothManifestIds",
	"previewHlsManifestIds",
	"previewDashManifestIds",
	"liveHlsManifestIds",
	"liveDashManifestIds",
] as const;

export type CapturedRequest = {
	step: string;
	method: "GET" | "POST";
	path: string;
	body: ObjectValue;
};

export type CapturedSdkRequests = {
	requests: CapturedRequest[];
	ids: Map<string, string>;
};

/** Uses the installed SDK's serializer; the replacement never calls native fetch. */
export async function captureSdkCreates(
	operations: CompiledOperation[],
): Promise<CapturedSdkRequests> {
	const requests: CapturedRequest[] = [];
	const ids = new Map<string, string>();
	let currentStep = "";
	const original = globalThis.fetch;
	globalThis.fetch = async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		assert.equal(url.origin, "https://api.bitmovin.com");
		assert(url.pathname.startsWith("/v1/encoding/"));
		assert(!/\/(?:start|stop)(?:\/|$)/.test(url.pathname));
		const method = init?.method ?? "GET";
		assert(method === "GET" || method === "POST");
		assert.equal(new Headers(init?.headers).get("X-Api-Key"), SYNTHETIC_KEY);
		requests.push({
			step: currentStep,
			method,
			path: url.pathname,
			body: init?.body ? object(JSON.parse(String(init.body))) : {},
		});
		const result =
			method === "POST"
				? { id: `synthetic-resource-${requests.length}` }
				: {
						items:
							url.pathname === "/v1/encoding/inputs/rtmp"
								? [{ id: "synthetic-rtmp-input" }]
								: [],
						totalCount: url.pathname === "/v1/encoding/inputs/rtmp" ? 1 : 0,
					};
		return new Response(JSON.stringify({ data: { result } }), {
			status: method === "POST" ? 201 : 200,
			headers: { "content-type": "application/json" },
		});
	};
	try {
		const sdk = createBitmovinSdkOps({ apiKey: SYNTHETIC_KEY }, async () => {});
		for (const operation of operations) {
			if (!operation.kind.startsWith("CREATE_")) continue;
			currentStep = operation.step;
			const result = await executeStep(operation, {
				sdk,
				ids,
				resolveCredential: async () => ({
					provider: "AWS_S3",
					config: {},
					secret: {
						accessKeyId: "synthetic-access-key",
						secretAccessKey: "synthetic-secret-key",
					},
				}),
				poll: {
					intervalMs: 1,
					timeoutMs: 1,
					sleep: async () => {
						throw new Error("Polling is outside this nonpaid contract");
					},
				},
			});
			if (result.resourceId) ids.set(operation.step, result.resourceId);
		}
	} finally {
		globalThis.fetch = original;
	}
	return { requests, ids };
}

function copyFields(
	actual: ObjectValue,
	expected: ObjectValue,
	fields: readonly string[],
) {
	for (const field of fields) {
		const value = expected[field];
		if (value === undefined || value === null)
			assert(!Object.hasOwn(actual, field), "An unset field reached the SDK");
		else
			assert.deepEqual(actual[field], value, "A plan value changed at the SDK");
	}
}

/** START is inspected as data only; this suite never dispatches it. */
export function assertCompiledStart(
	plan: EncodingPlan | LiveChannelPlan,
	operations: CompiledOperation[],
) {
	const live = "liveManifests" in plan;
	const starts = operations.filter(
		(operation) =>
			operation.kind === (live ? "START_LIVE_ENCODING" : "START_ENCODING"),
	);
	assert.equal(starts.length, 1);
	const start = starts[0];
	assert(start);
	if (!live) {
		// This VOD fixture qualifies manifest generation only. Add independent
		// assertions before using fixtures with any other START settings.
		const unverified =
			"The VOD fixture does not verify optional START settings";
		assert.deepEqual(
			plan.generation,
			{ timing: plan.generation.timing },
			unverified,
		);
		for (const setting of [
			plan.perTitle,
			plan.aiSceneAnalysis,
			plan.bitmovin.schedulingPriority,
			plan.bitmovin.prewarmedEncoderPoolIds,
		])
			assert.equal(setting, undefined, unverified);
		const encoding = plan.encodings?.[0];
		const encodingId = encoding ? `encoding:${encoding.key}` : "encoding";
		const jit = plan.generation.timing === "JUST_IN_TIME";
		assert.deepEqual(
			start.payload,
			jit ? { manifestGenerator: "V2" } : {},
			"Unexpected VOD START payload",
		);
		const expected: Record<string, string[]> = {};
		if (jit && !plan.qc?.only)
			for (const manifest of plan.manifests) {
				const reference = `manifest:${manifest.key}`;
				const include = (family: string) => {
					const references = expected[family] ?? [];
					references.push(reference);
					expected[family] = references;
				};
				if (manifest.kind === "SMOOTH") {
					include("vodSmoothManifestIds");
					continue;
				}
				const family = manifest.kind === "HLS" ? "Hls" : "Dash";
				if (manifest.jitPlacement !== "PREVIEW")
					include(`vod${family}ManifestIds`);
				if (
					manifest.jitPlacement === "PREVIEW" ||
					manifest.jitPlacement === "VOD_AND_PREVIEW"
				)
					include(`preview${family}ManifestIds`);
			}
		assert.deepEqual(start.refs, { encodingId, ...expected });
		return;
	}
	assert.equal(start.refs.encodingId, "encoding");
	const hls = plan.liveManifests
		.filter((manifest) => manifest.kind === "HLS")
		.map((manifest) => `manifest:${manifest.key}`);
	const dash = plan.liveManifests
		.filter((manifest) => manifest.kind === "DASH")
		.map((manifest) => `manifest:${manifest.key}`);
	copyFields(
		start.refs,
		{
			liveHlsManifestIds: hls.length ? hls : undefined,
			liveDashManifestIds: dash.length ? dash : undefined,
		},
		MANIFEST_REFS,
	);
	copyFields(
		start.payload,
		{
			streamKey: plan.start.streamKey,
			liveEncodingMode: plan.start.liveEncodingMode,
			reuploadSettings: plan.start.reupload,
			autoRestartConfiguration: plan.start.autoRestart,
			autoShutdownConfiguration: plan.start.autoShutdown,
		},
		[
			"streamKey",
			"liveEncodingMode",
			"reuploadSettings",
			"autoRestartConfiguration",
			"autoShutdownConfiguration",
		],
	);
	assert.equal(start.payload.manifestGenerator, "V2");
	for (const manifest of plan.liveManifests) {
		const manifests = object(
			start.payload[manifest.kind === "HLS" ? "hlsManifests" : "dashManifests"],
		);
		const options = object(manifests[manifest.key]);
		copyFields(options, manifest, ["timeshift", "liveEdgeOffset"]);
		copyFields(
			options,
			manifest,
			manifest.kind === "HLS"
				? ["insertProgramDateTime", "programDateTimeSettings"]
				: ["suggestedPresentationDelay", "minimumUpdatePeriod"],
		);
	}
}

/** Expectations come from the submitted plan, independently of compiler payloads. */
export function assertSdkContract(
	plan: EncodingPlan | LiveChannelPlan,
	captured: CapturedSdkRequests,
) {
	const { requests, ids } = captured;
	const resourceId = (step: string) => {
		const id = ids.get(step);
		assert(id, "A created resource is missing its synthetic id");
		return id;
	};
	const post = (step: string) => {
		const matches = requests.filter(
			(request) => request.step === step && request.method === "POST",
		);
		assert.equal(matches.length, 1, "A resource must have one captured CREATE");
		const request = matches[0];
		assert(request);
		return request;
	};
	for (const output of plan.outputs) {
		const request = post(`output:${output.key}`);
		assert.equal(
			output.kind,
			"S3",
			"The offline fixture uses synthetic S3 only",
		);
		assert.equal(request.path, "/v1/encoding/outputs/s3");
		assert.equal(request.body.bucketName, output.bucket);
		assert.equal(request.body.accessKey, "synthetic-access-key");
		assert.equal(request.body.secretKey, "synthetic-secret-key");
	}
	if ("inputs" in plan)
		for (const input of plan.inputs) {
			const request = post(`input:${input.key}`);
			assert.equal(
				input.kind,
				"S3",
				"The offline fixture uses synthetic S3 only",
			);
			assert.equal(request.path, "/v1/encoding/inputs/s3");
			assert.equal(request.body.bucketName, input.bucket);
		}
	for (const rendition of plan.renditions) {
		const config = post(`codec:${rendition.key}`);
		assert.equal(
			config.path,
			`/v1/encoding/configurations/${rendition.codec === "AAC" ? "audio" : "video"}/${rendition.codec.toLowerCase()}`,
		);
		const body = config.body;
		const raw = rendition as unknown as ObjectValue;
		copyFields(body, raw, ["width", "height", "bitrate", "rate"]);
		if (rendition.codec === "H264" || rendition.codec === "H265") {
			if (rendition.level == null) {
				assert(!Object.hasOwn(body, "level"), "An unset level reached the SDK");
			} else {
				const levels = rendition.codec === "H264" ? LevelH264 : LevelH265;
				assert(Object.hasOwn(levels, rendition.level));
				assert.equal(
					body.level,
					(levels as Record<string, string>)[rendition.level],
					"A codec level changed at the SDK",
				);
			}
			copyFields(body, raw, [
				"minGop",
				"maxGop",
				"openGop",
				"crf",
				"minBitrate",
				"maxBitrate",
				"bufsize",
				"colorConfig",
			]);
			if (rendition.codec === "H264")
				copyFields(body, raw, ["cabac", "profile", "presetConfiguration"]);
		}
		if (rendition.codec === "AAC" && rendition.channelLayout === "CL_STEREO")
			assert.equal(body.channelLayout, "STEREO");
		const stream = post(`stream:${rendition.key}`).body;
		assert.equal(stream.codecConfigId, resourceId(`codec:${rendition.key}`));
		const selection = plan.ingest.find(
			(item) => item.key === rendition.ingestKey,
		);
		assert(selection);
		const streamInputs = stream.inputStreams;
		assert(Array.isArray(streamInputs) && streamInputs.length === 1);
		const streamInput = object(streamInputs[0]);
		if ("liveManifests" in plan) {
			assert.equal(streamInput.position, selection.position);
			assert.equal(streamInput.inputPath, selection.inputPath);
		} else {
			assert.equal(
				streamInput.inputStreamId,
				resourceId(`ingest:${selection.key}`),
			);
			const ingest = post(`ingest:${selection.key}`).body;
			assert.equal(ingest.position, selection.position);
			assert.equal(ingest.inputPath, selection.inputPath);
			assert("selectionMode" in selection);
			assert.equal(ingest.selectionMode, selection.selectionMode);
		}
		if (rendition.codec === "H264" || rendition.codec === "H265")
			assert.equal(stream.mode, rendition.mode);
	}
	for (const muxing of plan.muxings) {
		const request = post(`muxing:${muxing.key}`);
		const raw = muxing as unknown as ObjectValue;
		copyFields(request.body, raw, [
			"segmentLength",
			"segmentNaming",
			"initSegmentName",
		]);
		const streams = request.body.streams;
		assert(Array.isArray(streams) && streams.length >= 1);
		assert.equal(
			object(streams[0]).streamId,
			resourceId(`stream:${muxing.streamKey}`),
		);
	}
	const destinations = [
		...plan.muxings.map((muxing) => ({
			step: `muxing:${muxing.key}`,
			destination: muxing.destination,
		})),
		...("liveManifests" in plan ? plan.liveManifests : plan.manifests).map(
			(manifest) => ({
				step: `manifest:${manifest.key}`,
				destination: manifest.destination,
			}),
		),
	];
	for (const { step, destination } of destinations) {
		if (!destination) continue;
		const expectedKeys = [
			destination.outputKey,
			...(plan.deliveryMirrors ?? []).map((mirror) => mirror.outputKey),
		].filter((value, index, keys) => keys.indexOf(value) === index);
		const outputs = post(step).body.outputs;
		assert(Array.isArray(outputs));
		assert.equal(outputs.length, expectedKeys.length);
		for (const [index, key] of expectedKeys.entries()) {
			const output = object(outputs[index]);
			assert.equal(output.outputId, resourceId(`output:${key}`));
			assert.equal(output.outputPath, destination.path);
			if (destination.acl) {
				const acl = output.acl;
				assert(Array.isArray(acl) && acl.length === 1);
				assert.equal(object(acl[0]).permission, destination.acl);
			}
		}
	}
	for (const manifest of "liveManifests" in plan
		? plan.liveManifests
		: plan.manifests) {
		const request = post(`manifest:${manifest.key}`);
		if (manifest.kind === "SMOOTH")
			copyFields(request.body, manifest, [
				"serverManifestName",
				"clientManifestName",
			]);
		else assert.equal(request.body.manifestName, manifest.manifestName);
		if (manifest.kind === "HLS") {
			for (const [source, wire] of [
				["masterVersion", "hlsMasterPlaylistVersion"],
				["mediaVersion", "hlsMediaPlaylistVersion"],
			] as const) {
				const version: unknown = (manifest as unknown as ObjectValue)[source];
				if (typeof version === "string")
					assert.equal(request.body[wire], version.replace("HLS_V", ""));
			}
			for (const rendition of plan.renditions) {
				if (!("hlsVariantUri" in rendition) || !rendition.hlsVariantUri)
					continue;
				const variants: CapturedRequest[] = requests.filter(
					(call) =>
						call.method === "POST" &&
						call.path ===
							`/v1/encoding/manifests/hls/${resourceId(`manifest:${manifest.key}`)}/streams` &&
						call.body.streamId === resourceId(`stream:${rendition.key}`),
				);
				assert.equal(variants.length, 1);
				assert.equal(variants[0]?.body.uri, rendition.hlsVariantUri);
			}
		}
	}
	assert(
		requests.every((request) => !/\/(?:start|stop)(?:\/|$)/.test(request.path)),
	);
}

export async function verifyNonpaidSdkContract(input: unknown) {
	const proof = object(input);
	assert.equal(proof.version, 1);
	const database = object(proof.database);
	assert.deepEqual(database.counts, {
		accounts: 1,
		credentials: 1,
		vod: 1,
		live: 1,
	});
	const results = {} as Record<
		"vod" | "live",
		{ creates: number; requests: number }
	>;
	for (const kind of ["vod", "live"] as const) {
		const browser = object(proof[kind]);
		const rows = database[kind];
		assert(Array.isArray(rows) && rows.length === 1);
		const row = object(rows[0]);
		assert.equal(row.id, browser.id);
		assert.equal(row.status, kind === "vod" ? "QUEUED" : "CREATED");
		assert.equal(row.bitmovinEncodingId, null);
		const schema = kind === "vod" ? encodingPlanSchema : liveChannelPlanSchema;
		const plan = schema.parse(browser.requestPlan);
		assert.deepEqual(json(plan), browser.savedPlan);
		assert.deepEqual(json(plan), row.plan);
		const issues =
			kind === "vod"
				? validatePlan(plan as EncodingPlan)
				: validateLiveChannel(plan as LiveChannelPlan);
		assert(!issues.some((issue) => issue.level === "error"));
		const operations =
			kind === "vod"
				? compilePlan(plan as EncodingPlan)
				: compileLiveChannel(plan as LiveChannelPlan);
		assert.deepEqual(json(initStepLog(operations)), row.stepLog);
		assertCompiledStart(plan, operations);
		const captured = await captureSdkCreates(operations);
		assertSdkContract(plan, captured);
		results[kind] = {
			creates: operations.filter((operation) =>
				operation.kind.startsWith("CREATE_"),
			).length,
			requests: captured.requests.length,
		};
	}
	return {
		version: 1,
		status: "passed",
		providerRequests: 0,
		startRequests: 0,
		...results,
	};
}
