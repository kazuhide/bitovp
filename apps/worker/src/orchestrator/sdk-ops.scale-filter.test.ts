import { ScalingAlgorithm } from "@bitmovin/api-sdk";
import { type CompiledOperation, SCALING_ALGORITHMS } from "@bitovp/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeStep } from "./executor";
import { createBitmovinSdkOps } from "./sdk-ops";

afterEach(() => vi.unstubAllGlobals());

function setup() {
	const calls: { path: string; body: unknown }[] = [];
	const fetch = vi.fn(async (url: string, init: RequestInit) => {
		calls.push({
			path: new URL(url).pathname,
			body: JSON.parse(init.body as string),
		});
		return new Response(
			JSON.stringify({ data: { result: { id: "scale-id" } } }),
			{
				status: 201,
				headers: { "content-type": "application/json" },
			},
		);
	});
	vi.stubGlobal("fetch", fetch);
	const sdk = createBitmovinSdkOps(
		{ apiKey: "test-only", tenantOrgId: null, bitmovinAccountId: "account" },
		async () => {},
	);
	return {
		calls,
		fetch,
		ctx: {
			sdk,
			ids: new Map<string, string>(),
			resolveCredential: vi.fn(),
			poll: { intervalMs: 1, timeoutMs: 50, sleep: async () => {} },
		},
	};
}

function operation(payload: Record<string, unknown>): CompiledOperation {
	return {
		step: "filter:video:scale",
		kind: "CREATE_FILTER_SCALE",
		payload,
		refs: {},
	};
}

describe("Scale filter SDK wire requests", () => {
	it("matches the supported algorithms to the pinned SDK", () => {
		expect(SCALING_ALGORITHMS).toEqual(Object.values(ScalingAlgorithm));
	});
	it.each([
		{},
		{ width: 1280 },
		{ height: 720 },
		{
			width: 1920,
			height: 1080,
			scalingAlgorithm: "LANCZOS",
			sampleAspectRatioNumerator: 1,
			sampleAspectRatioDenominator: 1,
		},
	])("serializes %j through the executor and installed SDK without creating defaults", async (payload) => {
		const { calls, ctx } = setup();
		const result = await executeStep(operation(payload), ctx);
		expect(result.resourceId).toBe("scale-id");
		expect(calls).toEqual([
			{
				path: "/v1/encoding/filters/scale",
				body: { type: "SCALE", ...payload },
			},
		]);
	});
	it.each(
		Object.values(ScalingAlgorithm),
	)("accepts pinned SDK algorithm %s without changing its wire value", async (scalingAlgorithm) => {
		const { calls, ctx } = setup();
		await executeStep(operation({ scalingAlgorithm }), ctx);
		expect(calls[0]?.body).toEqual({ type: "SCALE", scalingAlgorithm });
	});
	it.each([
		{ scalingAlgorithm: "UNKNOWN" },
		{ width: 0 },
		{ sampleAspectRatioNumerator: 1 },
		{ sampleAspectRatioDenominator: 1 },
	])("rejects malformed persisted operation %j before any SDK request", async (payload) => {
		const { fetch, ctx } = setup();
		await expect(executeStep(operation(payload), ctx)).rejects.toThrow();
		expect(fetch).not.toHaveBeenCalled();
	});
});
