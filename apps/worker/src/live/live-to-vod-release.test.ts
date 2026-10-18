import type { LiveToVodRecord } from "@bitovp/core";
import type { AppPrismaClient } from "@bitovp/db";
import { describe, expect, it, vi } from "vitest";
import {
	releaseDeadLiveToVod,
	releaseDeadLiveToVodIfFinal,
} from "./live-to-vod-release";

const coordinates = {
	liveChannelId: "11111111-1111-4111-8111-111111111111",
	liveChannelRunId: "22222222-2222-4222-8222-222222222222",
	encodingId: "bm-encoding",
	attemptId: "33333333-3333-4333-8333-333333333333",
};

function runningRecord(): LiveToVodRecord {
	const identity = {
		attemptId: coordinates.attemptId,
		encodingId: coordinates.encodingId,
		outputId: "bm-output",
		outputPath: "archive/run-1",
		manifestName: "vod.mpd",
	};
	return {
		status: "RUNNING",
		attemptId: coordinates.attemptId,
		revision: 4,
		queueJobId: "channel-live-to-vod-attempt",
		liveChannelRunId: coordinates.liveChannelRunId,
		outputKey: "origin",
		manifests: [
			{
				type: "HLS",
				manifestId: "hls-id",
				url: "archive/run-1/vod.m3u8",
			},
		],
		families: [
			{
				type: "HLS",
				status: "FINISHED",
				providerIdentity: { ...identity, manifestName: "vod.m3u8" },
				manifestId: "hls-id",
				url: "archive/run-1/vod.m3u8",
			},
			{
				type: "DASH",
				status: "RUNNING",
				providerIdentity: identity,
				manifestId: "dash-id",
			},
		],
	};
}

function fakePrisma(options: { loseFence?: boolean } = {}) {
	let channel = runningRecord();
	let run = structuredClone(channel);
	const matches = (where: Record<string, unknown>, record: LiveToVodRecord) => {
		const identity = where.liveToVod as
			| { path: string[]; equals: unknown }
			| undefined;
		const exact = Array.isArray(where.AND)
			? (where.AND as Array<{
					liveToVod?: { path: string[]; equals: unknown };
				}>)
			: where.AND
				? [where.AND as { liveToVod?: { path: string[]; equals: unknown } }]
				: [];
		return (
			(!identity ||
				record[identity.path[0] as keyof LiveToVodRecord] ===
					identity.equals) &&
			exact.every(({ liveToVod }) =>
				liveToVod
					? record[liveToVod.path[0] as keyof LiveToVodRecord] ===
						liveToVod.equals
					: true,
			)
		);
	};
	const liveChannel = {
		findUnique: vi.fn(async () => ({
			bitmovinEncodingId: coordinates.encodingId,
			liveToVod: structuredClone(channel),
		})),
		updateMany: vi.fn(async ({ where, data }) => {
			if (!matches(where, channel)) return { count: 0 };
			channel = structuredClone(data.liveToVod as LiveToVodRecord);
			return { count: 1 };
		}),
	};
	const liveChannelRun = {
		updateMany: vi.fn(async ({ where, data }) => {
			if (
				where.id !== coordinates.liveChannelRunId ||
				where.liveChannelId !== coordinates.liveChannelId ||
				where.bitmovinEncodingId !== coordinates.encodingId ||
				!matches(where, run)
			) {
				return { count: 0 };
			}
			run = structuredClone(data.liveToVod as LiveToVodRecord);
			return { count: 1 };
		}),
	};
	const prisma = {
		liveChannel,
		liveChannelRun,
		$transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
			if (options.loseFence) {
				channel = { ...channel, revision: (channel.revision ?? 0) + 1 };
			}
			return callback(prisma);
		}),
	} as unknown as AppPrismaClient;
	return {
		prisma,
		liveChannel,
		liveChannelRun,
		channel: () => channel,
		run: () => run,
	};
}

describe("releaseDeadLiveToVod", () => {
	it("does not release an exact attempt while BullMQ has queued its automatic retry", async () => {
		const t = fakePrisma();
		await expect(
			releaseDeadLiveToVodIfFinal(
				t.prisma,
				coordinates,
				"first delivery failed",
				new Date("2026-08-31T00:00:00.000Z"),
				async () => "delayed",
			),
		).resolves.toBe(0);
		expect(t.channel().status).toBe("RUNNING");
		expect(t.liveChannel.updateMany).not.toHaveBeenCalled();
		expect(t.liveChannelRun.updateMany).not.toHaveBeenCalled();
	});

	it("releases the exact attempt only after BullMQ confirms the job is finally failed", async () => {
		const t = fakePrisma();
		await expect(
			releaseDeadLiveToVodIfFinal(
				t.prisma,
				coordinates,
				"stalled past retry budget",
				new Date("2026-08-31T00:00:00.000Z"),
				async () => "failed",
			),
		).resolves.toBe(1);
		expect(t.channel()).toMatchObject({
			status: "PARTIAL",
			errorCode: "L2V_JOB_DIED",
		});
	});

	it("fails closed when BullMQ cannot confirm whether another retry owns the attempt", async () => {
		const t = fakePrisma();
		await expect(
			releaseDeadLiveToVodIfFinal(
				t.prisma,
				coordinates,
				"worker event",
				new Date("2026-08-31T00:00:00.000Z"),
				async () => {
					throw new Error("redis unavailable");
				},
			),
		).resolves.toBe(0);
		expect(t.channel().status).toBe("RUNNING");
		expect(t.liveChannel.updateMany).not.toHaveBeenCalled();
	});

	it("atomically settles the exact channel+run while preserving finished and provider identities", async () => {
		const t = fakePrisma();
		await expect(
			releaseDeadLiveToVod(
				t.prisma,
				coordinates,
				"stalled twice",
				new Date("2026-08-31T00:00:00.000Z"),
			),
		).resolves.toBe(1);
		expect(t.channel()).toEqual(t.run());
		expect(t.channel()).toMatchObject({
			status: "PARTIAL",
			revision: 5,
			errorCode: "L2V_JOB_DIED",
			finishedAt: "2026-08-31T00:00:00.000Z",
			families: [
				{ type: "HLS", status: "FINISHED", manifestId: "hls-id" },
				{
					type: "DASH",
					status: "ERROR",
					errorCode: "L2V_JOB_DIED",
					manifestId: "dash-id",
					providerIdentity: { manifestName: "vod.mpd" },
				},
			],
		});
		expect(t.liveChannelRun.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					id: coordinates.liveChannelRunId,
					liveChannelId: coordinates.liveChannelId,
					bitmovinEncodingId: coordinates.encodingId,
				}),
			}),
		);
	});

	it("a late failed event loses the revision fence and cannot overwrite a queued retry", async () => {
		const t = fakePrisma({ loseFence: true });
		await expect(
			releaseDeadLiveToVod(
				t.prisma,
				coordinates,
				"late failed event",
				new Date("2026-08-31T00:00:00.000Z"),
			),
		).resolves.toBe(0);
		expect(t.liveChannelRun.updateMany).not.toHaveBeenCalled();
		expect(t.channel().status).toBe("RUNNING");
	});

	it("redacts secrets before technical detail is persisted", async () => {
		const t = fakePrisma();
		await releaseDeadLiveToVod(
			t.prisma,
			coordinates,
			"read rtmp://ingest:s3cr3t-pass@origin.example/live failed",
			new Date("2026-08-31T00:00:00.000Z"),
		);
		expect(t.channel().technicalDetail).not.toContain("s3cr3t-pass");
		expect(t.channel().technicalDetail).toContain("rtmp://ingest:");
	});
});
