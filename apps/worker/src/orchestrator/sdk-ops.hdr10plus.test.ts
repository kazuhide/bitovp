import { type CompiledOperation, curlForStep, initStepLog } from "@bitovp/core";
import { afterEach, expect, it, vi } from "vitest";
import { auditedOperationCases } from "../../../../scripts/api-coverage-test-cases";
import { executeStep } from "./executor";
import { createBitmovinSdkOps } from "./sdk-ops";

afterEach(() => vi.unstubAllGlobals());

it.each(
	auditedOperationCases(
		import.meta.url,
		"worker-hdr10-plus-create",
		[
			{ selectionMode: "AUTO" },
			{ selectionMode: "VIDEO_RELATIVE" },
			{ selectionMode: "VIDEO_RELATIVE", position: 2 },
			{ selectionMode: "POSITION_ABSOLUTE", position: 0 },
		],
		() => ["POST /encoding/encodings/{encoding_id}/input-streams/hdr10-plus"],
	),
)("sends HDR10+ video and JSON through the installed SDK: %j", async (selection) => {
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

it("uses the NetStorage input ID and exact object key in the installed ingest SDK", async () => {
	const fetch = vi.fn(
		async (_url: string, _init: RequestInit) =>
			new Response(
				JSON.stringify({ data: { result: { id: "owned-resource" } } }),
				{ status: 201, headers: { "content-type": "application/json" } },
			),
	);
	vi.stubGlobal("fetch", fetch);
	const audit = vi.fn(async () => {});
	const sdk = createBitmovinSdkOps(
		{ apiKey: "test-only", tenantOrgId: null },
		audit,
	);
	const inputId = await sdk.createAkamaiNetStorageInput({
		name: "media",
		host: "storage.example.invalid",
		username: "fixture-user",
		password: "fixture-only",
	});
	await sdk.createIngestInputStream("encoding-local", {
		inputId,
		inputPath: "edits/take?version=2.mxf",
		selectionMode: "AUTO",
		position: 0,
	});
	expect(fetch.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
		"/v1/encoding/inputs/akamai-netstorage",
		"/v1/encoding/encodings/encoding-local/input-streams/ingest",
	]);
	expect(JSON.parse(String(fetch.mock.calls[1]?.[1].body))).toMatchObject({
		inputId: "owned-resource",
		inputPath: "edits/take?version=2.mxf",
	});
	expect(JSON.stringify(audit.mock.calls)).not.toContain("fixture-only");
});
