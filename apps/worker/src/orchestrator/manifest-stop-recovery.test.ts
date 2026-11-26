import { expect, it, vi } from "vitest";
import { createManifestStopRecovery } from "./manifest-stop-recovery";
import { ATTEMPT_LEASE_MS } from "./processor";

const now = new Date("2026-11-27T02:00:00.000Z");

it("requeues only stale, claimable VOD jobs with a durable manifest stop marker", async () => {
	const findMany = vi.fn().mockResolvedValue([{ id: "encoding-1" }]);
	const addBulk = vi.fn().mockResolvedValue([]);
	const recover = createManifestStopRecovery({
		prisma: { encodingJob: { findMany } },
		queue: { addBulk },
		now: () => now,
	});
	await recover();
	expect(findMany).toHaveBeenCalledWith({
		where: {
			status: { in: ["QUEUED", "RUNNING"] },
			stepLog: { array_contains: [{ roleDeliveryBlocked: true }] },
			updatedAt: { lt: new Date(now.getTime() - 60_000) },
			OR: [
				{ attemptClaimedAt: null },
				{
					attemptClaimedAt: { lt: new Date(now.getTime() - ATTEMPT_LEASE_MS) },
				},
			],
		},
		select: { id: true },
		orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
		take: 20,
	});
	expect(addBulk).toHaveBeenCalledWith([
		{
			name: "orchestrate",
			data: { encodingJobId: "encoding-1" },
			opts: {
				jobId: "encoding-1-manifest-stop",
				removeOnComplete: true,
				removeOnFail: true,
			},
		},
	]);
});

it("reuses a stable queue identity after a failed recovery enqueue", async () => {
	const findMany = vi.fn().mockResolvedValue([{ id: "encoding-1" }]);
	const addBulk = vi
		.fn()
		.mockRejectedValueOnce(new Error("Redis unavailable"))
		.mockResolvedValueOnce([]);
	const recover = createManifestStopRecovery({
		prisma: { encodingJob: { findMany } },
		queue: { addBulk },
		now: () => now,
	});
	await expect(recover()).rejects.toThrow("Redis unavailable");
	await expect(recover()).resolves.toBeUndefined();
	expect(addBulk.mock.calls[1]).toEqual(addBulk.mock.calls[0]);
});
