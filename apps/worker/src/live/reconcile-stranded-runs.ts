import {
	type AppPrismaClient,
	LIVE_EFFECT_OPEN_STATES,
	STRANDED_RUN_ERROR,
} from "@bitovp/db";

/**
 *  — a LiveChannelRun stranded in a transitional state makes its
 * channel permanently unstartable.
 *
 * The dead-job reaper flips the CHANNEL to ERROR but never touched the run,
 * and the partial unique index `LiveChannelRun_one_live_per_channel`
 * (CREATED/PROVISIONING/RUNNING/STOPPING) then rejects every future start
 * with RunAlreadyLiveError — thrown BEFORE the channel claim, so there is
 * no way through. The only exit was deleting the channel to cascade the
 * run. A run stranded before CREATE_ENCODING is also INVISIBLE to the
 * reset: `unstoppedEncoders` sees runs only through a non-null
 * `bitmovinEncodingId`.
 *
 * Two halves fix it. The reaper now retires the run in the same breath as
 * the channel (same transitional scope, same dead-job evidence). This
 * one-shot covers HISTORY and any other path that flips a channel to ERROR
 * without its run: the signature `channel = ERROR ∧ run ∈ transitional` is
 * unreachable by any healthy transition, because every status-owning
 * action moves the run and the channel together.
 *
 * RUNNING is deliberately NOT in the sweep's scope: a RUNNING run under an
 * ERROR channel still points at an encoder that may genuinely be live at
 * Bitmovin (a stop that failed after the encoder kept going), and its
 * non-null bitmovinEncodingId is what keeps the stop/reset sweeps looking
 * at it. Retiring it here would trade a visible anomaly for silent
 * billing. The transitional trio cannot be in that position: CREATED and
 * PROVISIONING predate the encoder, and a STOPPING run's pointer survives
 * on the ERROR row for the same sweeps.
 */
export { STRANDED_RUN_ERROR } from "@bitovp/db";

/**
 * The ONE list of run states the one-live-per-channel index counts as live
 * that are safe to retire on dead-job evidence. RUNNING is in the index's
 * set but deliberately NOT here — see the module doc.
 */
export const TRANSITIONAL_RUN_STATUSES = [
	"CREATED",
	"PROVISIONING",
	"STOPPING",
] as const;

/**
 * The reaper half: called in the same breath as the channel's own
 * ERROR write, with the dead job's message. Shares the status trio and the
 * endedAt semantics with the boot sweep so the two halves cannot drift.
 */
export async function retireTransitionalRuns(
	prisma: AppPrismaClient,
	liveChannelId: string,
	error: string,
): Promise<number> {
	const { count } = await prisma.liveChannelRun.updateMany({
		where: {
			liveChannelId,
			status: { in: [...TRANSITIONAL_RUN_STATUSES] },
		},
		data: {
			status: "ERROR",
			error,
			// Terminal rows get an end time: a null endedAt on a closed run
			// reads as "still live" to every aggregating reader.
			endedAt: new Date(),
		},
	});
	return count;
}

/** Manual START encodes its generation in the retained BullMQ identity. */
export function provisionJobGeneration(
	channelId: string,
	runId: string | null | undefined,
	jobId?: string,
): number | undefined {
	if (jobId === channelId || jobId === `probe-${channelId}`) return 0;
	const prefix = `manual-provision-${channelId}-${runId}-`;
	if (!runId || !jobId?.startsWith(prefix)) return undefined;
	const suffix = jobId.slice(prefix.length);
	const generation = Number(suffix);
	return /^\d+$/.test(suffix) && Number.isSafeInteger(generation)
		? generation
		: undefined;
}

/** A dead provision delivery cannot retire a cancellation, STOP or RESTART that won the channel. */
export async function recordExpiredProvisionFailure(
	prisma: AppPrismaClient,
	liveChannelId: string,
	error: string,
	staleBefore: Date,
	at: Date,
	admission: { runId: string; generation?: number } | { initial: true },
): Promise<boolean> {
	return prisma.$transaction(async (tx) => {
		const locked = await tx.$queryRaw<
			{ id: string }[]
		>`SELECT id FROM "LiveChannel" WHERE id=${liveChannelId}::uuid FOR UPDATE`;
		if (!locked.length) return false;
		const run = await tx.liveChannelRun.findFirst({
			where: { liveChannelId },
			orderBy: { seq: "desc" },
			select: { id: true, seq: true, cancelRequested: true },
		});
		if (
			run?.cancelRequested ||
			("runId" in admission
				? run?.id !== admission.runId
				: !!run && run.seq !== 1)
		)
			return false;
		const { count } = await tx.liveChannel.updateMany({
			where: {
				id: liveChannelId,
				...("initial" in admission
					? { liveEffectFenceVersion: 0 }
					: admission.generation !== undefined
						? { liveEffectFenceVersion: admission.generation }
						: {}),
				status: { in: ["CREATED", "PROVISIONING"] },
				OR: [
					{ provisionClaimedAt: null },
					{ provisionClaimedAt: { lt: staleBefore } },
				],
				...(run
					? {
							effectClaims: {
								none: {
									liveChannelRunId: run.id,
									action: { in: ["STOP", "RESTART"] },
									state: { in: [...LIVE_EFFECT_OPEN_STATES] },
								},
							},
						}
					: {}),
			},
			data: { status: "ERROR", error, provisionClaimedAt: null },
		});
		if (!count) return false;
		if (run)
			await tx.liveChannelRun.updateMany({
				where: {
					id: run.id,
					liveChannelId,
					status: { in: ["CREATED", "PROVISIONING"] },
				},
				data: { status: "ERROR", error, endedAt: at },
			});
		return true;
	});
}

export function createStrandedRunReconciler(deps: { prisma: AppPrismaClient }) {
	return async function reconcileStrandedRuns(): Promise<number> {
		const { count } = await deps.prisma.liveChannelRun.updateMany({
			where: {
				status: { in: [...TRANSITIONAL_RUN_STATUSES] },
				liveChannel: {
					status: "ERROR",
					effectClaims: {
						none: {
							action: "STOP",
							state: { in: [...LIVE_EFFECT_OPEN_STATES] },
						},
					},
				},
			},
			data: {
				status: "ERROR",
				error: STRANDED_RUN_ERROR,
				endedAt: new Date(),
			},
		});
		return count;
	};
}
