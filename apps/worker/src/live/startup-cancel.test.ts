import type { AppPrismaClient } from "@bitovp/db";
import { describe, expect, it, vi } from "vitest";
import { reconcileStartupCancellations } from "./startup-cancel";

describe("startup cancellation recovery", () => {
	it("recovers a durable flag after a lost enqueue/worker restart", async () => {
		const rows = [{ id: "run-a", liveChannelId: "channel-a" }];
		const prisma = {
			liveChannelRun: {
				findMany: vi.fn(async () => rows),
				findFirst: vi.fn(async () => ({ id: "run-a" })),
			},
		} as unknown as AppPrismaClient;
		const enqueue = vi.fn(async () => {});
		expect(await reconcileStartupCancellations(prisma, enqueue)).toBe(1);
		expect(enqueue).toHaveBeenCalledWith(
			{
				liveChannelId: "channel-a",
				action: "provision",
				params: { cancelRunId: "run-a" },
			},
			"cancel-start-channel-a-run-a",
		);
	});
	it("never sends old cancellation wake to a re-aired channel", async () => {
		const prisma = {
			liveChannelRun: {
				findMany: vi.fn(async () => [
					{ id: "old", liveChannelId: "channel-a" },
				]),
				findFirst: vi.fn(async () => ({ id: "new" })),
			},
		} as unknown as AppPrismaClient;
		const enqueue = vi.fn(async () => {});
		expect(await reconcileStartupCancellations(prisma, enqueue)).toBe(0);
		expect(enqueue).not.toHaveBeenCalled();
	});
});
