import { CaptionCharacterEncoding } from "@bitmovin/api-sdk";
import type { CompiledOperation } from "@bitovp/core";
import { afterEach, expect, it, vi } from "vitest";
import { SRT_CHARACTER_ENCODING_VALUES } from "../../../../packages/core/src/plan/srt-character-encodings";
import { executeStep } from "./executor";
import { createBitmovinSdkOps } from "./sdk-ops";

afterEach(() => vi.unstubAllGlobals());
it("projects subtitle references through executor and installed SDK to actual HTTP payloads", async () => {
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
			step: "burn",
			kind: "CREATE_BURN_IN_SRT",
			payload: { inputPath: "captions/ja.srt", characterEncoding: "SHIFT_JIS" },
			refs: { encodingId: "enc", streamId: "video", inputId: "input" },
		},
		{
			step: "subtitle-set",
			kind: "CREATE_DASH_ADAPTATION_SET_SUBTITLE",
			payload: { lang: "en", labels: [{ value: "English" }] },
			refs: { manifestId: "manifest", periodId: "period" },
		},
		{
			step: "subtitle-rep",
			kind: "CREATE_DASH_REPRESENTATION_CHUNKED_TEXT",
			payload: { type: "TIMELINE", segmentPath: "subtitles/en" },
			refs: {
				manifestId: "manifest",
				periodId: "period",
				adaptationSetId: "set",
				encodingId: "enc",
				muxingId: "mux",
			},
		},
	];
	const ids = new Map(
		["enc", "video", "input", "manifest", "period", "set", "mux"].map((id) => [
			id,
			`${id}-id`,
		]),
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
			path: "/v1/encoding/encodings/enc-id/streams/video-id/burn-in-subtitles/srt",
			body: {
				name: "SRT subtitles",
				characterEncoding: "SHIFT-JIS",
				input: { inputId: "input-id", inputPath: "captions/ja.srt" },
			},
		},
		{
			path: "/v1/encoding/manifests/dash/manifest-id/periods/period-id/adaptationsets/subtitle",
			body: { type: "SUBTITLE", lang: "en", labels: [{ value: "English" }] },
		},
		{
			path: "/v1/encoding/manifests/dash/manifest-id/periods/period-id/adaptationsets/set-id/representations/chunked-text",
			body: {
				typeDiscriminator: "CHUNKED_TEXT",
				type: "TIMELINE",
				segmentPath: "subtitles/en",
				encodingId: "enc-id",
				muxingId: "mux-id",
			},
		},
	]);
});

it("keeps all authorable SRT enum names and wire values aligned with SDK 1.280.0", () => {
	expect(SRT_CHARACTER_ENCODING_VALUES).toEqual(CaptionCharacterEncoding);
});

it.each([
	"SUBTITLE",
	"translated",
	undefined,
])("serializes HLS subtitle reference %s through executor and SDK", async (subtitles) => {
	let body: Record<string, unknown> = {};
	vi.stubGlobal(
		"fetch",
		vi.fn(async (_url: string, init: RequestInit) => {
			body = JSON.parse(init.body as string);
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
	await executeStep(
		{
			step: "variant",
			kind: "CREATE_HLS_STREAM_INFO",
			payload: {
				subtitles,
				closedCaptions: "NONE",
				uri: "video.m3u8",
				segmentPath: "video/",
			},
			refs: {
				manifestId: "manifest",
				encodingId: "enc",
				streamId: "video",
				muxingId: "mux",
			},
		},
		{
			sdk,
			ids: new Map(
				["manifest", "enc", "video", "mux"].map((id) => [id, `${id}-id`]),
			),
			resolveCredential: vi.fn(),
			poll: { intervalMs: 1, timeoutMs: 50, sleep: async () => {} },
		},
	);
	if (subtitles === undefined) expect(body).not.toHaveProperty("subtitles");
	else expect(body.subtitles).toBe(subtitles);
});
