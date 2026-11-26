import {
	type CompiledOperation,
	curlForStep,
	objectInputReceipts,
	publicHdrSourceProjection,
	redactSecrets,
	redactStepRequest,
} from "@bitovp/core";
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
	const inputPath = "dailies//Scene A:take 2@camera.mov";
	const op: CompiledOperation = {
		kind,
		step: "caption:en",
		refs: { encodingId: "encoding:main", inputId: "input:media" },
		payload: { inputPath, ...selection },
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
		inputPath,
		inputId: "input-id",
		...selection,
	});
	const snapshot = redactSecrets(result.request) as Record<string, unknown>;
	expect(snapshot).toMatchObject({ inputPath });
	const entry = {
		...op,
		status: "DONE" as const,
		refs: op.refs ?? {},
		payload: op.payload ?? {},
		request: snapshot,
		resourceId: result.resourceId,
		response: result.response,
	};
	const inputReceipt = {
		step: "input:media",
		kind: "CREATE_INPUT_S3",
		status: "DONE",
		resourceId: "input-id",
	};
	const requests = objectInputReceipts([inputReceipt]);
	for (const path of [inputPath, "dailies//Scene A:[REDACTED]@camera.mov"]) {
		const replay = curlForStep(
			{ ...entry, request: { ...snapshot, inputPath: path } },
			{ objectInputs: requests },
		);
		if (!replay.ok) throw Error(replay.code);
		expect(
			JSON.parse(replay.command.split("--data '")[1]?.slice(0, -1) ?? ""),
		).toMatchObject({ inputId: "input-id", inputPath });
	}
	const lost = curlForStep({
		...entry,
		payload: { ...entry.payload, inputPath: "different.ts" },
		request: {
			...snapshot,
			inputPath: "dailies//Scene A:[REDACTED]@camera.mov",
		},
	});
	expect(lost).toMatchObject({ ok: false });
	const objectPath = "reels/take?key=isolated.ts";
	const stored = {
		...entry,
		payload: { ...entry.payload, inputPath: objectPath },
	};
	const objectResult = await executeStep(
		{ ...op, payload: stored.payload },
		{
			sdk,
			ids: new Map([
				["encoding:main", "encoding-id"],
				["input:media", "input-id"],
			]),
			resolveCredential: vi.fn(),
			poll: { intervalMs: 1, timeoutMs: 50, sleep: async () => {} },
		},
	);
	const sent = fetch.mock.calls.at(-1);
	if (!sent) throw Error("No embedded caption SDK call");
	expect(JSON.parse(String(sent[1].body))).toMatchObject({
		inputId: "input-id",
		inputPath: objectPath,
	});
	const sourceRequest = objectResult.request as {
		inputPath: string;
		refs: Record<string, string>;
	};
	const write = redactStepRequest(stored, sourceRequest, [inputReceipt]);
	expect(write.inputPath).toBe(objectPath);
	const replay = curlForStep(
		{ ...stored, request: write },
		{ objectInputs: requests },
	);
	if (!replay.ok) throw Error(replay.code);
	expect(
		JSON.parse(replay.command.split("--data '")[1]?.slice(0, -1) ?? ""),
	).toMatchObject({ inputPath: objectPath });
	for (const incompatible of [
		[],
		[{ ...inputReceipt, kind: "CREATE_INPUT_HTTPS" }],
		[{ ...inputReceipt, status: "PENDING" }],
		[{ ...inputReceipt, resourceId: "different-id" }],
		[inputReceipt, { ...inputReceipt, kind: "CREATE_INPUT_HTTPS" }],
	]) {
		expect(
			redactStepRequest(stored, sourceRequest, incompatible).inputPath,
		).toBe("[REDACTED]");
		expect(
			curlForStep(
				{ ...stored, request: sourceRequest },
				{ objectInputs: objectInputReceipts(incompatible) },
			),
		).toMatchObject({ ok: false });
	}
	expect(
		curlForStep(
			{
				...stored,
				response: undefined,
				request: { ...write, inputPath: "[REDACTED]" },
			},
			{ objectInputs: requests },
		),
	).toMatchObject({ ok: false });
	const signed = "https://storage.invalid/feed.ts?sig=fixture-caption";
	const prior = {
		...entry,
		payload: { ...entry.payload, inputPath: signed },
		request: { ...snapshot, inputPath: signed },
	};
	expect(curlForStep(prior)).toMatchObject({ ok: false });
	expect(JSON.stringify(publicHdrSourceProjection(prior))).not.toContain(
		"fixture-caption",
	);
	expect(redactSecrets({ inputPath: signed })).toEqual({
		inputPath: "[REDACTED]",
	});
});
