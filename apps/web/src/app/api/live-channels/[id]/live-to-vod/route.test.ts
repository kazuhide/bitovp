import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	compileLiveChannel,
	initStepLog,
	liveChannelPlanSchema,
} from "@bitovp/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const findUnique = vi.fn();
const updateMany = vi.fn();
const runFindUnique = vi.fn();
const runUpdateMany = vi.fn();
const queueAdd = vi.fn();
const queueGetJob = vi.fn();

const prisma = {
	liveChannel: { findUnique, updateMany },
	liveChannelRun: { findUnique: runFindUnique, updateMany: runUpdateMany },
	$transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
};

vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({
		prisma,
	}),
}));

vi.mock("@/lib/server/queue", () => ({
	getLiveChannelQueue: () => ({ add: queueAdd, getJob: queueGetJob }),
}));

vi.mock("@bitovp/core", async () => {
	const actual =
		await vi.importActual<typeof import("@bitovp/core")>("@bitovp/core");
	return { ...actual, masterKeyFromEnv: () => Buffer.alloc(32) };
});

import { POST } from "./route";

const CHANNEL_ID = "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a";
const RUN_ID = "11111111-1111-4111-8111-111111111111";
const params = { params: Promise.resolve({ id: CHANNEL_ID }) };

const providerIdentity = (manifestName: string) => ({
	attemptId: "prior-attempt",
	encodingId: "bm-live-enc",
	outputId: "bm-out",
	outputPath: "output/ch",
	manifestName,
});

function postRequest(body: unknown = {}): Request {
	return new Request("http://test/live-to-vod", {
		method: "POST",
		body: JSON.stringify(body),
	});
}

/**
 * A provisioned channel's step log, reduced to what C35 reads: where the
 * muxings write. `stream.m3u8` beside them is the live manifest the VOD roll
 * must not overwrite.
 */
const STEP_LOG = [
	{
		step: "output:origin",
		kind: "CREATE_OUTPUT_S3",
		payload: {},
		refs: {},
		status: "DONE",
		resourceId: "bm-output-origin",
	},
	{
		step: "muxing:v1080",
		kind: "CREATE_MUXING_FMP4",
		payload: { outputPath: "output/ch/video/1080p" },
		refs: {},
		status: "DONE",
	},
	{
		step: "muxing:a128",
		kind: "CREATE_MUXING_FMP4",
		payload: { outputPath: "output/ch/audio/128000" },
		refs: {},
		status: "DONE",
	},
	{
		step: "manifest:hls",
		kind: "CREATE_MANIFEST_HLS",
		payload: { outputPath: "output/ch", manifestName: "stream.m3u8" },
		refs: {},
		status: "DONE",
	},
];

function channel(overrides: Record<string, unknown> = {}) {
	return {
		updatedAt: new Date("2026-08-29T00:44:25.590Z"),
		id: CHANNEL_ID,
		status: "STOPPED",
		bitmovinEncodingId: "bm-live-enc",
		liveToVod: null,
		stepLog: STEP_LOG,
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	updateMany.mockResolvedValue({ count: 1 });
	runFindUnique.mockResolvedValue({
		id: RUN_ID,
		liveChannelId: CHANNEL_ID,
	});
	runUpdateMany.mockResolvedValue({ count: 1 });
	queueAdd.mockResolvedValue(undefined);
	queueGetJob.mockResolvedValue(undefined);
});

describe("POST /api/live-channels/[id]/live-to-vod", () => {
	it("claims the liveToVod record and enqueues the worker action", async () => {
		findUnique.mockResolvedValue(channel());
		const res = await POST(postRequest({ manifests: ["HLS"] }), params);
		expect(res.status).toBe(200);
		await expect(res.json()).resolves.toMatchObject({
			action: "live-to-vod",
			status: "RUNNING",
		});
		// The claim is on liveToVod, NOT on status — a live-to-VOD run must
		// never move the channel out of STOPPED.
		const claim = updateMany.mock.calls[0]?.[0];
		expect(claim.where).toMatchObject({ id: CHANNEL_ID, status: "STOPPED" });
		// : the lock is the row's `updatedAt` as READ — never a filter
		// on the Json column. `liveToVod: { equals: DB_NULL }` matched nothing in
		// the deployed image on a SQL-NULL column, so every roll 409ed.
		expect(claim.where).toMatchObject({
			updatedAt: new Date("2026-08-29T00:44:25.590Z"),
		});
		expect(claim.where).not.toHaveProperty("liveToVod");
		expect(claim.data.liveToVod).toMatchObject({
			status: "RUNNING",
			manifests: [],
		});
		expect(claim.data).not.toHaveProperty("status");
		expect(queueAdd).toHaveBeenCalledWith(
			"live-channel",
			expect.objectContaining({
				liveChannelId: CHANNEL_ID,
				action: "live-to-vod",
				params: { manifests: ["HLS"] },
				attemptId: claim.data.liveToVod.attemptId,
				liveChannelRunId: RUN_ID,
			}),
			expect.objectContaining({
				// A dash, not a colon: BullMQ 5 rejects a custom id containing `:`, so this route
				// returned HTTP 500 against a real queue while the mock accepted it happily.
				jobId: expect.stringContaining("-live-to-vod-"),
			}),
		);
	});

	it("409s on a channel that is not STOPPED (a growing recording truncates)", async () => {
		findUnique.mockResolvedValue(channel({ status: "RUNNING" }));
		const res = await POST(postRequest(), params);
		expect(res.status).toBe(409);
		await expect(res.json()).resolves.toMatchObject({
			error: expect.stringContaining("STOPPED"),
		});
		expect(queueAdd).not.toHaveBeenCalled();
	});

	it("409s while a run is already in progress, and when the claim loses a race", async () => {
		findUnique.mockResolvedValue(
			channel({ liveToVod: { status: "RUNNING", manifests: [] } }),
		);
		expect((await POST(postRequest(), params)).status).toBe(409);
		expect(queueAdd).not.toHaveBeenCalled();

		// A finished run may be re-run — but if the row changed underneath,
		// the atomic claim matches nothing.
		findUnique.mockResolvedValue(
			channel({ liveToVod: { status: "FINISHED", manifests: [] } }),
		);
		updateMany.mockResolvedValue({ count: 0 });
		const raced = await POST(postRequest(), params);
		expect(raced.status).toBe(409);
		await expect(raced.json()).resolves.toMatchObject({
			error: expect.stringContaining("changed"),
		});
		expect(queueAdd).not.toHaveBeenCalled();
	});

	it("409s when the channel never provisioned an encoding", async () => {
		findUnique.mockResolvedValue(channel({ bitmovinEncodingId: null }));
		expect((await POST(postRequest(), params)).status).toBe(409);
		expect(queueAdd).not.toHaveBeenCalled();
	});

	it("rejects a malformed new-format record before a retry can create another provider manifest", async () => {
		findUnique.mockResolvedValue(
			channel({
				liveToVod: {
					status: "RUNNING",
					manifests: [],
					families: [
						{
							type: "HLS",
							status: "PENDING",
							providerIdentity: providerIdentity("vod.m3u8"),
							// Missing createIntent: the provider POST outcome is unknown.
						},
					],
				},
			}),
		);

		const res = await POST(postRequest({ manifests: ["HLS"] }), params);
		expect(res.status).toBe(409);
		await expect(res.json()).resolves.toMatchObject({
			details: { code: "L2V_RECORD_INVALID" },
		});
		expect(updateMany).not.toHaveBeenCalled();
		expect(runUpdateMany).not.toHaveBeenCalled();
		expect(queueAdd).not.toHaveBeenCalled();
	});

	it("records ERROR on the record (not the channel) when the enqueue fails", async () => {
		findUnique.mockResolvedValue(channel());
		queueAdd.mockRejectedValue(new Error("redis down"));
		const res = await POST(postRequest(), params);
		expect(res.status).toBe(503);
		await expect(res.json()).resolves.toMatchObject({
			details: { code: "L2V_ENQUEUE_FAILED" },
		});
		const recovery = updateMany.mock.calls[1]?.[0];
		expect(recovery.data.liveToVod).toMatchObject({
			status: "ERROR",
			errorCode: "L2V_ENQUEUE_FAILED",
		});
		expect(recovery.data).not.toHaveProperty("status");
		expect(runUpdateMany.mock.calls[1]?.[0].data.liveToVod).toEqual(
			recovery.data.liveToVod,
		);
	});

	it("reconciles a lost queue.add response by the exact deterministic job identity", async () => {
		findUnique.mockResolvedValue(channel());
		queueAdd.mockRejectedValue(new Error("response lost"));
		queueGetJob.mockImplementation(async (jobId: string) => {
			const claim = updateMany.mock.calls[0]?.[0].data.liveToVod;
			return {
				id: jobId,
				data: {
					liveChannelId: CHANNEL_ID,
					action: "live-to-vod",
					attemptId: claim.attemptId,
					liveChannelRunId: RUN_ID,
					encodingId: "bm-live-enc",
				},
			};
		});

		const res = await POST(postRequest({ manifests: ["HLS"] }), params);
		expect(res.status).toBe(200);
		await expect(res.json()).resolves.toMatchObject({
			status: "RUNNING",
			reconciled: true,
			attemptId: expect.any(String),
		});
		expect(queueAdd).toHaveBeenCalledTimes(1);
		// Only the original channel+run claim was written: response loss is not
		// interpreted as enqueue failure and cannot mint a second attempt.
		expect(updateMany).toHaveBeenCalledTimes(1);
		expect(runUpdateMany).toHaveBeenCalledTimes(1);
	});

	it("fails closed when a lost enqueue response cannot be reconciled", async () => {
		findUnique.mockResolvedValue(channel());
		queueAdd.mockRejectedValue(new Error("response lost"));
		queueGetJob.mockRejectedValue(new Error("redis unavailable"));

		const res = await POST(postRequest({ manifests: ["HLS"] }), params);
		expect(res.status).toBe(503);
		await expect(res.json()).resolves.toMatchObject({
			details: { attemptId: expect.any(String) },
		});
		expect(updateMany).toHaveBeenCalledTimes(1);
		expect(runUpdateMany).toHaveBeenCalledTimes(1);
	});

	it("keeps the claim when a lost-response job id resolves to a different identity", async () => {
		findUnique.mockResolvedValue(channel());
		queueAdd.mockRejectedValue(new Error("response lost"));
		queueGetJob.mockImplementation(async (jobId: string) => ({
			id: jobId,
			data: {
				liveChannelId: CHANNEL_ID,
				action: "live-to-vod",
				attemptId: "different-attempt",
				liveChannelRunId: RUN_ID,
				encodingId: "bm-live-enc",
			},
		}));

		const res = await POST(postRequest({ manifests: ["HLS"] }), params);
		expect(res.status).toBe(503);
		await expect(res.json()).resolves.toMatchObject({
			details: {
				code: "L2V_QUEUE_STATE_UNKNOWN",
				attemptId: expect.any(String),
			},
		});
		// The different queue job may still execute. Releasing this claim would
		// authorize a second attempt while that identity remains unresolved.
		expect(updateMany).toHaveBeenCalledTimes(1);
		expect(runUpdateMany).toHaveBeenCalledTimes(1);
	});

	it("returns the same active attempt and never enqueues a duplicate", async () => {
		const existing = {
			status: "RUNNING",
			attemptId: "attempt-active",
			revision: 0,
			queueJobId: "queue-active",
			liveChannelRunId: RUN_ID,
			manifests: [],
			families: [{ type: "HLS", status: "PENDING" }],
		};
		findUnique.mockResolvedValue(channel({ liveToVod: existing }));
		queueGetJob.mockResolvedValue({
			id: "queue-active",
			data: {
				liveChannelId: CHANNEL_ID,
				action: "live-to-vod",
				attemptId: "attempt-active",
				liveChannelRunId: RUN_ID,
				encodingId: "bm-live-enc",
			},
			getState: vi.fn(async () => "active"),
		});

		const res = await POST(postRequest(), params);
		expect(res.status).toBe(200);
		await expect(res.json()).resolves.toMatchObject({
			attemptId: "attempt-active",
			reconciled: true,
		});
		expect(queueAdd).not.toHaveBeenCalled();
		expect(updateMany).not.toHaveBeenCalled();
	});

	it("keeps the same attempt while BullMQ has queued an automatic retry after a provider error", async () => {
		const existing = {
			status: "ERROR",
			attemptId: "attempt-retrying",
			revision: 7,
			queueJobId: "queue-retrying",
			liveChannelRunId: RUN_ID,
			outputKey: "origin",
			finishedAt: "2026-08-31T00:01:00.000Z",
			errorCode: "L2V_PROVIDER_CREATE_FAILED",
			manifests: [],
			families: [
				{
					type: "HLS",
					status: "ERROR",
					errorCode: "L2V_PROVIDER_CREATE_FAILED",
					providerIdentity: providerIdentity("vod.m3u8"),
					createIntent: {
						ownerToken: "first-worker-token",
						status: "CREATE_PENDING",
						requestedAt: "2026-08-31T00:00:00.000Z",
					},
				},
			],
		};
		findUnique.mockResolvedValue(channel({ liveToVod: existing }));
		queueGetJob.mockResolvedValue({
			id: "queue-retrying",
			data: {
				liveChannelId: CHANNEL_ID,
				action: "live-to-vod",
				attemptId: "attempt-retrying",
				liveChannelRunId: RUN_ID,
				encodingId: "bm-live-enc",
			},
			getState: vi.fn(async () => "waiting"),
		});

		const res = await POST(postRequest({ manifests: ["HLS"] }), params);
		expect(res.status).toBe(200);
		await expect(res.json()).resolves.toMatchObject({
			status: "RUNNING",
			attemptId: "attempt-retrying",
			reconciled: true,
		});
		expect(queueAdd).not.toHaveBeenCalled();
		expect(updateMany).not.toHaveBeenCalled();
		expect(runUpdateMany).not.toHaveBeenCalled();
	});

	it("fails closed when a parked queue id has the wrong encoding identity", async () => {
		findUnique.mockResolvedValue(
			channel({
				liveToVod: {
					status: "RUNNING",
					attemptId: "attempt-active",
					revision: 0,
					queueJobId: "queue-active",
					liveChannelRunId: RUN_ID,
					manifests: [],
					families: [{ type: "HLS", status: "PENDING" }],
				},
			}),
		);
		queueGetJob.mockResolvedValue({
			id: "queue-active",
			data: {
				liveChannelId: CHANNEL_ID,
				action: "live-to-vod",
				attemptId: "attempt-active",
				liveChannelRunId: RUN_ID,
				encodingId: "different-encoding",
			},
			getState: vi.fn(async () => "active"),
		});

		const res = await POST(postRequest(), params);
		expect(res.status).toBe(503);
		expect(queueAdd).not.toHaveBeenCalled();
		// A different job may still execute: never release this attempt and mint
		// another provider create from an ambiguous queue identity.
		expect(updateMany).not.toHaveBeenCalled();
	});

	it("fails closed when the exact queue job state cannot be resolved", async () => {
		findUnique.mockResolvedValue(
			channel({
				liveToVod: {
					status: "RUNNING",
					attemptId: "attempt-active",
					revision: 0,
					queueJobId: "queue-active",
					liveChannelRunId: RUN_ID,
					manifests: [],
					families: [{ type: "HLS", status: "PENDING" }],
				},
			}),
		);
		queueGetJob.mockResolvedValue({
			id: "queue-active",
			data: {
				liveChannelId: CHANNEL_ID,
				action: "live-to-vod",
				attemptId: "attempt-active",
				liveChannelRunId: RUN_ID,
				encodingId: "bm-live-enc",
			},
			getState: vi.fn(async () => {
				throw new Error("redis read failed");
			}),
		});

		const res = await POST(postRequest(), params);
		expect(res.status).toBe(503);
		expect(updateMany).not.toHaveBeenCalled();
	});

	it("fails closed when the exact queue job returns an unrecognized state", async () => {
		findUnique.mockResolvedValue(
			channel({
				liveToVod: {
					status: "RUNNING",
					attemptId: "attempt-active",
					revision: 0,
					queueJobId: "queue-active",
					liveChannelRunId: RUN_ID,
					manifests: [],
					families: [{ type: "HLS", status: "PENDING" }],
				},
			}),
		);
		queueGetJob.mockResolvedValue({
			id: "queue-active",
			data: {
				liveChannelId: CHANNEL_ID,
				action: "live-to-vod",
				attemptId: "attempt-active",
				liveChannelRunId: RUN_ID,
				encodingId: "bm-live-enc",
			},
			getState: vi.fn(async () => "mystery-provider-state"),
		});

		const res = await POST(postRequest(), params);
		expect(res.status).toBe(503);
		await expect(res.json()).resolves.toMatchObject({
			details: { code: "L2V_QUEUE_STATE_UNKNOWN" },
		});
		expect(updateMany).not.toHaveBeenCalled();
	});

	it("releases a stale RUNNING record on both exact rows when its queue job is gone", async () => {
		findUnique.mockResolvedValue(
			channel({
				liveToVod: {
					status: "RUNNING",
					attemptId: "attempt-dead",
					revision: 0,
					queueJobId: "queue-dead",
					liveChannelRunId: RUN_ID,
					manifests: [],
					families: [{ type: "HLS", status: "PENDING" }],
				},
			}),
		);
		queueGetJob.mockResolvedValue(undefined);

		const res = await POST(postRequest(), params);
		expect(res.status).toBe(409);
		expect(queueAdd).not.toHaveBeenCalled();
		const channelRelease = updateMany.mock.calls[0]?.[0];
		const runRelease = runUpdateMany.mock.calls[0]?.[0];
		expect(channelRelease.data.liveToVod).toMatchObject({
			status: "ERROR",
			errorCode: "L2V_JOB_DIED",
			families: [{ status: "ERROR", errorCode: "L2V_JOB_DIED" }],
		});
		expect(runRelease.data.liveToVod).toEqual(channelRelease.data.liveToVod);
	});

	it("queues a new exact attempt after the dead attempt release, retaining its provider identity for reconciliation", async () => {
		const identity = {
			attemptId: "attempt-dead",
			encodingId: "bm-live-enc",
			outputId: "bm-output-origin",
			outputPath: "output/ch",
			manifestName: "vod.m3u8",
		};
		findUnique.mockResolvedValueOnce(
			channel({
				liveToVod: {
					status: "RUNNING",
					attemptId: "attempt-dead",
					revision: 0,
					queueJobId: "queue-dead",
					liveChannelRunId: RUN_ID,
					outputKey: "origin",
					manifests: [],
					families: [
						{
							type: "HLS",
							status: "RUNNING",
							providerIdentity: identity,
							manifestId: "provider-hls",
						},
					],
				},
			}),
		);
		queueGetJob.mockResolvedValue(undefined);

		const releasedResponse = await POST(
			postRequest({ manifests: ["HLS"] }),
			params,
		);
		expect(releasedResponse.status).toBe(409);
		const released = updateMany.mock.calls[0]?.[0].data.liveToVod as Record<
			string,
			unknown
		>;
		expect(released).toMatchObject({
			status: "ERROR",
			attemptId: "attempt-dead",
			revision: 1,
			families: [
				{
					status: "ERROR",
					manifestId: "provider-hls",
					providerIdentity: identity,
				},
			],
		});

		findUnique.mockResolvedValueOnce(channel({ liveToVod: released }));
		const retryResponse = await POST(
			postRequest({ manifests: ["HLS"] }),
			params,
		);
		expect(retryResponse.status).toBe(200);
		const retryClaim = updateMany.mock.calls[1]?.[0].data.liveToVod;
		expect(retryClaim.attemptId).not.toBe("attempt-dead");
		expect(retryClaim).toMatchObject({
			status: "RUNNING",
			revision: 0,
			families: [
				{
					status: "ERROR",
					manifestId: "provider-hls",
					providerIdentity: identity,
				},
			],
		});
		expect(queueAdd).toHaveBeenCalledTimes(1);
		expect(queueAdd).toHaveBeenCalledWith(
			"live-channel",
			expect.objectContaining({
				attemptId: retryClaim.attemptId,
				liveChannelRunId: RUN_ID,
				encodingId: "bm-live-enc",
			}),
			expect.objectContaining({ jobId: retryClaim.queueJobId }),
		);
	});

	it("rejects an unknown manifest family", async () => {
		findUnique.mockResolvedValue(channel());
		const res = await POST(postRequest({ manifests: ["SMOOTH"] }), params);
		expect(res.status).toBe(400);
		expect(queueAdd).not.toHaveBeenCalled();
	});

	/**
	 * C35 / . A default manifest must sit ABOVE every muxing it lists
	 * or Bitmovin refuses it with `code 2701`. The worker holds the same rule
	 * (it is the single writer), but letting a typo through here costs a
	 * claimed record, a queued job and its retries before the operator is told
	 * anything — so the unusable path is refused where it was typed.
	 */
	it("400s an explicit manifest path that is not a parent of the recording, without claiming", async () => {
		findUnique.mockResolvedValue(channel());
		const res = await POST(postRequest({ path: "archive/2026/vod" }), params);
		expect(res.status).toBe(400);
		await expect(res.json()).resolves.toMatchObject({
			// The reason, the offending muxing and the path that WOULD work.
			error: expect.stringContaining("2701"),
		});
		await expect(
			POST(postRequest({ path: "archive/2026/vod" }), params).then((r) =>
				r.json(),
			),
		).resolves.toMatchObject({
			error: expect.stringContaining("output/ch"),
		});
		expect(updateMany).not.toHaveBeenCalled();
		expect(queueAdd).not.toHaveBeenCalled();
	});

	it("accepts an explicit path that IS a parent of the recording", async () => {
		findUnique.mockResolvedValue(channel());
		const res = await POST(postRequest({ path: "output" }), params);
		expect(res.status).toBe(200);
		expect(queueAdd).toHaveBeenCalledWith(
			"live-channel",
			expect.objectContaining({ params: { path: "output" } }),
			expect.anything(),
		);
	});

	it("400s a channel whose step log cannot be read, instead of claiming and letting the job fail", async () => {
		// review-357 suggestion 4. The pre-check used to no-op on a parse
		// failure and fall through: the record was claimed, the job queued, and
		// the operator learned nothing until a generic worker error minutes
		// later. No step log = no muxing paths = no derivable destination.
		findUnique.mockResolvedValue(channel({ stepLog: { not: "an array" } }));
		const res = await POST(postRequest(), params);
		expect(res.status).toBe(400);
		await expect(res.json()).resolves.toMatchObject({
			error: expect.stringContaining("step log"),
		});
		expect(updateMany).not.toHaveBeenCalled();
		expect(queueAdd).not.toHaveBeenCalled();
	});

	/**
	 * A DASH default manifest
	 * enumerates fMP4 muxings only; over a segmented-TS recording the provider
	 * refuses it (400 / code 2700). The default is therefore the family set the
	 * RECORDED muxings support, and an explicit incompatible family is refused
	 * with 422 before the claim, the queue and any provider call.
	 */
	describe("muxing-compatible families (ledger #283)", () => {
		/** The audit's own topology: audio muxed into each TS variant, HLS only. */
		const TS_STEP_LOG = [
			{
				step: "output:origin",
				kind: "CREATE_OUTPUT_S3",
				payload: {},
				refs: {},
				status: "DONE",
				resourceId: "bm-output-origin",
			},
			{
				step: "muxing:v540",
				kind: "CREATE_MUXING_TS",
				payload: { outputPath: "output/ch/video/540p" },
				refs: {},
				status: "DONE",
			},
			{
				step: "muxing:v720",
				kind: "CREATE_MUXING_TS",
				payload: { outputPath: "output/ch/video/720p" },
				refs: {},
				status: "DONE",
			},
			{
				step: "manifest:hls",
				kind: "CREATE_MANIFEST_HLS",
				payload: { outputPath: "output/ch/video", manifestName: "stream.m3u8" },
				refs: {},
				status: "DONE",
			},
		];

		it("422s an explicit DASH over a TS recording BEFORE claiming or enqueueing, naming what would work", async () => {
			findUnique.mockResolvedValue(channel({ stepLog: TS_STEP_LOG }));
			for (const manifests of [["DASH"], ["HLS", "DASH"]]) {
				const res = await POST(postRequest({ manifests }), params);
				expect(res.status).toBe(422);
				const body = (await res.json()) as {
					error: string;
					details?: { supported?: string[] };
				};
				expect(body.error).toMatch(/DASH cannot be generated/);
				expect(body.error).toMatch(/muxing:v540/);
				expect(body.error).toMatch(/2700/);
				expect(body.details?.supported).toEqual(["HLS"]);
			}
			expect(updateMany).not.toHaveBeenCalled();
			expect(queueAdd).not.toHaveBeenCalled();
		});

		const ARCHIVE_ENTRY = {
			step: "muxing:archive",
			kind: "CREATE_MUXING_MP4",
			payload: { outputPath: "output/ch/archive", filename: "recording.mp4" },
			refs: {},
			status: "DONE",
		};

		it("an explicit HLS over a TS + MP4-archive recording claims — the archive is not a family blocker (row #323)", async () => {
			findUnique.mockResolvedValue(
				channel({ stepLog: [...TS_STEP_LOG, ARCHIVE_ENTRY] }),
			);
			const res = await POST(postRequest({ manifests: ["HLS"] }), params);
			expect(res.status).toBe(200);
			const claim = updateMany.mock.calls[0]?.[0];
			expect(claim.data.liveToVod.families).toEqual([
				{ type: "HLS", status: "PENDING" },
			]);
		});

		it("422s a derived default that holds no family instead of claiming an empty roll (row #323)", async () => {
			findUnique.mockResolvedValue(
				channel({
					stepLog: [
						TS_STEP_LOG[0],
						{ ...TS_STEP_LOG[1], kind: "CREATE_MUXING_WEBM" },
					],
				}),
			);
			const res = await POST(postRequest(), params);
			expect(res.status).toBe(422);
			const body = (await res.json()) as {
				details?: { supported?: string[] };
			};
			expect(body.details?.supported).toEqual([]);
			expect(updateMany).not.toHaveBeenCalled();
			expect(queueAdd).not.toHaveBeenCalled();
		});

		it("a TS default claims HLS PENDING and records DASH as SKIPPED_UNSUPPORTED, forwarding the empty body", async () => {
			findUnique.mockResolvedValue(channel({ stepLog: TS_STEP_LOG }));
			const res = await POST(postRequest(), params);
			expect(res.status).toBe(200);
			const claim = updateMany.mock.calls[0]?.[0];
			expect(claim.data.liveToVod).toMatchObject({
				status: "RUNNING",
				requestedAt: expect.any(String),
				attemptId: expect.any(String),
				queueJobId: expect.stringContaining("-live-to-vod-"),
				liveChannelRunId: RUN_ID,
				outputKey: "origin",
				families: [
					{ type: "HLS", status: "PENDING" },
					{
						type: "DASH",
						status: "SKIPPED_UNSUPPORTED",
						reasonCode: "L2V_UNSUPPORTED_FAMILY",
						reason: expect.stringMatching(/2700/),
					},
				],
				manifests: [],
			});
			// The worker derives the same default from the same step log; the
			// params stay what the operator sent (nothing).
			expect(queueAdd).toHaveBeenCalledWith(
				"live-channel",
				expect.objectContaining({ params: {} }),
				expect.anything(),
			);
		});

		it("an explicit HLS on an fMP4 recording leaves DASH absent (not skipped)", async () => {
			findUnique.mockResolvedValue(channel());
			const res = await POST(postRequest({ manifests: ["HLS"] }), params);
			expect(res.status).toBe(200);
			const claim = updateMany.mock.calls[0]?.[0];
			expect(claim.data.liveToVod.families).toEqual([
				{ type: "HLS", status: "PENDING" },
			]);
		});

		it("a retry over a PARTIAL record carries the finished family (and its id) forward and re-plans only the failed one", async () => {
			const partial = {
				status: "PARTIAL",
				requestedAt: "2026-08-30T00:00:00.000Z",
				finishedAt: "2026-08-30T00:02:00.000Z",
				outputId: "bm-out",
				path: "output/ch",
				families: [
					{
						type: "HLS",
						status: "FINISHED",
						providerIdentity: providerIdentity("vod.m3u8"),
						manifestId: "bm-hls",
						url: "output/ch/vod.m3u8",
					},
					{
						type: "DASH",
						status: "ERROR",
						errorCode: "L2V_PROVIDER_STATUS_FAILED",
						providerIdentity: providerIdentity("vod.mpd"),
						manifestId: "bm-dash",
						url: "output/ch/vod.mpd",
						error: "ended ERROR",
					},
				],
				manifests: [
					{ type: "HLS", manifestId: "bm-hls", url: "output/ch/vod.m3u8" },
				],
				error: "DASH: ended ERROR",
			};
			findUnique.mockResolvedValue(channel({ liveToVod: partial }));
			const res = await POST(postRequest(), params);
			expect(res.status).toBe(200);
			const claim = updateMany.mock.calls[0]?.[0];
			expect(claim.data.liveToVod).toMatchObject({
				status: "RUNNING",
				requestedAt: expect.any(String),
				attemptId: expect.any(String),
				queueJobId: expect.stringContaining("-live-to-vod-"),
				liveChannelRunId: RUN_ID,
				outputKey: "origin",
				outputId: "bm-out",
				path: "output/ch",
				// Verbatim: the FINISHED family keeps its id; the failed one keeps
				// its id too, for the worker's readback.
				families: partial.families,
				manifests: partial.manifests,
			});
			expect(claim.data.liveToVod.requestedAt).not.toBe(partial.requestedAt);
			expect(claim.data.liveToVod).not.toHaveProperty("error");
			expect(claim.data.liveToVod).not.toHaveProperty("finishedAt");
		});

		it("a roll over a FINISHED record, or a legacy ERROR, is a fresh claim — nothing carried, nothing promoted", async () => {
			for (const existing of [
				{
					status: "FINISHED",
					outputId: "bm-out",
					path: "output/ch",
					families: [
						{
							type: "HLS",
							status: "FINISHED",
							providerIdentity: providerIdentity("vod.m3u8"),
							manifestId: "bm-hls",
							url: "output/ch/vod.m3u8",
						},
					],
					manifests: [
						{ type: "HLS", manifestId: "bm-hls", url: "output/ch/vod.m3u8" },
					],
				},
				{
					status: "ERROR",
					manifests: [
						{ type: "HLS", manifestId: "bm-hls", url: "output/ch/vod.m3u8" },
					],
					error: "live-to-vod:dash ended ERROR",
				},
			]) {
				vi.clearAllMocks();
				updateMany.mockResolvedValue({ count: 1 });
				runFindUnique.mockResolvedValue({
					id: RUN_ID,
					liveChannelId: CHANNEL_ID,
				});
				runUpdateMany.mockResolvedValue({ count: 1 });
				queueAdd.mockResolvedValue(undefined);
				queueGetJob.mockResolvedValue(undefined);
				findUnique.mockResolvedValue(channel({ liveToVod: existing }));
				expect((await POST(postRequest(), params)).status).toBe(200);
				const claim = updateMany.mock.calls[0]?.[0];
				expect(claim.data.liveToVod).toMatchObject({
					status: "RUNNING",
					requestedAt: expect.any(String),
					attemptId: expect.any(String),
					queueJobId: expect.stringContaining("-live-to-vod-"),
					liveChannelRunId: RUN_ID,
					outputKey: "origin",
					families: [
						{ type: "HLS", status: "PENDING" },
						{ type: "DASH", status: "PENDING" },
					],
					manifests: [],
				});
			}
		});

		it("400s a DEFAULT request over a step log with no muxing entry instead of claiming a roll the worker must refuse", async () => {
			findUnique.mockResolvedValue(
				channel({
					stepLog: STEP_LOG.filter((e) => !e.kind.startsWith("CREATE_MUXING_")),
				}),
			);
			const res = await POST(postRequest(), params);
			expect(res.status).toBe(400);
			await expect(res.json()).resolves.toMatchObject({
				error: expect.stringContaining("no muxing"),
			});
			expect(updateMany).not.toHaveBeenCalled();
			expect(queueAdd).not.toHaveBeenCalled();
		});

		it("an enqueue failure on a retry keeps the carried FINISHED family — the record derives PARTIAL, not a blank ERROR", async () => {
			findUnique.mockResolvedValue(
				channel({
					liveToVod: {
						status: "PARTIAL",
						outputId: "bm-out",
						path: "output/ch",
						families: [
							{
								type: "HLS",
								status: "FINISHED",
								providerIdentity: providerIdentity("vod.m3u8"),
								manifestId: "bm-hls",
								url: "output/ch/vod.m3u8",
							},
							{
								type: "DASH",
								status: "ERROR",
								errorCode: "L2V_PROVIDER_CREATE_FAILED",
								error: "create refused",
							},
						],
						manifests: [
							{ type: "HLS", manifestId: "bm-hls", url: "output/ch/vod.m3u8" },
						],
					},
				}),
			);
			queueAdd.mockRejectedValue(new Error("redis down"));
			const res = await POST(postRequest(), params);
			expect(res.status).toBe(503);
			await expect(res.json()).resolves.toMatchObject({
				details: { code: "L2V_ENQUEUE_FAILED" },
			});
			const recovery = updateMany.mock.calls[1]?.[0];
			expect(recovery.data.liveToVod).toMatchObject({
				status: "PARTIAL",
				errorCode: "L2V_ENQUEUE_FAILED",
				families: [
					{ type: "HLS", status: "FINISHED", manifestId: "bm-hls" },
					{
						type: "DASH",
						status: "ERROR",
						errorCode: "L2V_ENQUEUE_FAILED",
					},
				],
				manifests: [
					{ type: "HLS", manifestId: "bm-hls", url: "output/ch/vod.m3u8" },
				],
			});
			expect(recovery.data).not.toHaveProperty("status");
		});
	});

	it("404s an unknown channel and 400s a non-uuid id", async () => {
		findUnique.mockResolvedValue(null);
		expect((await POST(postRequest(), params)).status).toBe(404);
		const bad = await POST(postRequest(), {
			params: Promise.resolve({ id: "not-a-uuid" }),
		});
		expect(bad.status).toBe(400);
	});
});

it("enqueues Live-to-VOD for a compiled encrypted-only recording", async () => {
	const p = liveChannelPlanSchema.parse(
		JSON.parse(
			readFileSync(
				join(
					__dirname,
					"../../../../../../../../packages/core/src/live/__fixtures__/live-rtmp-simple.plan.json",
				),
				"utf8",
			),
		),
	);
	p.drm = p.muxings.map((m) => {
		if (!m.destination) throw new Error("Missing output");
		return {
			key: `${m.key}-enc`,
			kind: "FAIRPLAY" as const,
			muxingKey: m.key,
			credentialId: "00000000-0000-4000-8000-000000000003",
			iv: "a".repeat(32),
			uri: "skd://synthetic",
			destination: m.destination,
		};
	});
	for (const m of p.muxings) delete m.destination;
	for (const m of p.liveManifests) m.drmKind = "FAIRPLAY";
	const log = initStepLog(compileLiveChannel(p)).map((e) => ({
		...e,
		status: "DONE",
		resourceId: `provider-${e.step}`,
	}));
	findUnique.mockResolvedValue(channel({ stepLog: log }));
	const res = await POST(postRequest({ manifests: ["HLS"] }), params);
	expect(res.status).toBe(200);
	expect(queueAdd).toHaveBeenCalled();
});
