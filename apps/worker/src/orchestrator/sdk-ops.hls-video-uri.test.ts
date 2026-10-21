import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	compileLiveChannel,
	compilePlan,
	curlForStep,
	encodingPlanSchema,
	liveChannelPlanSchema,
	validateLiveChannel,
	validatePlan,
} from "@bitovp/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeStep } from "./executor";
import { createBitmovinSdkOps } from "./sdk-ops";

afterEach(() => vi.unstubAllGlobals());

function planFor(mode: "clear" | "CENC" | "FAIRPLAY") {
	const base = encodingPlanSchema.parse(
		JSON.parse(
			readFileSync(
				join(
					__dirname,
					"../../../../packages/core/src/plan/__fixtures__/fixed-bitrate-hls-on-aws.plan.json",
				),
				"utf8",
			),
		),
	);
	const groups = mode === "FAIRPLAY";
	return encodingPlanSchema.parse({
		...base,
		renditions: base.renditions.map((r) => ({
			...r,
			...(r.key === "v360"
				? {
						hlsVariantUri: groups ? "manual-{group}.m3u8" : "manual-video.m3u8",
					}
				: {}),
			...(groups && r.codec === "AAC"
				? { hlsMedia: { groupId: r.key, name: r.key, uri: `${r.key}.m3u8` } }
				: {}),
			...(groups && r.codec === "H264" ? { hlsVariantLabel: r.key } : {}),
		})),
		manifests: base.manifests.map((m) => ({
			...m,
			drmKind: mode === "clear" ? undefined : mode,
			variantsPerAudioGroup: groups,
		})),
		drm:
			mode === "clear"
				? []
				: base.muxings.map((m) => {
						if (!m.destination) throw new Error("Missing output fixture");
						return {
							key: `${m.key}-drm`,
							kind: mode,
							muxingKey: m.key,
							credentialId: "00000000-0000-4000-8000-000000000001",
							destination: {
								...m.destination,
								path: `${base.manifests[0]?.destination.path}encrypted/${m.key}`,
							},
							...(mode === "CENC"
								? {
										kid: "0123456789abcdef0123456789abcdef",
										encryptionMode: "CBC",
									}
								: {
										iv: "0123456789abcdef0123456789abcdef",
										uri: "skd://synthetic",
									}),
						};
					}),
	});
}

describe("installed SDK HLS video URI serialization", () => {
	it("keeps the shared Live URI bound to each additional manifest", async () => {
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
		const video = plan.renditions[0];
		const hls = plan.liveManifests.find((manifest) => manifest.kind === "HLS");
		if (!video || !hls) throw new Error("Missing Live fixture");
		video.hlsVariantUri = "live-main.m3u8";
		plan.liveManifests.push(
			...[2, 3].map((number) => ({
				...hls,
				key: `hls-${number}`,
				destination: {
					...hls.destination,
					path: `${hls.destination.path}/hls-${number}`,
				},
			})),
		);
		expect(
			validateLiveChannel(plan).filter((issue) => issue.level === "error"),
		).toEqual([]);
		const ops = compileLiveChannel(plan);
		const ids = new Map(
			ops.map((operation, index) => [operation.step, `resource-${index}`]),
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
		const variants = ops.filter(
			(operation) =>
				operation.kind === "CREATE_HLS_STREAM_INFO" &&
				operation.payload.uri === "live-main.m3u8",
		);
		expect(variants).toHaveLength(3);
		for (const operation of variants) {
			await executeStep(operation, {
				sdk,
				ids,
				resolveCredential,
				poll: { intervalMs: 1, timeoutMs: 50, sleep: async () => {} },
			});
			const call = calls.at(-1);
			expect(call?.path).toBe(
				`/v1/encoding/manifests/hls/${ids.get(String(operation.refs.manifestId))}/streams`,
			);
			expect(call?.body).toMatchObject({
				uri: "live-main.m3u8",
				segmentPath: operation.payload.segmentPath,
				streamId: ids.get(String(operation.refs.streamId)),
				muxingId: ids.get(String(operation.refs.muxingId)),
			});
		}
		expect(new Set(calls.map((call) => call.path)).size).toBe(3);
		expect(resolveCredential).not.toHaveBeenCalled();
	});
	it.each([
		"clear",
		"CENC",
		"FAIRPLAY",
	] as const)("keeps the exact URI and segment/DRM refs for %s", async (mode) => {
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
					{ status: 201, headers: { "content-type": "application/json" } },
				);
			}),
		);
		const plan = planFor(mode);
		expect(
			validatePlan(plan).filter((issue) => issue.level === "error"),
		).toEqual([]);
		const ops = compilePlan(plan);
		const ids = new Map(ops.map((op, index) => [op.step, `resource-${index}`]));
		const sdk = createBitmovinSdkOps(
			{
				apiKey: "synthetic-only",
				tenantOrgId: null,
				bitmovinAccountId: "synthetic-account",
			},
			async () => {},
		);
		const resolveCredential = vi.fn();
		const variants = ops.filter(
			(op) =>
				op.kind === "CREATE_HLS_STREAM_INFO" &&
				op.refs.streamId === "stream:v360",
		);
		expect(variants).toHaveLength(mode === "FAIRPLAY" ? 2 : 1);
		for (const op of variants) {
			const result = await executeStep(op, {
				sdk,
				ids,
				resolveCredential,
				poll: { intervalMs: 1, timeoutMs: 50, sleep: async () => {} },
			});
			const call = calls.at(-1);
			expect(call?.path).toBe(
				`/v1/encoding/manifests/hls/${ids.get(String(op.refs.manifestId))}/streams`,
			);
			expect(call?.body).toMatchObject({
				uri: op.payload.uri,
				segmentPath: op.payload.segmentPath,
				encodingId: ids.get(String(op.refs.encodingId)),
				streamId: ids.get("stream:v360"),
				muxingId: ids.get(String(op.refs.muxingId)),
			});
			expect(call?.body.drmId).toBe(
				op.refs.drmId ? ids.get(String(op.refs.drmId)) : undefined,
			);
			const copied = curlForStep({
				...op,
				status: "DONE",
				request: result.request,
			});
			expect(copied.ok && copied.command).toContain(
				`"uri": "${op.payload.uri}"`,
			);
		}
		expect(resolveCredential).not.toHaveBeenCalled();
	});
});
