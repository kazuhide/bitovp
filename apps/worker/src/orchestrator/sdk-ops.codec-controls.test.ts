import type { CompiledOperation } from "@bitovp/core";
import { afterEach, expect, it, vi } from "vitest";
import { executeStep } from "./executor";
import { createBitmovinSdkOps } from "./sdk-ops";

afterEach(() => vi.unstubAllGlobals());

it.each([
	"H264",
	"H265",
] as const)("serializes %s GOP, aspect and picture controls", async (codec) => {
	const fetch = vi.fn(
		async () =>
			new Response(JSON.stringify({ data: { result: { id: "created" } } }), {
				status: 201,
				headers: { "content-type": "application/json" },
			}),
	);
	vi.stubGlobal("fetch", fetch);
	const sdk = createBitmovinSdkOps(
		{ apiKey: "test-only", tenantOrgId: null, bitmovinAccountId: "account" },
		async () => {},
	);
	const controls = {
		width: 640,
		minGop: 0,
		maxGop: 48,
		openGop: false,
		displayAspectRatio: { numerator: 16, denominator: 9 },
		...(codec === "H265"
			? { qp: 0, qpMax: 69, bframes: 0, refFrames: 0, strictCbr: false }
			: {}),
	};
	const op: CompiledOperation = {
		step: "codec:picture",
		kind: codec === "H264" ? "CREATE_CODEC_H264" : "CREATE_CODEC_H265",
		refs: {},
		payload: { height: 360, bitrate: 600000, ...controls },
	};
	await executeStep(op, {
		sdk,
		ids: new Map(),
		resolveCredential: vi.fn(),
		poll: { intervalMs: 1, timeoutMs: 50, sleep: async () => {} },
	});
	expect(fetch).toHaveBeenCalledOnce();
	const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
	expect(JSON.parse(init.body as string)).toEqual({
		type: codec,
		height: 360,
		bitrate: 600000,
		...controls,
	});
});

it.each([
	"H264",
	"H265",
] as const)("serializes %s zero-valued rate controls with the installed SDK", async (codec) => {
	const fetch = vi.fn(
		async () =>
			new Response(JSON.stringify({ data: { result: { id: "created" } } }), {
				status: 201,
				headers: { "content-type": "application/json" },
			}),
	);
	vi.stubGlobal("fetch", fetch);
	const sdk = createBitmovinSdkOps(
		{ apiKey: "test-only", tenantOrgId: null, bitmovinAccountId: "account" },
		async () => {},
	);
	const controls = {
		crf: 0,
		minBitrate: 0,
		maxBitrate: 900000,
		bufsize: 1800000,
	};
	const op: CompiledOperation = {
		step: "codec:video",
		kind: codec === "H264" ? "CREATE_CODEC_H264" : "CREATE_CODEC_H265",
		refs: {},
		payload: { height: 360, ...controls },
	};
	await executeStep(op, {
		sdk,
		ids: new Map(),
		resolveCredential: vi.fn(),
		poll: { intervalMs: 1, timeoutMs: 50, sleep: async () => {} },
	});
	expect(fetch).toHaveBeenCalledOnce();
	const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
	expect(new URL(url).pathname).toBe(
		`/v1/encoding/configurations/video/${codec.toLowerCase()}`,
	);
	expect(JSON.parse(init.body as string)).toEqual({
		type: codec,
		height: 360,
		...controls,
	});
});
