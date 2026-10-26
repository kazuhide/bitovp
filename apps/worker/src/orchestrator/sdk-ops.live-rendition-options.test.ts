import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compileLiveChannel, liveChannelPlanSchema } from "@bitovp/core";
import { afterEach, expect, it, vi } from "vitest";
import { executeStep } from "./executor";
import { createBitmovinSdkOps } from "./sdk-ops";

afterEach(() => vi.unstubAllGlobals());

it.each([
	"mp4",
	"cmfv",
])("serializes template-only Live .%s naming through the real SDK despite schema defaults", async (extension) => {
	const plan = liveChannelPlanSchema.parse(
		JSON.parse(
			readFileSync(
				join(
					__dirname,
					"../../../../packages/core/src/live/__fixtures__/live-rtmp-simple.plan.json",
				),
				"utf8",
			),
		),
	);
	for (const selection of plan.ingest) {
		selection.inputPath = "/contribution";
		selection.position = selection.key === "video" ? 2 : 3;
	}
	const video = plan.muxings[0];
	if (video?.kind !== "FMP4" || !video.destination)
		throw new Error("Missing video fixture");
	video.segmentNamingTemplate = `picture_{rand_chars:8}_%number%.${extension}`;
	expect(video.segmentNaming).toBe("segment_%number%.m4s");
	video.initSegmentName = "picture-init.mp4";
	video.destination.path = "delivery/picture";
	plan.muxings.push({
		key: "ts-video",
		kind: "TS",
		streamKey: video.streamKey,
		additionalStreamKeys: ["a128"],
		segmentLength: 6,
		segmentNaming: "broadcast_%number%.ts",
		destination: {
			outputKey: video.destination.outputKey,
			path: "delivery/broadcast",
		},
	});
	const operations = compileLiveChannel(plan);
	const ids = new Map(
		operations.map((operation, index) => [operation.step, `resource-${index}`]),
	);
	const calls: { path: string; body: Record<string, unknown> }[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init: RequestInit) => {
			calls.push({
				path: new URL(url).pathname,
				body: JSON.parse(init.body as string),
			});
			return new Response(
				JSON.stringify({ data: { result: { id: "created" } } }),
				{
					status: 201,
					headers: { "content-type": "application/json" },
				},
			);
		}),
	);
	const sdk = createBitmovinSdkOps(
		{
			apiKey: "synthetic-only",
			tenantOrgId: null,
			bitmovinAccountId: "synthetic-account",
		},
		async () => {},
	);
	for (const operation of operations.filter(
		(operation) =>
			operation.kind === "CREATE_STREAM" ||
			operation.step === "muxing:v1080" ||
			operation.step === "muxing:ts-video",
	)) {
		await executeStep(operation, {
			sdk,
			ids,
			resolveCredential: vi.fn(),
			poll: { intervalMs: 1, timeoutMs: 50, sleep: async () => {} },
		});
	}
	const streams = calls.filter((call) => call.path.endsWith("/streams"));
	expect(streams).toHaveLength(4);
	for (const [index, call] of streams.entries()) {
		expect(call.body.inputStreams).toEqual([
			{
				inputId: ids.get(
					String(
						operations.find((operation) => operation.kind === "CREATE_STREAM")
							?.refs.inputId,
					),
				),
				inputPath: "/contribution",
				position: index < 3 ? 2 : 3,
			},
		]);
	}
	const fmp4 = calls.find((call) => call.path.endsWith("/muxings/fmp4"));
	expect(fmp4?.body).toMatchObject({
		segmentNamingTemplate: `picture_{rand_chars:8}_%number%.${extension}`,
		initSegmentName: "picture-init.mp4",
		outputs: [
			{
				outputId: ids.get(`output:${video.destination.outputKey}`),
				outputPath: "delivery/picture",
			},
		],
	});
	expect(fmp4?.body).not.toHaveProperty("segmentNaming");
	const ts = calls.find((call) => call.path.endsWith("/muxings/ts"));
	expect(ts?.body).toMatchObject({
		segmentNaming: "broadcast_%number%.ts",
		streams: [
			{ streamId: ids.get("stream:v1080") },
			{ streamId: ids.get("stream:a128") },
		],
		outputs: [
			{
				outputId: ids.get(`output:${video.destination.outputKey}`),
				outputPath: "delivery/broadcast",
			},
		],
	});
});
