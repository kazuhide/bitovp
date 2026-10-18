import type { LiveToVodRecord } from "@bitovp/core";
import { describe, expect, it, vi } from "vitest";
import type { AppPrismaClient } from "./client";
import {
	claimLiveToVodAttempt,
	LiveToVodFenceError,
	persistLiveToVodAttempt,
	readLiveToVodAttempt,
} from "./live-to-vod-state";

const record: LiveToVodRecord = {
	status: "RUNNING",
	attemptId: "attempt-1",
	revision: 0,
	queueJobId: "channel-live-to-vod-attempt-1",
	liveChannelRunId: "22222222-2222-4222-8222-222222222222",
	manifests: [],
	families: [{ type: "HLS", status: "PENDING" }],
};

function harness(channelCount = 1, runCount = 1) {
	const channelUpdate = vi.fn(async () => ({ count: channelCount }));
	const runUpdate = vi.fn(async () => ({ count: runCount }));
	const findUnique = vi.fn(async () => ({
		bitmovinEncodingId: coordinates.encodingId,
		liveToVod: record,
	}));
	const tx = {
		liveChannel: { updateMany: channelUpdate },
		liveChannelRun: { updateMany: runUpdate },
	};
	const transaction = vi.fn(async (fn: (inner: typeof tx) => unknown) =>
		fn(tx),
	);
	return {
		prisma: {
			$transaction: transaction,
			liveChannel: { findUnique },
		} as unknown as AppPrismaClient,
		channelUpdate,
		runUpdate,
		findUnique,
	};
}

const coordinates = {
	liveChannelId: "11111111-1111-4111-8111-111111111111",
	liveChannelRunId: "22222222-2222-4222-8222-222222222222",
	encodingId: "encoding-1",
	attemptId: "attempt-1",
};

describe("live-to-VOD atomic state", () => {
	it("claims the channel and exact run in one transaction", async () => {
		const h = harness();
		await expect(
			claimLiveToVodAttempt(h.prisma, {
				...coordinates,
				updatedAt: new Date("2026-08-31T00:00:00Z"),
				record,
			}),
		).resolves.toBe(true);
		expect(h.channelUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ updatedAt: expect.any(Date) }),
			}),
		);
		expect(h.runUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					id: coordinates.liveChannelRunId,
					bitmovinEncodingId: coordinates.encodingId,
				}),
			}),
		);
	});

	it("throws inside the transaction when the exact run half is absent", async () => {
		const h = harness(1, 0);
		await expect(
			claimLiveToVodAttempt(h.prisma, {
				...coordinates,
				updatedAt: new Date(),
				record,
			}),
		).rejects.toBeInstanceOf(LiveToVodFenceError);
	});

	it("fences every progress write by the same attempt on both rows", async () => {
		const h = harness();
		await expect(
			persistLiveToVodAttempt(h.prisma, {
				...coordinates,
				expectedRevision: 0,
				record,
			}),
		).resolves.toMatchObject({ revision: 1 });
		for (const update of [h.channelUpdate, h.runUpdate]) {
			expect(update).toHaveBeenCalledWith(
				expect.objectContaining({
					where: expect.objectContaining({
						liveToVod: { path: ["attemptId"], equals: "attempt-1" },
						AND: [
							{ liveToVod: { path: ["revision"], equals: 0 } },
							{
								liveToVod: {
									path: ["liveChannelRunId"],
									equals: coordinates.liveChannelRunId,
								},
							},
						],
					}),
					data: {
						liveToVod: expect.objectContaining({ revision: 1 }),
					},
				}),
			);
		}
	});

	it("reads an attempt only when the channel, run, and encoding identities all match", async () => {
		const h = harness();
		await expect(readLiveToVodAttempt(h.prisma, coordinates)).resolves.toEqual(
			record,
		);
		h.findUnique.mockResolvedValueOnce({
			bitmovinEncodingId: "different-encoding",
			liveToVod: record,
		});
		await expect(
			readLiveToVodAttempt(h.prisma, coordinates),
		).resolves.toBeNull();
		await expect(
			readLiveToVodAttempt(h.prisma, {
				...coordinates,
				liveChannelRunId: "33333333-3333-4333-8333-333333333333",
			}),
		).resolves.toBeNull();
	});

	it("rejects a late same-attempt save whose revision already advanced", async () => {
		const h = harness(0, 1);
		await expect(
			persistLiveToVodAttempt(h.prisma, {
				...coordinates,
				expectedRevision: 0,
				record,
			}),
		).rejects.toBeInstanceOf(LiveToVodFenceError);
		expect(h.runUpdate).not.toHaveBeenCalled();
	});

	it("rejects a payload snapshot whose own revision is not the expected CAS revision", async () => {
		const h = harness();
		await expect(
			persistLiveToVodAttempt(h.prisma, {
				...coordinates,
				expectedRevision: 1,
				record,
			}),
		).rejects.toBeInstanceOf(LiveToVodFenceError);
		expect(h.channelUpdate).not.toHaveBeenCalled();
		expect(h.runUpdate).not.toHaveBeenCalled();
	});
});
