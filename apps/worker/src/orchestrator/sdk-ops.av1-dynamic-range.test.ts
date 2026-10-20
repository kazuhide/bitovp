import type { CompiledOperation } from "@bitovp/core";
import { afterEach, expect, it, vi } from "vitest";
import { executeStep } from "./executor";
import { createBitmovinSdkOps } from "./sdk-ops";

afterEach(() => vi.unstubAllGlobals());

it.each([
	"SDR",
	"HDR10",
	"DOLBY_VISION_PROFILE_10_0",
	"DOLBY_VISION_PROFILE_10_1",
	undefined,
])("serializes AV1 %s through executor and installed SDK", async (format) => {
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
	const op: CompiledOperation = {
		step: "codec:av1",
		kind: "CREATE_CODEC_AV1",
		refs: {},
		payload: {
			height: 360,
			bitrate: 600000,
			...(format ? { dynamicRangeFormat: format } : {}),
		},
	};
	await executeStep(op, {
		sdk,
		ids: new Map(),
		resolveCredential: vi.fn(),
		poll: { intervalMs: 1, timeoutMs: 50, sleep: async () => {} },
	});
	expect(fetch).toHaveBeenCalledOnce();
	const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
	expect(new URL(url).pathname).toBe("/v1/encoding/configurations/video/av1");
	expect(JSON.parse(init.body as string)).toEqual({
		type: "AV1",
		height: 360,
		bitrate: 600000,
		...(format ? { dynamicRangeFormat: format } : {}),
	});
});

it("rejects a legacy HEVC dynamic range enum before transport", async () => {
	const fetch = vi.fn();
	vi.stubGlobal("fetch", fetch);
	const sdk = createBitmovinSdkOps(
		{ apiKey: "test-only", tenantOrgId: null, bitmovinAccountId: "account" },
		async () => {},
	);
	await expect(
		sdk.createAv1Config({ dynamicRangeFormat: "DOLBY_VISION_PROFILE_5" }),
	).rejects.toThrow("Av1DynamicRangeFormat");
	expect(fetch).not.toHaveBeenCalled();
});
