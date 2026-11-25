import "server-only";
import {
	type AppPrismaClient,
	type AppTransactionClient,
	LIVE_EFFECT_OPEN_STATES,
	readResetRtmpArchives,
} from "@bitovp/db";
import { resetBlockingFeederWhere } from "../reset";
import type { ResourceOwner } from "./route";

/** The read-only preview and the locked mutation use the same retirement evidence. */
export async function removalAllowed(
	db: AppPrismaClient | AppTransactionClient,
	owner: ResourceOwner,
	locallyTerminal: boolean,
) {
	if (!locallyTerminal) return false;
	if ("jobId" in owner) return true;
	const liveChannelId = owner.channelId;
	const [archive, effect, publisher, activeRun] = await Promise.all([
		readResetRtmpArchives(db, liveChannelId),
		db.liveEffectClaim.findFirst({
			where: { liveChannelId, state: { in: [...LIVE_EFFECT_OPEN_STATES] } },
			select: { id: true },
		}),
		db.feederSession.findFirst({
			where: { liveChannelId, ...resetBlockingFeederWhere() },
			select: { id: true },
		}),
		db.liveChannelRun.findFirst({
			where: {
				liveChannelId,
				status: { in: ["CREATED", "PROVISIONING", "RUNNING", "STOPPING"] },
				bitmovinEncodingId: { not: null },
			},
			select: { id: true },
		}),
	]);
	return (
		!archive.incomplete.length &&
		!archive.pointers.length &&
		!effect &&
		!publisher &&
		!activeRun
	);
}
