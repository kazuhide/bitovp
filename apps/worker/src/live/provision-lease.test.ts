import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AppPrismaClient } from "@bitovp/db";
import { describe, expect, it, vi } from "vitest";
import {
	ABANDONED_LEASE_ERROR,
	ABANDONED_LEASE_SWEEP_MS,
	PROVISION_LEASE_MS,
	reconcileAbandonedLeases,
} from "./provision-lease";

type Row = {
	id: string;
	status: string;
	provisionClaimedAt: Date | null;
	error?: string | null;
};

const NOW = new Date("2026-08-29T12:00:00.000Z");
const stale = new Date(NOW.getTime() - 2 * PROVISION_LEASE_MS);
const fresh = new Date(NOW.getTime() - PROVISION_LEASE_MS / 2);

function fake(rows: Row[]) {
	const retired: string[] = [];
	const liveChannel = {
		findMany: vi.fn(
			async ({
				where,
			}: {
				where: { status: string; provisionClaimedAt: { lt: Date } };
			}) =>
				rows
					.filter(
						(r) =>
							r.status === where.status &&
							r.provisionClaimedAt !== null &&
							r.provisionClaimedAt.getTime() <
								where.provisionClaimedAt.lt.getTime(),
					)
					.map((r) => ({ id: r.id, provisionClaimedAt: r.provisionClaimedAt })),
		),
		updateMany: vi.fn(
			async ({
				where,
				data,
			}: {
				where: { id: string; status: string; provisionClaimedAt: Date };
				data: Partial<Row>;
			}) => {
				const r = rows.find((x) => x.id === where.id);
				if (
					!r ||
					r.status !== where.status ||
					r.provisionClaimedAt === null ||
					r.provisionClaimedAt.getTime() !== where.provisionClaimedAt.getTime()
				) {
					return { count: 0 };
				}
				Object.assign(r, data);
				return { count: 1 };
			},
		),
	};
	const liveChannelRun = {
		updateMany: vi.fn(
			async ({ where }: { where: { liveChannelId: string } }) => {
				retired.push(where.liveChannelId);
				return { count: 1 };
			},
		),
	};
	return {
		prisma: { liveChannel, liveChannelRun } as unknown as AppPrismaClient,
		liveChannel,
		rows,
		retired,
	};
}

describe("abandoned provisioning leases (review-336 I1, ledger #216)", () => {
	it("flips a PROVISIONING row whose lease went stale, releases the lease and retires its run", async () => {
		const t = fake([
			{ id: "c1", status: "PROVISIONING", provisionClaimedAt: stale },
		]);
		await expect(reconcileAbandonedLeases(t.prisma, NOW)).resolves.toBe(1);
		expect(t.rows[0]).toMatchObject({
			status: "ERROR",
			provisionClaimedAt: null,
			error: ABANDONED_LEASE_ERROR,
		});
		expect(t.retired).toEqual(["c1"]);
	});

	it("leaves a row whose lease is still being renewed alone", async () => {
		const t = fake([
			{ id: "c1", status: "PROVISIONING", provisionClaimedAt: fresh },
		]);
		await expect(reconcileAbandonedLeases(t.prisma, NOW)).resolves.toBe(0);
		expect(t.rows[0]).toMatchObject({
			status: "PROVISIONING",
			provisionClaimedAt: fresh,
		});
		expect(t.retired).toEqual([]);
	});

	it("a renewal between the read and the write wins: the flip matches nothing and no run is retired", async () => {
		const t = fake([
			{ id: "c1", status: "PROVISIONING", provisionClaimedAt: stale },
		]);
		const original = t.liveChannel.findMany.getMockImplementation();
		if (!original) {
			throw new Error("fake findMany carries no implementation");
		}
		t.liveChannel.findMany.mockImplementationOnce(async (args) => {
			const snapshot = await original(args);
			// The holder renews right after the sweep's read.
			const row = t.rows[0];
			if (!row) {
				throw new Error("fixture row missing");
			}
			row.provisionClaimedAt = fresh;
			return snapshot;
		});
		await expect(reconcileAbandonedLeases(t.prisma, NOW)).resolves.toBe(0);
		expect(t.rows[0]).toMatchObject({
			status: "PROVISIONING",
			provisionClaimedAt: fresh,
		});
		expect(t.retired).toEqual([]);
	});

	it("never selects a PROVISIONING row with a NULL lease — that is the route-set state a job is about to claim", async () => {
		const t = fake([
			{ id: "c1", status: "PROVISIONING", provisionClaimedAt: null },
		]);
		await expect(reconcileAbandonedLeases(t.prisma, NOW)).resolves.toBe(0);
		expect(t.rows[0]?.status).toBe("PROVISIONING");
		expect(t.liveChannel.updateMany).not.toHaveBeenCalled();
	});

	it("never touches a non-PROVISIONING row, whatever its lease column says", async () => {
		const t = fake([
			{ id: "c1", status: "RUNNING", provisionClaimedAt: stale },
			{ id: "c2", status: "ERROR", provisionClaimedAt: stale },
		]);
		await expect(reconcileAbandonedLeases(t.prisma, NOW)).resolves.toBe(0);
		expect(t.rows.map((r) => r.status)).toEqual(["RUNNING", "ERROR"]);
		expect(t.retired).toEqual([]);
	});

	it("the worker dispatches the sweep per tenant on an unref interval AND once at boot (shape pin)", () => {
		const index = readFileSync(join(__dirname, "../index.ts"), "utf8");
		expect(index).toContain("reconcileAbandonedLeases(prisma, new Date())");
		expect(index).toContain(
			"setTenantInterval(abandonedLeaseSweep, ABANDONED_LEASE_SWEEP_MS).unref();",
		);
		expect(index).toContain("runTenantTick(() => abandonedLeaseSweep());");
		// Preserve the actual interval/dispatch bridge, not just a renamed call:
		// both boot and interval must enter a scoped sweep and stop during shutdown.
		const interval = index.match(
			/function setTenantInterval\([\s\S]*?\n\}/,
		)?.[0];
		expect(interval).toContain(
			"return setInterval(() => runTenantTick(run), ms);",
		);
		const tick = index.match(/function runTenantTick\([\s\S]*?\n\}/)?.[0];
		expect(tick).toContain("if (stopping) return;");
		expect(tick).toContain(
			"forEachOrganization(() => (stopping ? undefined : run()))",
		);
		expect(ABANDONED_LEASE_SWEEP_MS).toBeLessThan(PROVISION_LEASE_MS);
	});
});
