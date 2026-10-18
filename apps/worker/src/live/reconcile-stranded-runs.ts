import type { AppPrismaClient } from "@bitovp/db";

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
export const STRANDED_RUN_ERROR =
	"The job driving this run died and the channel was marked ERROR; the run row was left mid-transition, which blocked every restart. Retired by the worker's startup sweep — start the channel again.";

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

export function createStrandedRunReconciler(deps: { prisma: AppPrismaClient }) {
	return async function reconcileStrandedRuns(): Promise<number> {
		const { count } = await deps.prisma.liveChannelRun.updateMany({
			where: {
				status: { in: [...TRANSITIONAL_RUN_STATUSES] },
				liveChannel: { status: "ERROR" },
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
