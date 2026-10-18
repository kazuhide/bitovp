import type { AppPrismaClient } from "@bitovp/db";
import { describe, expect, it, vi } from "vitest";
import {
	reconcileStartupSamples,
	recordFailedStartupSample,
	recordRunningStartupSample,
	startupSecondsFromLog,
} from "./startup-sample";

/**
 *  PR1 — the sampler's write contracts. The wiring (which arms
 * call these, and that restart NEVER does) is pinned in
 * live-processor.test.ts; here the module's own promises are: the queue/total
 * math, success-overwrites-provisional, failure-never-overwrites, and the
 * reconciler that records what a dead job could not.
 */

const CH = "11111111-1111-4111-8111-111111111111";

function entry(kind: string, startedAt: string, finishedAt: string | null) {
	return {
		step: kind.toLowerCase(),
		kind,
		status: "DONE",
		startedAt,
		finishedAt,
	};
}

describe("startupSecondsFromLog", () => {
	it("queue = the AWAIT pair; total = from the first step — Bitmovin's time isolated from ours", () => {
		const { queueSeconds, totalSeconds } = startupSecondsFromLog([
			entry(
				"CREATE_INPUT_RTMP",
				"2026-08-22T00:00:00Z",
				"2026-08-22T00:00:20Z",
			),
			entry("CREATE_ENCODING", "2026-08-22T00:00:20Z", "2026-08-22T00:00:30Z"),
			entry(
				"AWAIT_LIVE_RUNNING",
				"2026-08-22T00:00:40Z",
				"2026-08-22T00:03:40Z",
			),
		] as never);
		expect(queueSeconds).toBe(180);
		expect(totalSeconds).toBe(220);
	});

	it("answers nulls when the AWAIT pair is missing — never a fabricated number", () => {
		expect(
			startupSecondsFromLog([
				entry(
					"CREATE_ENCODING",
					"2026-08-22T00:00:00Z",
					"2026-08-22T00:00:10Z",
				),
			] as never),
		).toEqual({ queueSeconds: null, totalSeconds: null });
	});

	it("anchors total to THIS attempt — a resumed provision must not bill yesterday's clock", () => {
		const { queueSeconds, totalSeconds } = startupSecondsFromLog(
			[
				// Attempt 1's DONE steps keep their original stamps…
				entry(
					"CREATE_INPUT_RTMP",
					"2026-08-21T04:00:00Z",
					"2026-08-21T04:00:20Z",
				),
				// …and only the AWAIT re-ran this morning.
				entry(
					"AWAIT_LIVE_RUNNING",
					"2026-08-22T00:00:10Z",
					"2026-08-22T00:02:10Z",
				),
			] as never,
			"2026-08-22T00:00:00Z",
		);
		expect(queueSeconds).toBe(120);
		// 130s from the attempt's own start — NOT ~20h from entries[0].
		expect(totalSeconds).toBe(130);
	});

	it("refuses negative spans (clock skew) — null, not a negative sample", () => {
		const { queueSeconds } = startupSecondsFromLog([
			entry(
				"AWAIT_LIVE_RUNNING",
				"2026-08-22T00:10:00Z",
				"2026-08-22T00:00:00Z",
			),
		] as never);
		expect(queueSeconds).toBeNull();
	});
});

/**
 * A schema-valid live plan (the sweep test's product-built shape) — the
 * sampler's context read parses it with liveChannelPlanSchema, and a
 * hand-built near-miss would silently skip every write (safeParse → return).
 */
function samplePlan(): Record<string, unknown> {
	return {
		planVersion: 1,
		name: "startup-sample",
		bitmovin: {
			cloudRegion: "AWS_AP_NORTHEAST_1",
			encoderVersion: "STABLE",
			accountId: "490e5e74-2ea2-44c2-a8d6-0d51ba4ce84d",
		},
		liveInput: {
			key: "main",
			kind: "REDUNDANT_RTMP",
			name: "Redundant RTMP Input",
			staticIngestPoints: [
				{ name: "primary", streamKeyConfiguration: { type: "GENERATE" } },
			],
		},
		outputs: [
			{
				key: "origin",
				kind: "S3",
				credentialId: "4c885bd1-33ef-47b0-9506-3b765f91f324",
				bucket: "ap-northeast-1-output",
				name: "S3 Output",
			},
		],
		ingest: [
			{ key: "video", inputPath: "/", position: 0 },
			{ key: "audio", inputPath: "/", position: 1 },
		],
		renditions: [
			{
				key: "v720",
				ingestKey: "video",
				codec: "H264",
				name: "Live H264 720p",
				height: 720,
				bitrate: 3000000,
				level: null,
				presetConfiguration: "LIVE_STANDARD",
				mode: "STANDARD",
			},
			{
				key: "a128",
				ingestKey: "audio",
				codec: "AAC",
				bitrate: 128000,
				rate: 48000,
				channelLayout: "CL_STEREO",
			},
		],
		muxings: [
			{
				key: "v720",
				kind: "FMP4",
				streamKey: "v720",
				segmentLength: 6,
				segmentNaming: "segment_%number%.m4s",
				initSegmentName: "init.mp4",
				destination: { outputKey: "origin", path: "startup/video/720p" },
			},
			{
				key: "a128",
				kind: "FMP4",
				streamKey: "a128",
				segmentLength: 6,
				segmentNaming: "segment_%number%.m4s",
				initSegmentName: "init.mp4",
				destination: { outputKey: "origin", path: "startup/audio/128000" },
			},
		],
		liveManifests: [
			{
				key: "hls",
				kind: "HLS",
				manifestName: "stream.m3u8",
				name: "Live HLS Manifest",
				destination: { outputKey: "origin", path: "startup" },
				audioGroupId: "audio",
				audioLanguage: "en",
				closedCaptions: "NONE",
			},
		],
		start: { streamKey: "startuplaunch" },
	} as unknown as Record<string, unknown>;
}

/** Minimal stateful fake around the three tables the sampler touches. */
function makeDb(
	over: {
		sample?: { id: string } | null;
		stuckRuns?: Array<{ id: string; liveChannelId: string }>;
		purpose?: string | null;
	} = {},
) {
	const db = {
		liveChannel: {
			findUnique: vi.fn(async () => ({
				plan: samplePlan(),
				bitmovinAccountId: null,
				purpose: over.purpose ?? null,
			})),
		},
		liveChannelRun: {
			findFirst: vi.fn(async () => ({ id: "run-1" })),
			findMany: vi.fn(async () => over.stuckRuns ?? []),
			update: vi.fn(async () => ({})),
		},
		startupSample: {
			upsert: vi.fn(async () => ({})),
			findUnique: vi.fn(async () => over.sample ?? null),
			create: vi.fn(async () => ({})),
		},
	};
	return db;
}

describe("recordRunningStartupSample", () => {
	it("UPSERTS — the update arm flips a provisional FAILED back to the truth", async () => {
		const db = makeDb();
		await recordRunningStartupSample(
			db as unknown as AppPrismaClient,
			CH,
			[
				entry(
					"CREATE_ENCODING",
					"2026-08-22T00:00:00Z",
					"2026-08-22T00:00:10Z",
				),
				entry(
					"AWAIT_LIVE_RUNNING",
					"2026-08-22T00:00:10Z",
					"2026-08-22T00:02:10Z",
				),
			] as never,
			{ runId: "run-1" },
		);
		// The caller-named run skips the latest-run re-derivation entirely.
		expect(db.liveChannelRun.findFirst).not.toHaveBeenCalled();
		expect(db.startupSample.upsert).toHaveBeenCalledWith({
			where: { liveChannelRunId: "run-1" },
			create: expect.objectContaining({
				cloudRegion: "AWS_AP_NORTHEAST_1",
				source: "CHANNEL",
				outcome: "RUNNING",
				queueSeconds: 120,
				totalSeconds: 130,
			}),
			update: expect.objectContaining({
				outcome: "RUNNING",
				failedPhase: null,
				queueSeconds: 120,
			}),
		});
		expect(db.liveChannelRun.update).toHaveBeenCalledWith({
			where: { id: "run-1" },
			data: { queueSeconds: 120 },
		});
	});

	it("swallows storage failures — a statistics row must never break RUNNING", async () => {
		const db = makeDb();
		db.startupSample.upsert.mockRejectedValueOnce(new Error("db down"));
		const errorSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);
		try {
			await expect(
				recordRunningStartupSample(db as unknown as AppPrismaClient, CH, [
					entry(
						"AWAIT_LIVE_RUNNING",
						"2026-08-22T00:00:10Z",
						"2026-08-22T00:02:10Z",
					),
				] as never),
			).resolves.toBeUndefined();
			expect(errorSpy).toHaveBeenCalled();
		} finally {
			errorSpy.mockRestore();
		}
	});
});

describe("source follows the channel's purpose (ledger #160 PR4)", () => {
	it("a PROBE channel's sample records source PROBE — the populations stay apart", async () => {
		const db = makeDb({ purpose: "PROBE" });
		await recordRunningStartupSample(
			db as unknown as AppPrismaClient,
			CH,
			[
				entry(
					"AWAIT_LIVE_RUNNING",
					"2026-08-22T00:00:10Z",
					"2026-08-22T00:02:10Z",
				),
			] as never,
			{ runId: "run-1" },
		);
		expect(db.startupSample.upsert).toHaveBeenCalledWith(
			expect.objectContaining({
				create: expect.objectContaining({ source: "PROBE" }),
			}),
		);
	});
});

describe("recordFailedStartupSample", () => {
	it("creates when absent", async () => {
		const db = makeDb();
		await recordFailedStartupSample(
			db as unknown as AppPrismaClient,
			CH,
			"encoding",
		);
		expect(db.startupSample.create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				outcome: "FAILED",
				failedPhase: "encoding",
				liveChannelRunId: "run-1",
			}),
		});
	});

	it("NEVER overwrites an existing row — a later failure writer cannot erase the RUNNING truth", async () => {
		const db = makeDb({ sample: { id: "s-1" } });
		await recordFailedStartupSample(
			db as unknown as AppPrismaClient,
			CH,
			"encoding",
		);
		expect(db.startupSample.create).not.toHaveBeenCalled();
	});
});

describe("reconcileStartupSamples", () => {
	it("records a provisional FAILED per stuck PROVISIONING run", async () => {
		const db = makeDb({ stuckRuns: [{ id: "run-1", liveChannelId: CH }] });
		const n = await reconcileStartupSamples(
			db as unknown as AppPrismaClient,
			new Date("2026-08-22T01:00:00Z"),
		);
		expect(n).toBe(1);
		expect(db.liveChannelRun.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					status: "PROVISIONING",
					// 30-minute default deadline before a run counts as stuck.
					createdAt: { lt: new Date("2026-08-22T00:30:00Z") },
				},
			}),
		);
		expect(db.startupSample.create).toHaveBeenCalledWith({
			data: expect.objectContaining({ failedPhase: "stuck-provisioning" }),
		});
		// The reconciler names the STUCK run — never the latest-run read,
		// which would mis-attach the sample after a re-air.
		expect(db.liveChannelRun.findFirst).not.toHaveBeenCalled();
	});

	it("skips runs that already carry a sample — the reconciler re-covers, never re-writes", async () => {
		const db = makeDb({
			sample: { id: "s-1" },
			stuckRuns: [{ id: "run-1", liveChannelId: CH }],
		});
		const n = await reconcileStartupSamples(
			db as unknown as AppPrismaClient,
			new Date("2026-08-22T01:00:00Z"),
		);
		expect(n).toBe(0);
		expect(db.startupSample.create).not.toHaveBeenCalled();
	});
});
