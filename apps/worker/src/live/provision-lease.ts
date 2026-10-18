import type { AppPrismaClient } from "@bitovp/db";
import { retireTransitionalRuns } from "./reconcile-stranded-runs";

/**
 * How long a provisioning lease
 * stays valid without a renewal. The holder renews on every poll tick and on
 * a ticker across long SDK calls; a lease older than this belongs to a worker
 * that is gone. Deliberately longer than a provision takes and shorter than an
 * operator's patience. Defined here — outside the processor — so the sweep
 * below and the dead-job reaper share the one number with the claim.
 */
export const PROVISION_LEASE_MS = 10 * 60 * 1000;

/** Cadence of the abandoned-lease sweep — the same as the stranded-VMAF sweep. */
export const ABANDONED_LEASE_SWEEP_MS = 60_000;

export const ABANDONED_LEASE_ERROR =
	"Provisioning was abandoned: the worker holding this channel's lease stopped renewing it and no other worker took the channel over. Its transitional run was retired with it — start the channel again.";

/**
 * Review-336 I1: the fence closed one failure mode and opened another. Before
 *  a dead provisioning job flipped its channel to ERROR
 * unconditionally (wrong in the takeover race, but an exit); with the reaper
 * now refusing rows whose lease is not yet stale, a worker that crashes SOLO
 * — nobody takes over, BullMQ's `failed` fired while the lease still looked
 * live — left a channel wedged in PROVISIONING that no sweep, no UI action and
 * no retry could reach. Only a DB edit cleared it.
 *
 * This sweep is that exit. A PROVISIONING row whose NON-NULL lease is older
 * than `PROVISION_LEASE_MS` has no live holder (a holder renews every third of
 * the window). The flip is a compare-and-swap on the exact token that was
 * read: a renewal or a takeover between the read and the write moves the
 * token, the write matches nothing, and the row is left to its live owner.
 * A PROVISIONING row with a NULL lease is deliberately out of scope — that is
 * the route-set state between an action's claim and the job's own claim, and
 * the dead-job reaper already covers the job dying there.
 */
export async function reconcileAbandonedLeases(
	prisma: AppPrismaClient,
	now: Date,
): Promise<number> {
	const cutoff = new Date(now.getTime() - PROVISION_LEASE_MS);
	const stale = await prisma.liveChannel.findMany({
		where: { status: "PROVISIONING", provisionClaimedAt: { lt: cutoff } },
		select: { id: true, provisionClaimedAt: true },
	});
	let flipped = 0;
	for (const row of stale) {
		if (row.provisionClaimedAt === null) {
			continue;
		}
		const { count } = await prisma.liveChannel.updateMany({
			where: {
				id: row.id,
				status: "PROVISIONING",
				provisionClaimedAt: row.provisionClaimedAt,
			},
			data: {
				status: "ERROR",
				error: ABANDONED_LEASE_ERROR,
				provisionClaimedAt: null,
			},
		});
		if (count === 0) {
			// Renewed or taken over since the read — a live holder owns it.
			continue;
		}
		flipped += 1;
		// The run follows the channel , or the one-live-run index
		// rejects every later start.
		await retireTransitionalRuns(prisma, row.id, ABANDONED_LEASE_ERROR);
	}
	return flipped;
}
