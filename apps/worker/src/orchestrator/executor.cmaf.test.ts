import { readFileSync } from "node:fs";
import {
	type CompiledOperation,
	compileLiveChannel,
	compilePlan,
	encodingPlanSchema,
	liveChannelPlanSchema,
} from "@bitovp/core";
import { describe, expect, it, vi } from "vitest";
import { type ExecutorContext, executeStep } from "./executor";
import { fakeSdk } from "./fake-sdk";

function context(ops: CompiledOperation[], sdk = fakeSdk()): ExecutorContext {
	const ids = new Map<string, string>();
	for (const op of ops) {
		for (const value of Object.values(op.refs)) {
			if (typeof value === "string") ids.set(value, `provider:${value}`);
		}
	}
	return {
		sdk,
		ids,
		resolveCredential: vi.fn(async () => {
			throw new Error("No credentials required for these muxing operations");
		}),
		poll: { intervalMs: 1, timeoutMs: 50, sleep: async () => {} },
	};
}

describe("CMAF compiled worker execution", () => {
	it.each([
		"VOD",
		"LIVE",
	])("executes %s compiler output through dedicated CMAF facades", async (kind) => {
		const fixture =
			kind === "VOD"
				? "../../../../packages/core/src/plan/__fixtures__/fixed-bitrate-hls-on-aws.plan.json"
				: "../../../../packages/core/src/live/__fixtures__/live-rtmp-simple.plan.json";
		const raw = JSON.parse(
			readFileSync(new URL(fixture, import.meta.url), "utf8"),
		);
		raw.renditions = raw.renditions.filter(
			(r: { codec: string }) => r.codec === "H264" || r.codec === "AAC",
		);
		const keys = new Set(raw.renditions.map((r: { key: string }) => r.key));
		raw.muxings = raw.muxings
			.filter((m: { streamKey: string }) => keys.has(m.streamKey))
			.map((m: object) => ({
				...m,
				kind: "CMAF",
				framesPerCmafChunk: 2,
				initSegmentNameTemplate: "init-{rand_chars:8}.mp4",
				segmentNamingTemplate: "segment-{rand_chars:8}-%number%.m4s",
			}));
		const field = kind === "VOD" ? "manifests" : "liveManifests";
		raw[field] = [
			{
				key: "dash",
				kind: "DASH",
				manifestName: "stream.mpd",
				destination: raw[field][0].destination,
				videoMuxingKind: "CMAF",
				audioMuxingKind: "CMAF",
				representationType: "TEMPLATE",
			},
		];
		const ops =
			kind === "VOD"
				? compilePlan(encodingPlanSchema.parse(raw))
				: compileLiveChannel(liveChannelPlanSchema.parse(raw));
		const ctx = context(ops);
		for (const op of ops.filter(
			(op) =>
				op.kind === "CREATE_MUXING_CMAF" ||
				op.kind === "CREATE_DASH_REPRESENTATION_CMAF",
		)) {
			await executeStep(op, ctx);
		}
		expect(ctx.sdk.createCmafMuxing).toHaveBeenCalledTimes(raw.muxings.length);
		expect(ctx.sdk.createDashCmafRepresentation).toHaveBeenCalledTimes(
			raw.muxings.length,
		);
		const muxing = vi.mocked(ctx.sdk.createCmafMuxing).mock.calls[0]?.[1];
		expect(muxing).toMatchObject({
			framesPerCmafChunk: 2,
			initSegmentNameTemplate: "init-{rand_chars:8}.mp4",
		});
		expect(muxing?.initSegmentName).toBeUndefined();
		expect(muxing?.segmentNaming).toBeUndefined();
		expect(
			vi.mocked(ctx.sdk.createDashCmafRepresentation).mock.calls[0]?.[3],
		).toMatchObject({ type: "TEMPLATE", mode: "TEMPLATE_REPRESENTATION" });
		expect(ctx.sdk.createFmp4Muxing).not.toHaveBeenCalled();
		expect(ctx.sdk.createDashFmp4Representation).not.toHaveBeenCalled();
	});

	it("expands per-title CMAF results using their own representation endpoint", async () => {
		const op: CompiledOperation = {
			kind: "CREATE_DASH_PER_TITLE_REPRESENTATIONS",
			step: "dash:result",
			payload: {
				muxingKind: "CMAF",
				streamModeFilter: "PER_TITLE_RESULT",
				type: "TEMPLATE",
				mode: "TEMPLATE_REPRESENTATION",
				stripBase: "out/",
			},
			refs: {
				encodingId: "encoding",
				manifestId: "manifest",
				periodId: "period",
				adaptationSetId: "adaptation",
			},
		};
		const sdk = fakeSdk({
			listMuxings: vi.fn(async () => [
				{
					id: "mux-result",
					streamId: "stream-result",
					outputPath: "out/video/360p/",
				},
			]),
			getStreamContext: vi.fn(async () => ({
				mode: "PER_TITLE_RESULT",
				codecConfigId: "codec-result",
			})),
		});
		const result = await executeStep(op, context([op], sdk));
		expect(sdk.listMuxings).toHaveBeenCalledWith("provider:encoding", "CMAF");
		expect(sdk.createDashCmafRepresentation).toHaveBeenCalledWith(
			"provider:manifest",
			"provider:period",
			"provider:adaptation",
			{
				type: "TEMPLATE",
				mode: "TEMPLATE_REPRESENTATION",
				segmentPath: "video/360p/",
				encodingId: "provider:encoding",
				muxingId: "mux-result",
			},
		);
		expect(result.response).toMatchObject({ created: 1 });
		expect(sdk.createDashFmp4Representation).not.toHaveBeenCalled();
	});
});
