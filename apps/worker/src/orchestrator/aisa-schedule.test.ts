import { afterEach, describe, expect, it, vi } from "vitest";
import { executeStep } from "./executor";
import { createBitmovinSdkOps } from "./sdk-ops";

afterEach(() => vi.unstubAllGlobals());

describe("AISA schedule on the SDK wire", () => {
	const schedule = [
		{ position: 0, maxDeviation: 0 },
		{ position: 1249, maxDeviation: 1, duration: 30 },
		{ position: 2280.5, maxDeviation: 0, duration: 0 },
	];
	const allSceneBoundaries = { isEnabled: true, insertCueTags: true };
	it.each([
		{ schedule },
		{ schedule, allSceneBoundaries },
		{ allSceneBoundaries },
	])("preserves %j through the executor and real SDK", async (placement) => {
		const calls: { url: string; body: Record<string, unknown> }[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url, init) => {
				calls.push({ url: String(url), body: JSON.parse(init?.body ?? "{}") });
				return new Response(
					JSON.stringify({
						data: { result: { id: "enc", status: "CREATED" } },
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}),
		);
		const sdk = createBitmovinSdkOps(
			{ apiKey: "test", tenantOrgId: null, bitmovinAccountId: "account" },
			async () => {},
		);
		await executeStep(
			{
				step: "start",
				kind: "START_ENCODING",
				refs: { encodingId: "encoding", aiAssetDescriptionOutputId: "output" },
				payload: {
					aiSceneAnalysis: {
						features: {
							assetDescription: { filename: "analysis.json", outputPath: "ai" },
							automaticAdPlacement: placement,
						},
					},
				},
			},
			{
				sdk,
				ids: new Map([
					["encoding", "enc"],
					["output", "out"],
				]),
				resolveCredential: vi.fn(),
				poll: { intervalMs: 1, timeoutMs: 50, sleep: async () => {} },
			},
		);
		const starts = calls.filter((c) => c.url.endsWith("/enc/start"));
		expect(starts).toHaveLength(1);
		expect(starts[0]?.body).toMatchObject({
			aiSceneAnalysis: {
				features: {
					assetDescription: {
						filename: "analysis.json",
						outputs: [{ outputId: "out" }],
					},
					automaticAdPlacement: placement,
				},
			},
		});
	});
});
