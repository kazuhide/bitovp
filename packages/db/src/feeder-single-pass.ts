import { FEEDER_PUBLISHER_CLAIM_HELD_WHERE } from "@bitovp/core";
import type { AppPrismaClient } from "./client";

export type FeederSinglePassDispatchFence = {
	id: string;
	ownerId: string;
	ownerGeneration: number;
};

/**
 * Commit the single pass's no-replay marker immediately before its process
 * spawn. A lost response is ambiguous: callers must never erase this marker
 * or repeat the source under a new owner. PostgreSQL rechecks the predicate
 * after a concurrent writer releases its row lock, so at most one can win.
 */
export async function claimFeederSinglePassDispatch(
	prisma: AppPrismaClient,
	fence: FeederSinglePassDispatchFence,
	dispatchedAt: Date,
): Promise<boolean> {
	const { count } = await prisma.feederSession.updateMany({
		where: {
			...fence,
			status: "DOWNLOADING",
			playbackMode: "ONCE",
			playbackDispatchedAt: null,
			...FEEDER_PUBLISHER_CLAIM_HELD_WHERE,
		},
		data: { playbackDispatchedAt: dispatchedAt },
	});
	return count === 1;
}
