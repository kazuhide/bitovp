import {
	compilePlan,
	encodingPlanSchema,
	validateEncodingSupplements,
} from "@bitovp/core";
import { afterEach, expect, it, vi } from "vitest";
import { loadPlan } from "../../../../packages/core/src/plan/test-support";
import { executeStep } from "./executor";
import { createBitmovinSdkOps } from "./sdk-ops";

afterEach(() => vi.unstubAllGlobals());

it.each([
	{ mirrorAccount: "studio", expected: "duplicate" },
	{ mirrorAccount: "otherstudio", expected: "distinct" },
	{ mirrorAccount: undefined, expected: "unverified" },
])("validates $expected Azure supplement destinations from their output IDs", async ({
	mirrorAccount,
	expected,
}) => {
	const plan = encodingPlanSchema.parse({
		...loadPlan("mp4-fixed-bitrate-hls-vtt-on-aws"),
		outputs: [
			{
				key: "origin",
				kind: "AZURE",
				credentialId: "00000000-0000-4000-8000-000000000001",
				container: "delivery",
			},
			{
				key: "mirror",
				kind: "AZURE",
				credentialId: "00000000-0000-4000-8000-000000000002",
				container: "delivery",
			},
		],
		deliveryMirrors: [{ outputKey: "mirror" }],
		supplements: [
			{
				kind: "BIF",
				key: "preview",
				renditionKey: "v540",
				destination: { outputKey: "origin", path: "extras/" },
				distance: 10,
				width: 320,
				filename: "preview.bif",
			},
		],
	});
	const step = compilePlan(plan).find(
		(operation) => operation.kind === "CREATE_ENCODING_SUPPLEMENT",
	);
	if (!step) throw new Error("Missing supplement operation");
	const transport = vi.fn(async (url: string, req: RequestInit) => {
		const id = new URL(url).pathname.split("/").at(-1);
		return Response.json({
			status: "SUCCESS",
			data: {
				result:
					req.method === "GET"
						? {
								id,
								type: "AZURE",
								accountName: id === "origin-id" ? "studio" : mirrorAccount,
								container: "delivery",
							}
						: { id: "preview-id" },
			},
		});
	});
	vi.stubGlobal("fetch", transport);
	const sdk = createBitmovinSdkOps({ apiKey: "test-only" }, async () => {});
	const result = (async () => {
		const keys = await Promise.all([
			sdk.getAzureOutputStorageKey("origin-id"),
			sdk.getAzureOutputStorageKey("mirror-id"),
		]);
		const issues = validateEncodingSupplements(
			plan,
			new Map([
				["origin", keys[0]],
				["mirror", keys[1]],
			]),
		);
		if (issues[0]) throw new Error(issues[0].message);
		return executeStep(step, {
			sdk,
			ids: new Map([
				["encoding", "encoding-id"],
				["stream:v540", "stream-id"],
				["output:origin", "origin-id"],
				["output:mirror", "mirror-id"],
			]),
			resolveCredential: vi.fn(),
			poll: { intervalMs: 1, timeoutMs: 50, sleep: async () => {} },
		});
	})();
	if (expected === "distinct")
		await expect(result).resolves.toMatchObject({ resourceId: "preview-id" });
	else
		await expect(result).rejects.toThrow(
			expected === "duplicate" ? /distinct storage/ : /Azure/,
		);
	expect(
		transport.mock.calls.map(([url, req]) => [
			req.method,
			new URL(url).pathname,
		]),
	).toEqual([
		["GET", "/v1/encoding/outputs/azure/origin-id"],
		["GET", "/v1/encoding/outputs/azure/mirror-id"],
		...(expected === "distinct"
			? [["POST", "/v1/encoding/encodings/encoding-id/streams/stream-id/bifs"]]
			: []),
	]);
});
