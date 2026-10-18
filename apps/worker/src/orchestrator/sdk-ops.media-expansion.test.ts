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
