import { compilePlan, encodingPlanSchema } from "@bitovp/core";
import { describe, expect, it, vi } from "vitest";
import { type ExecutorContext, executeStep } from "./executor";
import { fakeSdk } from "./fake-sdk";
import type { SdkOps } from "./sdk-ops";

/**
 * The executor arms for the two whole-file muxings.
 *
 * What these have to keep true is narrow and easy to lose: the audio stream
 * reaches the gateway as an ADDITIONAL id (the container is one file holding
 * both), and a number the plan did not set stays unset — every segmented arm
 * beside these coerces a missing segment length to 6, and a whole file has no
 * such default in this app.
 */

function ctx(sdk: SdkOps, ids: Record<string, string> = {}): ExecutorContext {
	return {
		sdk,
		ids: new Map(Object.entries(ids)),
		resolveCredential: vi.fn(async () => ({
			provider: "AWS_S3" as const,
			config: {},
			secret: {
				accessKeyId: "AKIA-RESOLVED",
				secretAccessKey: "RESOLVED-SECRET",
			},
		})),
		poll: { intervalMs: 1, timeoutMs: 50, sleep: () => Promise.resolve() },
	};
}

const ids = {
	encoding: "bm-enc",
	"stream:v": "bm-video",
	"stream:a": "bm-audio",
	"output:out": "bm-output",
};
const refs = {
	encodingId: "encoding",
	streamId: "stream:v",
	additionalStreamIds: ["stream:a"],
	outputId: "output:out",
};

describe("CREATE_MUXING_PROGRESSIVE_TS", () => {
	it("hands the gateway the file, both streams and the numbers the plan set", async () => {
		const sdk = fakeSdk();
		const result = await executeStep(
			{
				step: "muxing:file",
				kind: "CREATE_MUXING_PROGRESSIVE_TS",
				payload: {
					filename: "video.ts",
					segmentLength: 4,
					startOffset: 0,
					outputPath: "files",
					acl: "PRIVATE",
					name: "Video Progressive TS Muxing 360p",
				},
				refs,
			},
			ctx(sdk, ids),
		);
		expect(sdk.createProgressiveTsMuxing).toHaveBeenCalledTimes(1);
		expect(sdk.createProgressiveTsMuxing).toHaveBeenCalledWith("bm-enc", {
			streamId: "bm-video",
			additionalStreamIds: ["bm-audio"],
			filename: "video.ts",
			segmentLength: 4,
			// Zero is a value: an executor that read it as "unset" would hand the
			// choice back to the encoder.
			startOffset: 0,
			destination: {
				outputId: "bm-output",
				outputPath: "files",
				acl: "PRIVATE",
			},
			name: "Video Progressive TS Muxing 360p",
		});
		expect(result.resourceId).toEqual(expect.any(String));
		// The segmented creator is a different endpoint and must not be the one
		// that ran.
		expect(sdk.createTsMuxing).not.toHaveBeenCalled();
	});

	it("leaves both numbers unset when the plan sets neither — no 6 is manufactured", async () => {
		const sdk = fakeSdk();
		await executeStep(
			{
				step: "muxing:file",
				kind: "CREATE_MUXING_PROGRESSIVE_TS",
				payload: { filename: "video.ts", outputPath: "files" },
				refs,
			},
			ctx(sdk, ids),
		);
		const sent = vi.mocked(sdk.createProgressiveTsMuxing).mock
			.calls[0]?.[1] as Record<string, unknown>;
		expect(sent.segmentLength).toBeUndefined();
		expect(sent.startOffset).toBeUndefined();
	});

	it("sends a video-only file as one stream", async () => {
		const sdk = fakeSdk();
		const { additionalStreamIds: _audio, ...videoOnly } = refs;
		await executeStep(
			{
				step: "muxing:file",
				kind: "CREATE_MUXING_PROGRESSIVE_TS",
				payload: { filename: "video.ts", outputPath: "files" },
				refs: videoOnly,
			},
			ctx(sdk, ids),
		);
		const sent = vi.mocked(sdk.createProgressiveTsMuxing).mock
			.calls[0]?.[1] as Record<string, unknown>;
		expect(sent.streamId).toBe("bm-video");
		expect(sent.additionalStreamIds).toBeUndefined();
	});

	it("refuses to call the API while the audio stream it names does not exist", async () => {
		// Bitmovin would accept the half-built container; the file would then
		// be delivered without the audio the plan asked for.
		const sdk = fakeSdk();
		const { "stream:a": _missing, ...withoutAudio } = ids;
		await expect(
			executeStep(
				{
					step: "muxing:file",
					kind: "CREATE_MUXING_PROGRESSIVE_TS",
					payload: { filename: "video.ts", outputPath: "files" },
					refs,
				},
				ctx(sdk, withoutAudio),
			),
		).rejects.toThrow();
		expect(sdk.createProgressiveTsMuxing).not.toHaveBeenCalled();
	});
});

describe("CREATE_MUXING_PROGRESSIVE_MOV", () => {
	it("hands the gateway the file and both streams", async () => {
		const sdk = fakeSdk();
		await executeStep(
			{
				step: "muxing:file",
				kind: "CREATE_MUXING_PROGRESSIVE_MOV",
				payload: {
					filename: "video.mov",
					outputPath: "files",
					name: "Video Progressive MOV Muxing 360p",
				},
				refs,
			},
			ctx(sdk, ids),
		);
		expect(sdk.createProgressiveMovMuxing).toHaveBeenCalledTimes(1);
		expect(sdk.createProgressiveMovMuxing).toHaveBeenCalledWith("bm-enc", {
			streamId: "bm-video",
			additionalStreamIds: ["bm-audio"],
			filename: "video.mov",
			destination: { outputId: "bm-output", outputPath: "files" },
			name: "Video Progressive MOV Muxing 360p",
		});
		expect(sdk.createMp4Muxing).not.toHaveBeenCalled();
		expect(sdk.createProgressiveTsMuxing).not.toHaveBeenCalled();
	});
});

describe("a compiled plan, run through the executor", () => {
	const plan = (kind: "PROGRESSIVE_TS" | "PROGRESSIVE_MOV") =>
		encodingPlanSchema.parse({
			planVersion: 1,
			name: "file",
			bitmovin: {},
			inputs: [
				{
					key: "in",
					kind: "S3",
					credentialId: "00000000-0000-4000-8000-000000000001",
					bucket: "b",
				},
			],
			outputs: [
				{
					key: "out",
					kind: "S3",
					credentialId: "00000000-0000-4000-8000-000000000002",
					bucket: "b",
				},
			],
			ingest: [
				{
					key: "video",
					inputKey: "in",
					inputPath: "a.mp4",
					selectionMode: "VIDEO_RELATIVE",
				},
				{
					key: "audio",
					inputKey: "in",
					inputPath: "a.mp4",
					selectionMode: "AUDIO_RELATIVE",
				},
			],
			renditions: [
				{
					key: "v",
					codec: "H264",
					ingestKey: "video",
					height: 360,
					bitrate: 800000,
				},
				{
					key: "a",
					codec: "AAC",
					ingestKey: "audio",
					bitrate: 128000,
					rate: 48000,
				},
			],
			muxings: [
				{
					key: "file",
					kind,
					streamKey: "v",
					additionalStreamKeys: ["a"],
					filename: kind === "PROGRESSIVE_TS" ? "video.ts" : "video.mov",
					destination: { outputKey: "out", path: "files" },
				},
			],
			manifests: [],
			generation: { timing: "POST_ENCODING" },
		});

	/** Every create up to the encoding start, with ids chained as the processor does. */
	async function runCreates(kind: "PROGRESSIVE_TS" | "PROGRESSIVE_MOV") {
		const sdk = fakeSdk();
		const context = ctx(sdk);
		for (const op of compilePlan(plan(kind))) {
			if (op.kind === "START_ENCODING") break;
			const result = await executeStep(op, context);
			if (typeof result.resourceId === "string") {
				context.ids.set(op.step, result.resourceId);
			}
		}
		return { sdk, ids: context.ids };
	}

	it("creates the TS file from the streams the plan's own steps created", async () => {
		const { sdk, ids: created } = await runCreates("PROGRESSIVE_TS");
		expect(created.get("stream:v")).toEqual(expect.any(String));
		expect(created.get("stream:a")).toEqual(expect.any(String));
		expect(created.get("stream:a")).not.toBe(created.get("stream:v"));
		expect(sdk.createProgressiveTsMuxing).toHaveBeenCalledTimes(1);
		const [encodingId, sent] = vi.mocked(sdk.createProgressiveTsMuxing).mock
			.calls[0] as [string, Record<string, unknown>];
		expect(encodingId).toBe(created.get("encoding"));
		expect(sent).toMatchObject({
			streamId: created.get("stream:v"),
			additionalStreamIds: [created.get("stream:a")],
			filename: "video.ts",
			destination: {
				outputId: created.get("output:out"),
				outputPath: "files",
			},
		});
		expect(created.get("muxing:file")).toEqual(expect.any(String));
	});

	it("creates the MOV file the same way", async () => {
		const { sdk, ids: created } = await runCreates("PROGRESSIVE_MOV");
		expect(sdk.createProgressiveMovMuxing).toHaveBeenCalledTimes(1);
		const [encodingId, sent] = vi.mocked(sdk.createProgressiveMovMuxing).mock
			.calls[0] as [string, Record<string, unknown>];
		expect(encodingId).toBe(created.get("encoding"));
		expect(sent).toMatchObject({
			streamId: created.get("stream:v"),
			additionalStreamIds: [created.get("stream:a")],
			filename: "video.mov",
		});
	});
});
