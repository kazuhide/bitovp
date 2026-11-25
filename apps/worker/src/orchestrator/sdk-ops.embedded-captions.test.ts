import type { CompiledOperation } from "@bitovp/core";
import { afterEach, expect, it, vi } from "vitest";
import { executeStep } from "./executor";
import { createBitmovinSdkOps } from "./sdk-ops";

afterEach(() => vi.unstubAllGlobals());

it.each([
	[
		"CREATE_CEA608_INPUT_STREAM",
		"CAPTION_CEA608",
		"captions/cea608",
		{ channel: "CC3" },
	],
	["CREATE_CEA708_INPUT_STREAM", "CAPTION_CEA708", "captions/cea708", {}],
	[
		"CREATE_CEA708_INPUT_STREAM",
		"CAPTION_CEA708",
		"captions/cea708",
		{ channel: 63 },
	],
	[
		"CREATE_DVB_SUBTITLE_INPUT_STREAM",
		"DVB_SUBTITLE",
		"subtitles/dvb-subtitle",
		{ selectionMode: "AUTO" },
	],
	[
		"CREATE_DVB_SUBTITLE_INPUT_STREAM",
		"DVB_SUBTITLE",
		"subtitles/dvb-subtitle",
		{ selectionMode: "POSITION_ABSOLUTE", position: 0 },
	],
] as const)("serializes %s with %j", async (kind, type, path, selection) => {
	const fetch = vi.fn(async (_url: string, _init: RequestInit) =>
		Response.json({ data: { result: { id: "caption-id" } } }),
	);
	vi.stubGlobal("fetch", fetch);
	const sdk = createBitmovinSdkOps({ apiKey: "test-only" }, async () => {});
	const op: CompiledOperation = {
		kind,
		step: "caption:en",
		refs: { encodingId: "encoding:main", inputId: "input:media" },
		payload: { inputPath: "feed.ts", ...selection },
	};
	const result = await executeStep(op, {
		sdk,
		ids: new Map([
			["encoding:main", "encoding-id"],
			["input:media", "input-id"],
		]),
		resolveCredential: vi.fn(),
		poll: { intervalMs: 1, timeoutMs: 50, sleep: async () => {} },
	});
	expect(result.resourceId).toBe("caption-id");
	expect(fetch).toHaveBeenCalledTimes(1);
	const call = fetch.mock.calls[0];
	if (!call) throw new Error("missing SDK request");
	const [url, init] = call;
	expect([init.method, new URL(url).pathname]).toEqual([
		"POST",
		`/v1/encoding/encodings/encoding-id/input-streams/${path}`,
	]);
	expect(JSON.parse(String(init.body))).toEqual({
		type,
		inputPath: "feed.ts",
		inputId: "input-id",
		...selection,
	});
});
