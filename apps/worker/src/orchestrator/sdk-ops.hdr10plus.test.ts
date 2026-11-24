import { type CompiledOperation, curlForStep, initStepLog } from "@bitovp/core";
import { afterEach, expect, it, vi } from "vitest";
import { executeStep } from "./executor";
import { createBitmovinSdkOps } from "./sdk-ops";

afterEach(() => vi.unstubAllGlobals());

it.each([
	{ selectionMode: "AUTO" },
	{ selectionMode: "VIDEO_RELATIVE" },
	{ selectionMode: "VIDEO_RELATIVE", position: 2 },
	{ selectionMode: "POSITION_ABSOLUTE", position: 0 },
])("sends HDR10+ video and JSON through the installed SDK: %j", async (selection) => {
	const fetch = vi.fn(
		async () =>
			new Response(JSON.stringify({ data: { result: { id: "hdr-stream" } } }), {
				status: 201,
				headers: { "content-type": "application/json" },
			}),
	);
	vi.stubGlobal("fetch", fetch);
	const audit = vi.fn(async () => {});
	const sdk = createBitmovinSdkOps(
		{ apiKey: "test-only", tenantOrgId: null, bitmovinAccountId: "account" },
		audit,
	);
	const operation: CompiledOperation = {
		step: "hdr10plus:video",
		kind: "CREATE_HDR10_PLUS_INPUT_STREAM",
		refs: { encodingId: "encoding:main", inputId: "input:source" },
		payload: {
			videoInputPath: "feature/hdr10.mov",
			metadataInputPath: "feature/hdr10plus.json",
			...selection,
		},
	};
	const result = await executeStep(operation, {
		sdk,
		ids: new Map([
			["encoding:main", "encoding-id"],
			["input:source", "same-storage-input-id"],
		]),
		resolveCredential: vi.fn(),
		poll: { intervalMs: 1, timeoutMs: 50, sleep: async () => {} },
	});
	expect(result.resourceId).toBe("hdr-stream");
	expect(fetch).toHaveBeenCalledOnce();
	const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
	expect(new URL(url).pathname).toBe(
		"/v1/encoding/encodings/encoding-id/input-streams/hdr10-plus",
	);
	expect(init.method).toBe("POST");
	expect(JSON.parse(init.body as string)).toEqual({
		type: "HDR10_PLUS",
		inputId: "same-storage-input-id",
		videoInputPath: "feature/hdr10.mov",
		metadataInputPath: "feature/hdr10plus.json",
		...selection,
	});
	const entry = initStepLog([operation])[0];
	if (!entry) throw new Error("missing log entry");
	const curl = curlForStep({ ...entry, request: result.request });
	if (!curl.ok) throw new Error(curl.code);
	expect(curl.command).toContain(url);
	expect(
		JSON.parse(curl.command.split("--data '")[1]?.slice(0, -1) ?? "{}"),
	).toEqual(JSON.parse(init.body as string));
	expect(audit).toHaveBeenCalled();
});

it("rejects an audio selection before transport", async () => {
	const fetch = vi.fn();
	vi.stubGlobal("fetch", fetch);
	const sdk = createBitmovinSdkOps({ apiKey: "test-only" }, async () => {});
	await expect(
		executeStep(
			{
				kind: "CREATE_HDR10_PLUS_INPUT_STREAM",
				step: "hdr10plus:invalid",
				refs: {},
				payload: { selectionMode: "AUDIO_RELATIVE" },
			},
			{
				sdk,
				ids: new Map(),
				resolveCredential: vi.fn(),
				poll: { intervalMs: 1, timeoutMs: 50, sleep: async () => {} },
			},
		),
	).rejects.toThrow("Invalid HDR10+ selection mode");
	expect(fetch).not.toHaveBeenCalled();
});
