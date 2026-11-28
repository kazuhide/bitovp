import { randomUUID } from "node:crypto";
import {
	compilePlan,
	curlForStep,
	encodingPlanSchema,
	validatePlan,
} from "@bitovp/core";
import { afterEach, expect, it, vi } from "vitest";
import sample from "../../../../packages/core/src/plan/__fixtures__/fixed-bitrate-hls-on-aws.plan.json";
import { executeStep } from "./executor";
import { createBitmovinSdkOps } from "./sdk-ops";
import type { CreateStamp } from "./stamping-fetch";

const enc = randomUUID();
const muxingId = randomUUID();
const stream = randomUUID();
const output = randomUUID();
const created = randomUUID();
const credentialId = randomUUID();
const drmKey = "ab".repeat(16);
const kid = "cd".repeat(16);
const pssh = "Zml4dHVyZSBwc3No";
const dest = { outputKey: "origin", path: "packaging-test/" };

function setup(stamp?: CreateStamp) {
	const audit = vi.fn(async () => {});
	const transport = vi.fn(async (_url: string, _request: RequestInit) =>
		Response.json(
			{ status: "SUCCESS", data: { result: { id: created } } },
			{ status: 201 },
		),
	);
	vi.stubGlobal("fetch", transport);
	return {
		audit,
		transport,
		context: {
			sdk: createBitmovinSdkOps(
				{
					apiKey: "fixture",
					tenantOrgId: "tenant-fixture",
					bitmovinAccountId: "fixture",
					stamp,
				},
				audit,
			),
			ids: new Map<string, string>(),
			resolveCredential: vi.fn(async () => ({
				provider: "DRM_CENC",
				config: {},
				secret: { key: drmKey },
			})),
			poll: { intervalMs: 1, timeoutMs: 10, sleep: async () => {} },
		},
	};
}

function plan(
	muxing: { kind: string; [field: string]: unknown },
	audio = false,
	drm: object[] = [],
) {
	const fixtureRendition = sample.renditions.find(
		({ key }) => key === (audio ? "a128" : "v360"),
	);
	const rendition =
		muxing.kind === "MXF"
			? { key: "broadcast", codec: "H262", ingestKey: "video", rate: 25 }
			: muxing.kind === "MP3"
				? {
						key: "audio-mp3",
						codec: "MP3",
						ingestKey: "audio",
						bitrate: 128000,
						rate: 48000,
					}
				: fixtureRendition;
	if (!rendition) throw new Error("Missing native packaging rendition");
	const parsed = encodingPlanSchema.parse({
		...sample,
		renditions: [rendition],
		muxings: [{ key: "test", streamKey: rendition.key, ...muxing }],
		drm,
		manifests: [],
		generation: { timing: "POST_ENCODING" },
	});
	expect(validatePlan(parsed).filter(({ level }) => level === "error")).toEqual(
		[],
	);
	return parsed;
}

function bindReferences(
	operation: ReturnType<typeof compilePlan>[number],
	ids: Map<string, string>,
) {
	for (const [ref, id] of [
		["encodingId", enc],
		["muxingId", muxingId],
		["streamId", stream],
		["outputId", output],
	] as const) {
		const source = operation.refs[ref];
		if (typeof source === "string") ids.set(source, id);
	}
}

async function run(
	compiledPlan: ReturnType<typeof plan>,
	step: string,
	path: string,
	fields: object,
) {
	const { audit, context, transport } = setup();
	const operation = compilePlan(compiledPlan).find((op) => op.step === step);
	if (!operation) throw new Error("Missing native packaging step");
	bindReferences(operation, context.ids);
	const result = await executeStep(operation, context);
	expect(result.resourceId).toBe(created);
	expect(transport).toHaveBeenCalledOnce();
	const call = transport.mock.calls[0];
	if (!call) throw new Error("Missing Bitmovin SDK transport");
	const [url, request] = call;
	expect(new URL(url).pathname).toBe(`/v1${path}`);
	expect(request.method).toBe("POST");
	expect(new Headers(request.headers).get("X-Tenant-Org-Id")).toBe(
		"tenant-fixture",
	);
	const sent = JSON.parse(String(request.body));
	expect(sent).toMatchObject(fields);
	if (step === "muxing:test") {
		const curl = curlForStep({ ...operation, ...result, status: "DONE" });
		if (!curl.ok) throw new Error(curl.code);
		expect(curl.command).toContain(path);
		const body = / {2}--data '([\s\S]*)'$/.exec(curl.command)?.[1];
		expect(JSON.parse(body ?? "null")).toEqual(sent);
	}
	expect(JSON.stringify([result, audit.mock.calls])).not.toContain(drmKey);
}

afterEach(() => vi.unstubAllGlobals());

it("submits the five typed delivery muxings through an admitted VOD plan", async () => {
	for (const [kind, slug, fields, audio] of [
		["BROADCAST_TS", "broadcast-ts", { filename: "asset.ts" }, false],
		["MP3", "mp3", { filename: "asset.mp3" }, true],
		["MXF", "mxf", { filename: "asset.mxf" }, false],
		[
			"PACKED_AUDIO",
			"packed-audio",
			{ segmentLength: 4, segmentNaming: "audio_%number%.aac" },
			true,
		],
		[
			"SEGMENTED_RAW",
			"segmented-raw",
			{ segmentLength: 4, segmentNaming: "part_%number%.aac" },
			true,
		],
	] as const) {
		await run(
			plan({ kind, ...fields, destination: dest }, audio),
			"muxing:test",
			`/encoding/encodings/${enc}/muxings/${slug}`,
			{
				...fields,
				streams: [{ streamId: stream }],
				outputs: [{ outputId: output, outputPath: dest.path }],
			},
		);
	}
});

it("uses the authored MP3 and MPEG-2 video codec configurations for file delivery", async () => {
	await run(
		plan({ kind: "MXF", filename: "asset.mxf", destination: dest }),
		"codec:broadcast",
		"/encoding/configurations/video/h262",
		{
			profile: "MPEG2_422",
			width: 1920,
			height: 1080,
			bitrate: 50000000,
			rate: 25,
		},
	);
	await run(
		plan({ kind: "MP3", filename: "asset.mp3", destination: dest }, true),
		"codec:audio-mp3",
		"/encoding/configurations/audio/mp3",
		{ bitrate: 128000, rate: 48000 },
	);
});
it("submits typed muxing DRM using only the recorded muxing and vault key", async () => {
	for (const [mux, slug, kinds, fields, audio] of [
		[
			"FMP4",
			"fmp4",
			["AES", "CLEARKEY", "MARLIN", "PLAYREADY", "PRIMETIME", "WIDEVINE"],
			{},
			false,
		],
		[
			"MP4",
			"mp4",
			["CLEARKEY", "MARLIN", "PLAYREADY", "WIDEVINE"],
			{ filename: "movie.mp4" },
			false,
		],
		["TS", "ts", ["AES"], {}, false],
		[
			"PROGRESSIVE_TS",
			"progressive-ts",
			["AES"],
			{ filename: "movie.ts" },
			false,
		],
		[
			"PACKED_AUDIO",
			"packed-audio",
			["AES"],
			{ segmentLength: 4, segmentNaming: "audio_%number%.aac" },
			true,
		],
	] as const) {
		for (const kind of kinds) {
			const extra =
				kind === "AES"
					? { method: "AES_128", keyFileUri: "provisioned-key.bin" }
					: {
							kid,
							...(["PRIMETIME", "WIDEVINE"].includes(kind) ? { pssh } : {}),
						};
			await run(
				plan({ kind: mux, ...fields }, audio, [
					{
						key: "drm",
						kind,
						muxingKey: "test",
						credentialId,
						destination: dest,
						...extra,
					},
				]),
				"drm:drm",
				`/encoding/encodings/${enc}/muxings/${slug}/${muxingId}/drm/${kind.toLowerCase()}`,
				{
					...extra,
					key: drmKey,
					outputs: [{ outputId: output, outputPath: dest.path }],
				},
			);
		}
	}
});

it("submits the three typed progressive TS ID3 formats through the compiled plan", async () => {
	for (const [format, slug, fields] of [
		["FRAME_ID", "frame-id", { frameId: "TIT2", bytes: "Zml4dHVyZQ==" }],
		["PLAIN_TEXT", "plain-text", { frameId: "TIT2", text: "Fixture label" }],
		["RAW", "raw", { bytes: "SUQzAwAAAAAAAA==" }],
	] as const) {
		const tag = {
			key: "cue",
			format,
			positionMode: "TIME",
			time: 1.25,
			...fields,
		};
		await run(
			plan({
				kind: "PROGRESSIVE_TS",
				filename: "movie.ts",
				destination: dest,
				id3Tags: [tag],
			}),
			"id3:test:cue",
			`/encoding/encodings/${enc}/muxings/progressive-ts/${muxingId}/id3/${slug}`,
			{ ...fields, positionMode: "TIME", time: 1.25 },
		);
	}
});

it.each([
	undefined,
	"",
	"https://cdn.example.com/key",
	"../key",
	"key?secret=1",
])("rejects unsafe AES key reference %s in the plan and at persisted dispatch", async (keyFileUri) => {
	const drm = {
		key: "drm",
		kind: "AES",
		muxingKey: "test",
		credentialId,
		method: "AES_128",
		keyFileUri: "provisioned-key.bin",
		destination: dest,
	};
	const parsed = plan({ kind: "FMP4" }, false, [drm]);
	const planResult = encodingPlanSchema.safeParse({
		...parsed,
		drm: [{ ...drm, keyFileUri }],
	});
	expect(planResult.success).toBe(false);
	const { context, transport } = setup();
	const operation = compilePlan(parsed).find((op) => op.step === "drm:drm");
	if (!operation) throw new Error("Missing AES operation");
	bindReferences(operation, context.ids);
	await expect(
		executeStep(
			{ ...operation, payload: { ...operation.payload, keyFileUri } },
			context,
		),
	).rejects.toThrow("relative key filename");
	expect(context.resolveCredential).not.toHaveBeenCalled();
	expect(transport).not.toHaveBeenCalled();
});

it.each([
	"found",
	"empty",
	"conflict",
	"unavailable",
	"partial",
	"unrelated",
] as const)("reconciles a lost Progressive TS ID3 create before any further POST (%s)", async (visibility) => {
	const job = randomUUID();
	const step = "id3:test:cue";
	const operation = compilePlan(
		plan({
			kind: "PROGRESSIVE_TS",
			filename: "movie.ts",
			destination: dest,
			id3Tags: [
				{
					key: "cue",
					format: "PLAIN_TEXT",
					positionMode: "TIME",
					time: 1,
					frameId: "TIT2",
					text: "Private chapter",
				},
			],
		}),
	).find((op) => op.step === step);
	if (!operation) throw new Error("Missing ID3 operation");
	let recovering = false;
	const { context, transport, audit } = setup({
		jobId: job,
		currentStep: () => step,
		adoptWindow: () => recovering,
	});
	bindReferences(operation, context.ids);
	const other = randomUUID();
	transport.mockImplementation(async (url, request) => {
		if (request.method === "POST") {
			expect(JSON.parse(String(request.body)).customData).toMatchObject({
				bitovp: { job, step },
			});
			throw new TypeError("connection dropped after the send");
		}
		const path = new URL(url).pathname;
		if (path.endsWith("/customData")) {
			const owner = visibility === "unrelated" ? other : job;
			return Response.json({
				status: "SUCCESS",
				data: { result: { customData: { bitovp: { job: owner, step } } } },
			});
		}
		const items =
			recovering && ["found", "partial", "unrelated"].includes(visibility)
				? [{ id: created }]
				: recovering && visibility === "conflict"
					? [{ id: created }, { id: other }]
					: [];
		if (recovering && visibility === "unavailable")
			return new Response(null, { status: 503 });
		return Response.json({
			status: "SUCCESS",
			data: {
				result: {
					items,
					totalCount: recovering && visibility === "partial" ? 2 : items.length,
				},
			},
		});
	});

	await expect(executeStep(operation, context)).rejects.toThrow();
	recovering = true;
	if (visibility === "found")
		await expect(executeStep(operation, context)).resolves.toMatchObject({
			resourceId: created,
		});
	else await expect(executeStep(operation, context)).rejects.toThrow();
	expect(
		transport.mock.calls.filter(([, request]) => request.method === "POST"),
	).toHaveLength(1);
	expect(JSON.stringify(audit.mock.calls)).not.toContain("Private chapter");
});

it("preserves a confirmed provider refusal for the ID3 retry journal", async () => {
	const step = "id3:test:cue";
	const operation = compilePlan(
		plan({
			kind: "PROGRESSIVE_TS",
			filename: "movie.ts",
			destination: dest,
			id3Tags: [
				{
					key: "cue",
					format: "RAW",
					positionMode: "TIME",
					time: 1,
					bytes: "SUQzAwAAAAAAAA==",
				},
			],
		}),
	).find((op) => op.step === step);
	if (!operation) throw new Error("Missing ID3 operation");
	const { context, transport } = setup({
		jobId: randomUUID(),
		currentStep: () => step,
		adoptWindow: () => false,
	});
	bindReferences(operation, context.ids);

	let posts = 0;
	transport.mockImplementation(async (_url, request) => {
		if (request.method !== "POST")
			return Response.json({
				status: "SUCCESS",
				data: { result: { items: [], totalCount: 0 } },
			});
		posts++;
		if (posts === 1)
			return Response.json(
				{ status: "ERROR", data: { code: 1032, message: "Slow down" } },
				{ status: 429 },
			);
		return Response.json(
			{ status: "SUCCESS", data: { result: { id: created } } },
			{ status: 201 },
		);
	});
	await expect(executeStep(operation, context)).rejects.toMatchObject({
		status: 429,
	});
	await expect(executeStep(operation, context)).resolves.toMatchObject({
		resourceId: created,
	});
	expect(posts).toBe(2);
});
