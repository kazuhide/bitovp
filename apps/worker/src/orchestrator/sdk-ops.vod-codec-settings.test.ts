import { readFileSync } from "node:fs";
import {
	type CompiledOperation,
	compilePlan,
	curlForStep,
	encodingPlanSchema,
} from "@bitovp/core";
import { afterEach, expect, it, vi } from "vitest";
import { executeStep } from "./executor";
import { createBitmovinSdkOps } from "./sdk-ops";

afterEach(() => vi.unstubAllGlobals());

async function serialized(
	kind: CompiledOperation["kind"],
	payload: CompiledOperation["payload"],
) {
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
	const result = await executeStep(
		{ step: "codec:video", kind, refs: {}, payload },
		{
			sdk,
			ids: new Map(),
			resolveCredential: vi.fn(),
			poll: { intervalMs: 1, timeoutMs: 50, sleep: async () => {} },
		},
	);
	expect(fetch).toHaveBeenCalledOnce();
	const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
	return {
		path: new URL(url).pathname,
		body: JSON.parse(init.body as string),
		request: result.request,
	};
}

it.each([
	"VP9",
	"AV1",
] as const)("sends %s explicit width through executor and installed SDK", async (codec) => {
	const result = await serialized(`CREATE_CODEC_${codec}`, {
		width: 1280,
		height: null,
		bitrate: null,
	});
	expect(result.path).toBe(
		`/v1/encoding/configurations/video/${codec.toLowerCase()}`,
	);
	expect(result.body).toMatchObject({ type: codec, width: 1280 });
	expect(result.body).not.toHaveProperty("height");
	expect(result.body).not.toHaveProperty("bitrate");
});

it.each([
	"L4_1",
	"4.1",
])("serializes AV1 maximum level %s and zero HDR10 light levels", async (maxLevel) => {
	const fields = {
		maxLevel,
		dynamicRangeFormat: "HDR10",
		masterDisplay:
			"G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,1)",
		maxContentLightLevel: 0,
		maxPictureAverageLightLevel: 0,
	};
	const result = await serialized("CREATE_CODEC_AV1", fields);
	expect(result.body).toEqual({ type: "AV1", ...fields, maxLevel: "4.1" });
});

it("rejects an unknown AV1 maximum level before transport", async () => {
	const fetch = vi.fn();
	vi.stubGlobal("fetch", fetch);
	const sdk = createBitmovinSdkOps(
		{ apiKey: "test-only", tenantOrgId: null, bitmovinAccountId: "account" },
		async () => {},
	);
	await expect(
		sdk.createAv1Config({ maxLevel: "FUTURE_LEVEL" }),
	).rejects.toThrow("LevelAv1");
	expect(fetch).not.toHaveBeenCalled();
});

it.each([
	"L4_1",
	"4.1",
	undefined,
])("matches the installed SDK body when copying compiled AV1 maximum level %s as cURL", async (maxLevel) => {
	const raw = JSON.parse(
		readFileSync(
			new URL(
				"../../../../packages/core/src/plan/__fixtures__/av1-fmp4-dash-hls.plan.json",
				import.meta.url,
			),
			"utf8",
		),
	);
	for (const row of raw.renditions)
		if (row.codec === "AV1") row.maxLevel = maxLevel;
	const plan = encodingPlanSchema.parse(raw);
	const op = compilePlan(plan).find((op) => op.kind === "CREATE_CODEC_AV1");
	if (!op) throw new Error("Missing AV1 fixture operation");
	const sent = await serialized(op.kind, op.payload);
	const before = structuredClone({ op, request: sent.request });
	const curl = curlForStep({ ...op, status: "DONE", request: sent.request });
	if (!curl.ok) throw new Error("Expected AV1 cURL");
	const data = curl.command.match(/--data '([\s\S]*)'$/)?.[1];
	if (data === undefined) throw new Error("Missing AV1 cURL JSON body");
	const body = JSON.parse(data.replaceAll("'\\''", "'"));
	// The SDK adds its model discriminator; the cURL endpoint already identifies AV1.
	expect({ type: "AV1", ...body }).toEqual(sent.body);
	expect(body.maxLevel).toBe(maxLevel === undefined ? undefined : "4.1");
	expect({ op, request: sent.request }).toEqual(before);
});
