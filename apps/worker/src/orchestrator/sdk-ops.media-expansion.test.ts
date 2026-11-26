import type { CompiledOperation } from "@bitovp/core";
import { afterEach, expect, it, vi } from "vitest";
import { executeStep } from "./executor";
import { createBitmovinSdkOps } from "./sdk-ops";

afterEach(() => vi.unstubAllGlobals());
it("serializes new media resources through executor and installed SDK", async () => {
	const calls: { path: string; body: unknown }[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init: RequestInit) => {
			calls.push({
				path: new URL(url).pathname,
				body: JSON.parse(init.body as string),
			});
			return new Response(
				JSON.stringify({ data: { result: { id: "created" } } }),
				{ status: 201, headers: { "content-type": "application/json" } },
			);
		}),
	);
	const sdk = createBitmovinSdkOps(
		{ apiKey: "test-only", tenantOrgId: null, bitmovinAccountId: "account" },
		async () => {},
	);
	const operations: CompiledOperation[] = [
		{
			step: "opus",
			kind: "CREATE_CODEC_OPUS",
			payload: { bitrate: 128000, rate: 48000, channelLayout: "CL_STEREO" },
			refs: {},
		},
		{
			step: "imsc",
			kind: "CREATE_CODEC_IMSC",
			payload: { styling: { mode: "DROP_STYLING" } },
			refs: {},
		},
		{
			step: "file",
			kind: "CREATE_FILE_INPUT_STREAM",
			payload: { inputPath: "captions/en.ttml", fileType: "TTML" },
			refs: { encodingId: "enc", inputId: "input" },
		},
		{
			step: "text",
			kind: "CREATE_MUXING_TEXT",
			payload: { filename: "english.ttml", outputPath: "captions/" },
			refs: { encodingId: "enc", streamId: "stream", outputId: "output" },
		},
		{
			step: "representation",
			kind: "CREATE_DASH_REPRESENTATION_IMSC",
			payload: { imscUrl: "captions/english.ttml" },
			refs: {
				manifestId: "manifest",
				periodId: "period",
				adaptationSetId: "set",
			},
		},
		{
			step: "denoise",
			kind: "CREATE_FILTER_DENOISE_HQDN3D",
			payload: { lumaSpatial: 4, chromaTmp: 0 },
			refs: {},
		},
		{
			step: "sharp",
			kind: "CREATE_FILTER_UNSHARP",
			payload: { lumaMatrixHorizontalSize: 5, lumaEffectStrength: 0.5 },
			refs: {},
		},
	];
	const ids = new Map(
		["enc", "input", "stream", "output", "manifest", "period", "set"].map(
			(id) => [id, `${id}-id`],
		),
	);
	for (const op of operations)
		await executeStep(op, {
			sdk,
			ids,
			resolveCredential: vi.fn(),
			poll: { intervalMs: 1, timeoutMs: 50, sleep: async () => {} },
		});
	expect(calls).toEqual([
		{
			path: "/v1/encoding/configurations/audio/opus",
			body: {
				type: "OPUS",
				bitrate: 128000,
				rate: 48000,
				channelLayout: "STEREO",
			},
		},
		{
			path: "/v1/encoding/configurations/subtitles/imsc",
			body: { type: "IMSC", styling: { mode: "DROP_STYLING" } },
		},
		{
			path: "/v1/encoding/encodings/enc-id/input-streams/file",
			body: {
				type: "FILE",
				inputId: "input-id",
				inputPath: "captions/en.ttml",
				fileType: "TTML",
			},
		},
		{
			path: "/v1/encoding/encodings/enc-id/muxings/text",
			body: {
				type: "TEXT",
				filename: "english.ttml",
				streams: [{ streamId: "stream-id" }],
				outputs: [{ outputId: "output-id", outputPath: "captions/" }],
			},
		},
		{
			path: "/v1/encoding/manifests/dash/manifest-id/periods/period-id/adaptationsets/set-id/representations/imsc",
			body: { typeDiscriminator: "IMSC", imscUrl: "captions/english.ttml" },
		},
		{
			path: "/v1/encoding/filters/denoise-hqdn3d",
			body: { type: "DENOISE_HQDN3D", lumaSpatial: 4, chromaTmp: 0 },
		},
		{
			path: "/v1/encoding/filters/unsharp",
			body: {
				type: "UNSHARP",
				lumaMatrixHorizontalSize: 5,
				lumaEffectStrength: 0.5,
			},
		},
	]);
});

it("sends each authored video/audio filter and its ordered attachment through the installed SDK", async () => {
	const calls: { path: string; body: unknown }[] = [];
	const records: unknown[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init: RequestInit) => {
			expect(init.method).toBe("POST");
			calls.push({
				path: new URL(url).pathname,
				body: JSON.parse(String(init.body)),
			});
			return Response.json(
				{ data: { result: { id: `f-${calls.length}` } } },
				{ status: 201 },
			);
		}),
	);
	const sdk = createBitmovinSdkOps(
		{ apiKey: "test-only", tenantOrgId: null, bitmovinAccountId: "account" },
		async (entry) => {
			records.push(entry);
		},
	);
	const ctx = {
		sdk,
		ids: new Map([
			["enc", "encoding-id"],
			["video", "video-id"],
			["audio", "audio-id"],
		]),
		resolveCredential: async () => ({
			provider: "AWS_S3",
			config: { region: "ap-northeast-1" },
			secret: { accessKeyId: "EXAMPLE", secretAccessKey: "EXAMPLE_SECRET" },
		}),
		poll: { intervalMs: 1, timeoutMs: 50, sleep: async () => {} },
	};
	const mix = {
		channelLayout: "MONO",
		audioMixChannels: [
			{
				channelNumber: 0,
				sourceChannels: [
					{ type: "FRONT_LEFT", gain: -0.5 },
					{ type: "FRONT_RIGHT", gain: 0 },
				],
			},
		],
	};
	const fields = {
		mode: "FIELD",
		parity: "TOP_FIELD_FIRST",
		autoEnable: "META_DATA_BASED",
	};
	const rate = { targetFps: 24_000 / 1_001 };
	const interlace = { mode: "TOP", verticalLowPassFilteringMode: "LOW_PASS" };
	const image = {
		left: 3.5,
		top: 1.25,
		unit: "PERCENTS",
		width: 5.5,
		opacity: 0,
	};
	const loudness = {
		targetLoudness: -23,
		maximumTruePeakLevel: -2,
		dialogueIntelligence: "ENABLED",
		speechDetectionThreshold: 0,
		contentForm: "SHORT",
	};
	const ops: CompiledOperation[] = [
		{
			step: "field",
			kind: "CREATE_FILTER_ENHANCED_DEINTERLACE",
			payload: fields,
			refs: {},
		},
		{ step: "rate", kind: "CREATE_FILTER_CONFORM", payload: rate, refs: {} },
		{
			step: "interlace",
			kind: "CREATE_FILTER_INTERLACE",
			payload: interlace,
			refs: {},
		},
		{
			step: "image",
			kind: "CREATE_FILTER_ENHANCED_WATERMARK",
			payload: {
				...image,
				inputKey: "in",
				imagePath: "brand/logo.png",
				imageInput: {
					key: "in",
					kind: "S3",
					bucket: "watermark-test",
					credentialId: "00000000-0000-4000-8000-000000000001",
				},
			},
			refs: {},
		},
		{ step: "mix", kind: "CREATE_FILTER_AUDIO_MIX", payload: mix, refs: {} },
		{
			step: "levels",
			kind: "CREATE_FILTER_DOLBY_LOUDNESS",
			payload: loudness,
			refs: {},
		},
		{
			step: "video-chain",
			kind: "CREATE_STREAM_FILTERS",
			payload: { positions: [0, 1, 2, 3] },
			refs: {
				encodingId: "enc",
				streamId: "video",
				filterIds: ["field", "rate", "interlace", "image"],
			},
		},
		{
			step: "audio-chain",
			kind: "CREATE_STREAM_FILTERS",
			payload: { positions: [0, 1] },
			refs: {
				encodingId: "enc",
				streamId: "audio",
				filterIds: ["mix", "levels"],
			},
		},
	];
	for (const op of ops) {
		const result = await executeStep(op, ctx);
		if (result.resourceId) ctx.ids.set(op.step, result.resourceId);
		records.push(result);
	}
	const videoAttach = [1, 2, 3, 4].map((n, position) => ({
		id: `f-${n}`,
		position,
	}));
	const audioAttach = [5, 6].map((n, position) => ({ id: `f-${n}`, position }));
	expect(calls).toEqual([
		{
			path: "/v1/encoding/filters/enhanced-deinterlace",
			body: { type: "ENHANCED_DEINTERLACE", ...fields },
		},
		{
			path: "/v1/encoding/filters/conform",
			body: { type: "CONFORM", ...rate },
		},
		{
			path: "/v1/encoding/filters/interlace",
			body: { type: "INTERLACE", ...interlace },
		},
		{
			path: "/v1/encoding/filters/enhanced-watermark",
			body: {
				type: "ENHANCED_WATERMARK",
				...image,
				image: expect.stringMatching(/X-Amz-Signature=/),
			},
		},
		{
			path: "/v1/encoding/filters/audio-mix",
			body: { type: "AUDIO_MIX", ...mix },
		},
		{
			path: "/v1/encoding/filters/dolby-loudness",
			body: { type: "DOLBY_LOUDNESS", ...loudness },
		},
		{
			path: "/v1/encoding/encodings/encoding-id/streams/video-id/filters",
			body: videoAttach,
		},
		{
			path: "/v1/encoding/encodings/encoding-id/streams/audio-id/filters",
			body: audioAttach,
		},
	]);
	expect(JSON.stringify(records)).not.toMatch(/X-Amz-|EXAMPLE_SECRET/);
});
