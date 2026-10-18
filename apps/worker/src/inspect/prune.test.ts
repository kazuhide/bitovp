import type { AppPrismaClient } from "@bitovp/db";
import { describe, expect, it, vi } from "vitest";
import {
	createInspectionPrune,
	INSPECTION_RETENTION_DAYS_DEFAULT,
} from "./prune";

/**
 * : the age prune that rides the heartbeat sweep. The rows hold
 * customer data, so the WINDOW is the contract — a wrong cutoff either
 * destroys history the future view needs or keeps customer records forever.
 */

const NOW = "2026-08-12T12:00:00.000Z";

function setup(retentionDays?: number) {
	const deleteMany = vi.fn(async () => ({ count: 3 }));
	const prisma = {
		storageInspection: { deleteMany },
	} as unknown as AppPrismaClient;
	return {
		deleteMany,
		prune: createInspectionPrune({ prisma, retentionDays, now: () => NOW }),
	};
}

describe("inspection retention prune", () => {
	it("deletes rows older than the default 30-day window", async () => {
		const t = setup();
		await expect(t.prune()).resolves.toBe(3);
		const cutoff = new Date(
			new Date(NOW).getTime() -
				INSPECTION_RETENTION_DAYS_DEFAULT * 24 * 60 * 60 * 1000,
		);
		expect(t.deleteMany).toHaveBeenCalledWith({
			where: { createdAt: { lt: cutoff } },
		});
	});

	it("a custom INSPECTION_RETENTION_DAYS moves the cutoff", async () => {
		const t = setup(7);
		await t.prune();
		const cutoff = new Date(new Date(NOW).getTime() - 7 * 24 * 60 * 60 * 1000);
		expect(t.deleteMany).toHaveBeenCalledWith({
			where: { createdAt: { lt: cutoff } },
		});
	});

	it("0 disables — customer opts out of pruning, nothing is deleted", async () => {
		const t = setup(0);
		await expect(t.prune()).resolves.toBe(0);
		expect(t.deleteMany).not.toHaveBeenCalled();
	});
});
