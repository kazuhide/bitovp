import {
	deriveLiveToVodStatus,
	type LiveToVodFamilyRecord,
	liveToVodManifestsOf,
	redactSecrets,
} from "@bitovp/core";
import {
	type AppPrismaClient,
	LiveToVodFenceError,
	persistLiveToVodAttempt,
	readLiveToVodAttempt,
} from "@bitovp/db";

export type DeadLiveToVodCoordinates = {
	liveChannelId: string;
	liveChannelRunId: string;
	encodingId: string;
	attemptId: string;
};

function deadFamily(
	family: LiveToVodFamilyRecord,
	detail: string,
): LiveToVodFamilyRecord {
	if (
		family.status === "FINISHED" ||
		family.status === "ERROR" ||
		family.status === "SKIPPED_UNSUPPORTED"
	) {
		return family;
	}
	const providerIdentity =
		"providerIdentity" in family ? family.providerIdentity : undefined;
	const createIntent =
		"createIntent" in family ? family.createIntent : undefined;
	const manifestId = "manifestId" in family ? family.manifestId : undefined;
	return {
		type: family.type,
		status: "ERROR",
		errorCode: "L2V_JOB_DIED",
		technicalDetail: detail,
		...(providerIdentity ? { providerIdentity } : {}),
		...(createIntent ? { createIntent } : {}),
		...(manifestId ? { manifestId } : {}),
	};
}

/**
 * Release only the exact dead queue attempt, atomically on channel + run.
 * The revision CAS makes a late failed event harmless after a retry or worker
 * save has advanced the attempt. Provider identity/id and cleanup intent stay
 * on each family for the next reconciliation.
 */
export async function releaseDeadLiveToVod(
	prisma: AppPrismaClient,
	coordinates: DeadLiveToVodCoordinates,
	message: string,
	now: Date,
): Promise<number> {
	const current = await readLiveToVodAttempt(prisma, coordinates);
	if (
		current === null ||
		current.status !== "RUNNING" ||
		current.liveChannelRunId !== coordinates.liveChannelRunId ||
		current.revision === undefined
	) {
		return 0;
	}
	const detail = String(redactSecrets(`live-to-VOD job died: ${message}`));
	const families = (current.families ?? []).map((family) =>
		deadFamily(family, detail),
	);
	const record = {
		...current,
		families,
		manifests: liveToVodManifestsOf(families),
		status: deriveLiveToVodStatus(families),
		errorCode: "L2V_JOB_DIED" as const,
		technicalDetail: detail,
		finishedAt: now.toISOString(),
	};
	try {
		await persistLiveToVodAttempt(prisma, {
			...coordinates,
			expectedRevision: current.revision,
			record,
		});
		return 1;
	} catch (err) {
		if (err instanceof LiveToVodFenceError) {
			return 0;
		}
		throw err;
	}
}

/**
 * BullMQ emits `failed` for an individual delivery even when its configured
 * retry has already moved the same job to DELAYED/WAITING. Only the terminal
 * FAILED state means the attempt is dead. An unavailable/unknown queue state
 * fails closed: the route's exact-job reconciliation can release it later,
 * but this event must not open a second provider-create path prematurely.
 */
export async function releaseDeadLiveToVodIfFinal(
	prisma: AppPrismaClient,
	coordinates: DeadLiveToVodCoordinates,
	message: string,
	now: Date,
	getQueueState: () => Promise<string>,
): Promise<number> {
	let state: string;
	try {
		state = await getQueueState();
	} catch {
		return 0;
	}
	if (state !== "failed") {
		return 0;
	}
	return releaseDeadLiveToVod(prisma, coordinates, message, now);
}
