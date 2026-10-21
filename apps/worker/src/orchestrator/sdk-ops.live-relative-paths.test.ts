import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	compileLiveChannel,
	liveChannelPlanSchema,
	validateLiveChannel,
} from "@bitovp/core";
import { afterEach, expect, it, vi } from "vitest";
import { executeStep } from "./executor";
import { createBitmovinSdkOps } from "./sdk-ops";

afterEach(() => vi.unstubAllGlobals());

it("serializes parent-relative paths for nested Live HLS and DASH manifests", async () => {
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
	const first = plan.muxings[0];
	if (first?.kind !== "FMP4" || !first.destination)
		throw new Error("Missing video muxing fixture");
	plan.muxings.push({
		...first,
		kind: "CMAF",
		key: "cmaf-video",
		destination: {
			...first.destination,
			path: "output/live-rtmp-simple/video-cmaf/1080p",
		},
	});
	for (const manifest of plan.liveManifests)
		manifest.destination.path = `output/live-rtmp-simple/${manifest.kind.toLowerCase()}-2`;
	expect(
		validateLiveChannel(plan).filter((issue) => issue.level === "error"),
	).toEqual([]);
	const operations = compileLiveChannel(plan);
	const ids = new Map(
		operations.map((operation, index) => [operation.step, `resource-${index}`]),
	);
	const paths = new Map([
		["muxing:v1080", "../video/1080p"],
		["muxing:a128", "../audio/128000"],
		["muxing:cmaf-video", "../video-cmaf/1080p"],
	]);
	const kinds = new Set([
		"CREATE_HLS_STREAM_INFO",
		"CREATE_HLS_AUDIO_MEDIA",
		"CREATE_DASH_REPRESENTATION_FMP4",
		"CREATE_DASH_REPRESENTATION_CMAF",
	]);
	const selected = operations.filter(
		(operation) =>
			kinds.has(operation.kind) && paths.has(String(operation.refs.muxingId)),
	);
	expect(selected).toHaveLength(5);
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
	const resolveCredential = vi.fn();
	for (const operation of selected) {
		await executeStep(operation, {
			sdk,
			ids,
			resolveCredential,
			poll: { intervalMs: 1, timeoutMs: 50, sleep: async () => {} },
		});
		const call = calls.at(-1);
		expect(call?.body.segmentPath).toBe(
			paths.get(String(operation.refs.muxingId)),
		);
		expect(call?.body.muxingId).toBe(ids.get(String(operation.refs.muxingId)));
		const manifest = ids.get(String(operation.refs.manifestId));
		if (operation.kind === "CREATE_HLS_STREAM_INFO")
			expect(call?.path).toBe(`/v1/encoding/manifests/hls/${manifest}/streams`);
		else if (operation.kind === "CREATE_HLS_AUDIO_MEDIA")
			expect(call?.path).toBe(
				`/v1/encoding/manifests/hls/${manifest}/media/audio`,
			);
		else {
			const period = ids.get(String(operation.refs.periodId));
			const adaptation = ids.get(String(operation.refs.adaptationSetId));
			const kind =
				operation.kind === "CREATE_DASH_REPRESENTATION_CMAF" ? "cmaf" : "fmp4";
			expect(call?.path).toBe(
				`/v1/encoding/manifests/dash/${manifest}/periods/${period}/adaptationsets/${adaptation}/representations/${kind}`,
			);
		}
	}
	expect(resolveCredential).not.toHaveBeenCalled();
});
