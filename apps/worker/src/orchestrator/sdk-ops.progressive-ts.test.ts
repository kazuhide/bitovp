import { readFileSync } from "node:fs";
import {
	type CompiledOperation,
	compilePlan,
	encodingPlanSchema,
} from "@bitovp/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeStep } from "./executor";
import { createBitmovinSdkOps } from "./sdk-ops";

afterEach(() => vi.unstubAllGlobals());

function setup() {
	const calls: { path: string; body: Record<string, unknown> }[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init: RequestInit) => {
			calls.push({
				path: new URL(url).pathname,
				body: JSON.parse(init.body as string),
			});
			return new Response(
				JSON.stringify({ data: { result: { id: `offline-${calls.length}` } } }),
				{
					status: 201,
					headers: { "content-type": "application/json" },
				},
			);
		}),
	);
	return {
		calls,
		ctx: {
			sdk: createBitmovinSdkOps(
				{
					apiKey: "test-only",
					tenantOrgId: null,
					bitmovinAccountId: "account",
				},
				async () => {},
			),
			ids: new Map([
				["encoding", "encoding-id"],
				["input:main", "input-id"],
				["output:origin", "output-id"],
			]),
			resolveCredential: vi.fn(),
			poll: { intervalMs: 1, timeoutMs: 50, sleep: async () => {} },
		},
	};
}

describe("progressive TS SDK wire requests", () => {
	it("carries linked video/audio trim and concatenation graphs into one full-file muxing", async () => {
		const raw = JSON.parse(
			readFileSync(
				new URL(
					"../../../../packages/core/src/plan/__fixtures__/mp4-muxed-av-progressive.plan.json",
					import.meta.url,
				),
				"utf8",
			),
		);
		raw.trimmingStreams = ["video", "audio"].flatMap((track) => [
			{
				key: `${track}-part1`,
				kind: "TIME_BASED",
				sourceKey: track,
				offset: 1.25,
				duration: 2.5,
			},
			{
				key: `${track}-part2`,
				kind: "TIME_BASED",
				sourceKey: track,
				offset: 6,
				duration: 1.5,
			},
		]);
		raw.concatenationStreams = ["video", "audio"].map((track) => ({
			key: `${track}-joined`,
			sources: [
				{ sourceKey: `${track}-part2`, position: 0, isMain: true },
				{ sourceKey: `${track}-part1`, position: 1, isMain: false },
			],
		}));
		raw.renditions[0].ingestKey = "video-joined";
		raw.renditions[1].ingestKey = "audio-joined";
		raw.muxings[0] = {
			...raw.muxings[0],
			kind: "PROGRESSIVE_TS",
			filename: "timeline.ts",
			name: "Timeline TS",
			startOffset: 0,
		};
		const plan = encodingPlanSchema.parse(raw);
		const { calls, ctx } = setup();
		const mediaKinds = new Set([
			"CREATE_INGEST_INPUT_STREAM",
			"CREATE_TRIMMING_TIME_BASED",
			"CREATE_CONCATENATION_INPUT_STREAM",
			"CREATE_CODEC_H264",
			"CREATE_CODEC_AAC",
			"CREATE_STREAM",
			"CREATE_MUXING_PROGRESSIVE_TS",
		]);
		for (const op of compilePlan(plan)) {
			if (!mediaKinds.has(op.kind)) continue;
			const result = await executeStep(op, ctx);
			if (result.resourceId) ctx.ids.set(op.step, result.resourceId);
		}
		for (const track of ["video", "audio"]) {
			expect(calls).toContainEqual({
				path: "/v1/encoding/encodings/encoding-id/input-streams/trimming/time-based",
				body: {
					type: "TRIMMING_TIME_BASED",
					inputStreamId: ctx.ids.get(`ingest:${track}`),
					offset: 1.25,
					duration: 2.5,
				},
			});
			expect(calls).toContainEqual({
				path: "/v1/encoding/encodings/encoding-id/input-streams/concatenation",
				body: {
					type: "CONCATENATION",
					concatenation: [
						{
							inputStreamId: ctx.ids.get(`trim:${track}-part2`),
							position: 0,
							isMain: true,
						},
						{
							inputStreamId: ctx.ids.get(`trim:${track}-part1`),
							position: 1,
							isMain: false,
						},
					],
				},
			});
		}
		expect(
			calls
				.filter((call) => call.path.endsWith("/streams"))
				.map((call) => call.body.inputStreams),
		).toEqual([
			[{ inputStreamId: ctx.ids.get("concat:video-joined") }],
			[{ inputStreamId: ctx.ids.get("concat:audio-joined") }],
		]);
		expect(calls.at(-1)).toEqual({
			path: "/v1/encoding/encodings/encoding-id/muxings/progressive-ts",
			body: {
				type: "PROGRESSIVE_TS",
				filename: "timeline.ts",
				startOffset: 0,
				streams: [
					{ streamId: ctx.ids.get("stream:v1080") },
					{ streamId: ctx.ids.get("stream:a192") },
				],
				outputs: [
					{
						outputId: "output-id",
						outputPath: "output/mp4-muxed-av-progressive/",
						acl: [{ permission: "PUBLIC_READ" }],
					},
				],
				name: "Timeline TS",
			},
		});
		expect(ctx.resolveCredential).not.toHaveBeenCalled();
	});

	it("omits absent timestamp offset and keeps segmented TS on its existing endpoint", async () => {
		const { calls, ctx } = setup();
		ctx.ids.set("stream", "stream-id");
		await executeStep(
			{
				step: "file",
				kind: "CREATE_MUXING_PROGRESSIVE_TS",
				payload: { filename: "file.ts", outputPath: "out/" },
				refs: {
					encodingId: "encoding",
					streamId: "stream",
					outputId: "output:origin",
				},
			},
			ctx,
		);
		expect(calls[0]).toEqual({
			path: "/v1/encoding/encodings/encoding-id/muxings/progressive-ts",
			body: {
				type: "PROGRESSIVE_TS",
				filename: "file.ts",
				streams: [{ streamId: "stream-id" }],
				outputs: [{ outputId: "output-id", outputPath: "out/" }],
			},
		});
		await executeStep(
			{
				step: "segments",
				kind: "CREATE_MUXING_TS",
				payload: {
					segmentLength: 6,
					segmentNaming: "seg_%number%.ts",
					outputPath: "out/",
				},
				refs: {
					encodingId: "encoding",
					streamId: "stream",
					outputId: "output:origin",
				},
			},
			ctx,
		);
		expect(calls[1]?.path).toBe(
			"/v1/encoding/encodings/encoding-id/muxings/ts",
		);
		expect(calls[1]?.body).toMatchObject({
			type: "TS",
			segmentLength: 6,
			segmentNaming: "seg_%number%.ts",
		});
		expect(calls[1]?.body).not.toHaveProperty("filename");
	});

	it("refuses an unresolved carried-audio stream before any request", async () => {
		const { calls, ctx } = setup();
		ctx.ids.set("video", "video-id");
		const op: CompiledOperation = {
			step: "file",
			kind: "CREATE_MUXING_PROGRESSIVE_TS",
			payload: { filename: "file.ts" },
			refs: {
				encodingId: "encoding",
				streamId: "video",
				additionalStreamIds: ["missing-audio"],
			},
		};
		await expect(executeStep(op, ctx)).rejects.toThrow(
			/additionalStreamIds.*not resolved/,
		);
		expect(calls).toEqual([]);
	});
});
