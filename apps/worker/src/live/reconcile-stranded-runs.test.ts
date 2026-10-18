import { describe, expect, it, vi } from "vitest";
import {
	createStrandedRunReconciler,
	retireTransitionalRuns,
	STRANDED_RUN_ERROR,
	TRANSITIONAL_RUN_STATUSES,
} from "./reconcile-stranded-runs";

/**
 *  — the boot half. The signature it sweeps (channel ERROR ∧
 * run transitional) is unreachable by any healthy transition, so the WHERE
 * clause is the whole design: what it includes, and what it deliberately
 * does not.
 */
describe("retiring transitional runs under ERROR channels", () => {
	it("retires with the transitional trio scoped to ERROR channels, endedAt stamped", async () => {
		const updateMany = vi.fn(async () => ({ count: 2 }));
		const prisma = {
			liveChannelRun: { updateMany },
		} as unknown as Parameters<typeof createStrandedRunReconciler>[0]["prisma"];
		const retired = await createStrandedRunReconciler({ prisma })();
		expect(retired).toBe(2);
		const args = (updateMany.mock.calls as unknown[][])[0]?.[0] as {
			where: {
				status: { in: string[] };
				liveChannel: { status: string };
			};
			data: { status: string; error: string; endedAt: unknown };
		};
		// RUNNING is deliberately absent: a RUNNING run under an ERROR channel
		// may point at an encoder genuinely live (and billing) at Bitmovin —
		// retiring it would trade a visible anomaly for silent billing.
		expect(args.where.status.in.sort()).toEqual([
			"CREATED",
			"PROVISIONING",
			"STOPPING",
		]);
		expect(args.where.status.in).not.toContain("RUNNING");
		// Only under a channel already marked ERROR — the impossible pairing.
		expect(args.where.liveChannel).toEqual({ status: "ERROR" });
		expect(args.data.status).toBe("ERROR");
		expect(args.data.error).toBe(STRANDED_RUN_ERROR);
		// A terminal row gets an end time: null endedAt on a closed run reads
		// as "still live" to every aggregating reader.
		expect(args.data.endedAt).toBeInstanceOf(Date);
	});

	it("the reaper half scopes to ONE channel with the same trio and end time", async () => {
		const updateMany = vi.fn(async () => ({ count: 1 }));
		const prisma = {
			liveChannelRun: { updateMany },
		} as unknown as Parameters<typeof createStrandedRunReconciler>[0]["prisma"];
		const retired = await retireTransitionalRuns(prisma, "ch-1", "job died");
		expect(retired).toBe(1);
		const args = (updateMany.mock.calls as unknown[][])[0]?.[0] as {
			where: { liveChannelId: string; status: { in: string[] } };
			data: { status: string; error: string; endedAt: unknown };
		};
		expect(args.where.liveChannelId).toBe("ch-1");
		// Shared trio — the two halves cannot drift apart.
		expect(args.where.status.in).toEqual([...TRANSITIONAL_RUN_STATUSES]);
		expect(args.data).toMatchObject({ status: "ERROR", error: "job died" });
		expect(args.data.endedAt).toBeInstanceOf(Date);
	});
});
