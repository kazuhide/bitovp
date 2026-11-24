import {
	aisaLiveFinalization,
	classifyProviderLifecycle,
	deriveProviderLifecycle,
	FEEDER_ACTIVE_STATUSES,
	type FeederJob,
	feederOccupancyWhere,
	type ProviderLifecycle,
	type ProviderObservation,
	providerEffectIdentityRefusal,
	providerEffectRefusal,
	redactSecrets,
} from "@bitovp/core";
import type {
	AppPrismaClient,
	AppTransactionClient,
	LiveEffectClaimHandle,
	Prisma,
} from "@bitovp/db";
import {
	assertLiveEffectCurrent,
	DB_NULL,
	LIVE_EFFECT_OPEN_STATES,
	liveChannelAccountId,
	recordConfirmedStopDelivery,
	replaceLiveRunStepLogSnapshot,
} from "@bitovp/db";
import type { SdkOps } from "../orchestrator/sdk-ops";
import {
	type DisplacedReadbacks,
	displacedRetirementWrite,
	type RtmpChannelSnapshot,
	type RtmpRunSnapshot,
	readDisplacedEncoders,
} from "./displaced-encoders";
import { tryLockCurrentPollChannel } from "./poll-channel-lock";

/**
 * the ONE place the
 * provider's lifecycle for a run's exact encoding is read back and reconciled
 * onto local state. Every entry that can put a channel into RUNNING or act on
 * its encoder calls this first: Start/revive (provision entry), Restart, the
 * heartbeat sweep, and provision finalize.
 *
 * What the audited sequence lacked was any reader of the encoding's OWN
 * status: the sweep polled the heartbeat, Restart trusted the local claim,
 * Start trusted the DONE step log, finalize trusted the details GET. So a
 * provider auto-shutdown (`FINISHED`) left local RUNNING, and the recovery
 * path revived the finished encoding's id, ingest coordinates and step log
 * into a second false RUNNING.
 *
 * Three outcomes, and the asymmetry between them is the design:
 *
 * - TERMINAL (FINISHED/ERROR/CANCELED/TRANSFER_ERROR, read back for exactly
 * this run's encoding) — the run is terminalised ONCE (`providerTerminalAt`
 * is the CAS). CANCELED and a normally completed RUNNING airing become STOPPED;
 * startup failures and other terminal words remain ERROR with
 * active coordinates and heartbeat cleared, every feeder of THAT run gets a
 * stop enqueued, and CHANNEL_STOPPED or CHANNEL_ERROR is emitted. The provider id is KEPT on
 * both rows — the stop/reset sweeps and the operator must still be able to
 * find the encoding (false-fix list: never delete the old id first).
 * - UNKNOWN (timeout, network/credential error, a single 404, an identity the
 * run does not carry) — nothing is cleaned up and no id, prefix, coordinate
 * or publisher claim moves. `providerUnknownSince` opens the window (first
 * writer wins) so the UI can say "cannot be confirmed since …" and the
 * sweep can alert past grace. The next successful readback closes it with
 * the SAME identity.
 * - RUNNING / TRANSITIONAL — the observation is recorded (word + time) and
 * the window, if open, is closed.
 *
 * Every run write is fenced on the run id AND the encoding id it carries, and
 * from the sweep — on the heartbeat poll epoch, so a late result from a
 * timed-out tick cannot overwrite a newer sample or land on a new run
 * (MEDIUM-1).
 */

export type RunLifecycleRow = RtmpRunSnapshot & {
	aisaAnalysisId?: string | null;
	aisaStatus?: string | null;
	aisaSnapshot?: unknown;
	aisaFinalization?: unknown;
	id: string;
	seq: number;
	status: string;
	error: string | null;
	bitmovinEncodingId: string | null;
	providerStatus: string | null;
	providerStatusObservedAt: Date | null;
	providerUnknownSince: Date | null;
	providerUnknownAlertedAt: Date | null;
	providerTerminalAt: Date | null;
	providerFeederStopsEnqueuedAt: Date | null;
	heartbeatPollEpoch: number;
	lastHeartbeatAt: Date | null;
	createdAt: Date;
};

export type ReconcileOutcome = {
	lifecycle: ProviderLifecycle;
	/** The provider's word when the readback succeeded. */
	status: string | null;
	observedAt: string;
	/** Why the outcome is UNKNOWN: the readback error or an identity problem. */
	reason: string | null;
	/** The run-row write landed (fenced on run id + encoding id [+ epoch]). */
	landed: boolean;
	/** TERMINAL only: THIS call terminalised the run (won the CAS). */
	terminalised: boolean;
	/** TERMINAL only: the channel row left its state (false = fenced out). */
	channelLanded: boolean;
	/** The refusal for a new provider/ingest effect, or null. */
	refusal: string | null;
	/** UNKNOWN only: when the window opened — this call's clock if just now. */
	unknownSince: Date | null;
};

/** The message a provider-terminal run and its channel carry. */
export function providerTerminalMessage(
	status: string,
	observedAt: string,
): string {
	return `Bitmovin reports this run's encoding ${status} (observed ${observedAt}) — the encoder is gone and cannot be restarted; start the channel for a fresh run (new encoding, new ingest coordinates)`;
}

class RunningCommitFenceLostError extends Error {}
class PollChannelUnavailableError extends Error {}

/** Owned transitions wait for channel-first writers before taking any run lock. */
async function lockOwnedChannel(tx: AppTransactionClient, channelId: string) {
	await tx.$queryRaw`
		SELECT id FROM "LiveChannel"
		WHERE id = ${channelId}::uuid
		FOR UPDATE`;
}

/** FINISHED proves completion, not that a failed startup ever went on air. */
function isFinishedAiring(
	status: string | null,
	run: RunLifecycleRow,
): boolean {
	return (
		status === "FINISHED" &&
		run.error === null &&
		(run.status === "RUNNING" || run.status === "STOPPED")
	);
}

function terminalError(
	status: string | null,
	run: RunLifecycleRow,
	message: string,
): string | null {
	if (status === "CANCELED" || isFinishedAiring(status, run)) return null;
	// A provider cleanup completion is not a replacement for the original failure.
	return status === "FINISHED" ? (run.error ?? message) : message;
}

const TERMINAL_RECONCILABLE_CHANNEL_STATUSES = [
	"CREATED",
	"PROVISIONING",
	"RUNNING",
	"STOPPING",
] as const;

const RUN_SELECT = {
	stepLog: true,
	previousProviderEncodingIds: true,
	archivedRtmpAttempt: true,
	rtmpRetirementEvidence: true,
	aisaAnalysisId: true,
	aisaStatus: true,
	aisaSnapshot: true,
	aisaFinalization: true,
	id: true,
	seq: true,
	status: true,
	error: true,
	bitmovinEncodingId: true,
	providerStatus: true,
	providerStatusObservedAt: true,
	providerUnknownSince: true,
	providerUnknownAlertedAt: true,
	providerTerminalAt: true,
	providerFeederStopsEnqueuedAt: true,
	heartbeatPollEpoch: true,
	lastHeartbeatAt: true,
	createdAt: true,
} as const;

export function createProviderLifecycleReconciler(deps: {
	prisma: AppPrismaClient;
	/** The injected ISO clock the live processor uses everywhere. */
	now(): string;
	enqueueFeederJob(job: FeederJob): Promise<void>;
	/**
	 * Null means CHANNEL_STOPPED (cancellation or normal completion); failures carry
	 * CHANNEL_ERROR text. Best-effort by the emitter's
	 * contract. Declared property-style on purpose: `emit-sites.test.ts`
	 * counts the emit CALL shape per file, and a method signature here would
	 * read as a second emit site.
	 */
	emitChannel: (liveChannelId: string, error: string | null) => Promise<void>;
}) {
	/**
	 * The channel's CURRENT run (newest by seq) with the lifecycle columns.
	 * Tolerates a stub or a pre-migration row that lacks the new columns by
	 * reading them as null / 0 — the same "no observation yet" a fresh row has.
	 */
	async function loadCurrentRun(
		liveChannelId: string,
	): Promise<RunLifecycleRow | null> {
		const run = (await deps.prisma.liveChannelRun.findFirst({
			where: { liveChannelId },
			orderBy: { seq: "desc" },
			select: RUN_SELECT,
		})) as Partial<RunLifecycleRow> | null;
		if (!run || typeof run.id !== "string") {
			return null;
		}
		return {
			stepLog: run.stepLog,
			previousProviderEncodingIds: run.previousProviderEncodingIds,
			archivedRtmpAttempt: run.archivedRtmpAttempt,
			rtmpRetirementEvidence: run.rtmpRetirementEvidence,
			aisaAnalysisId: run.aisaAnalysisId ?? null,
			aisaStatus: run.aisaStatus ?? null,
			aisaSnapshot: run.aisaSnapshot,
			aisaFinalization: run.aisaFinalization,
			id: run.id,
			seq: run.seq ?? 0,
			status: run.status ?? "CREATED",
			error: run.error ?? null,
			bitmovinEncodingId: run.bitmovinEncodingId ?? null,
			providerStatus: run.providerStatus ?? null,
			providerStatusObservedAt: run.providerStatusObservedAt ?? null,
			providerUnknownSince: run.providerUnknownSince ?? null,
			providerUnknownAlertedAt: run.providerUnknownAlertedAt ?? null,
			providerTerminalAt: run.providerTerminalAt ?? null,
			providerFeederStopsEnqueuedAt: run.providerFeederStopsEnqueuedAt ?? null,
			heartbeatPollEpoch: run.heartbeatPollEpoch ?? 0,
			lastHeartbeatAt: run.lastHeartbeatAt ?? null,
			createdAt: run.createdAt ?? new Date(deps.now()),
		};
	}

	/**
	 * Claims one heartbeat poll under the exact run, encoding and prior epoch.
	 * Keeping this write behind the lifecycle door prevents the sweep from
	 * gaining a general-purpose LiveChannelRun write capability.
	 */
	async function claimHeartbeatPoll(run: RunLifecycleRow) {
		const encodingId = run.bitmovinEncodingId;
		if (!encodingId) return null;
		const epoch = run.heartbeatPollEpoch + 1;
		const { count } = await deps.prisma.liveChannelRun.updateMany({
			where: {
				id: run.id,
				bitmovinEncodingId: encodingId,
				heartbeatPollEpoch: run.heartbeatPollEpoch,
			},
			data: { heartbeatPollEpoch: { increment: 1 } },
		});
		return count > 0 ? { runId: run.id, encodingId, epoch } : null;
	}

	/** Claims the first customer alert for one persisted UNKNOWN window. */
	async function claimUnknownAlert(
		run: RunLifecycleRow,
		token: { runId: string; encodingId: string; epoch: number },
		at: Date,
	): Promise<boolean> {
		if (token.runId !== run.id || token.encodingId !== run.bitmovinEncodingId) {
			return false;
		}
		const { count } = await deps.prisma.liveChannelRun.updateMany({
			where: {
				id: run.id,
				bitmovinEncodingId: token.encodingId,
				heartbeatPollEpoch: token.epoch,
				providerUnknownSince: { not: null },
				providerUnknownAlertedAt: null,
			},
			data: { providerUnknownAlertedAt: at },
		});
		return count === 1;
	}

	type TerminalRun = Pick<
		RunLifecycleRow,
		| "id"
		| "bitmovinEncodingId"
		| "providerTerminalAt"
		| "providerFeederStopsEnqueuedAt"
	>;

	/**
	 * Enqueue every stop intent for one terminal run, then seal that the queue
	 * accepted the complete set. A partial/failed attempt deliberately leaves
	 * the marker null so the repeatable sweep retries it after Redis recovers.
	 */
	async function enqueueTerminalFeederStops(
		run: TerminalRun,
	): Promise<boolean> {
		const terminalAt = run.providerTerminalAt;
		const encodingId = run.bitmovinEncodingId;
		if (
			terminalAt === null ||
			encodingId === null ||
			run.providerFeederStopsEnqueuedAt !== null
		) {
			return false;
		}
		const feeders = await deps.prisma.feederSession.findMany({
			where: {
				liveChannelRunId: run.id,
				OR: [
					// LC-02: a terminal row may keep the publisher claim even
					// after its pid pointer is lost. Provider terminalisation must
					// enqueue that stop intent too; the stop path will release only
					// when positive process-gone proof exists.
					feederOccupancyWhere(),
					// Staged holds deliberately do not occupy the publisher, but
					// they are active work bound to this exact run and must stop.
					{ status: { in: [...FEEDER_ACTIVE_STATUSES] } },
				],
			},
			select: { id: true },
		});
		let failed = false;
		for (const feeder of feeders) {
			try {
				await deps.enqueueFeederJob({
					feederSessionId: feeder.id,
					action: "stop",
				});
			} catch (enqueueErr) {
				failed = true;
				console.error(
					`[live-channel] provider-terminal reconcile: failed to enqueue feeder stop for ${feeder.id}:`,
					enqueueErr instanceof Error ? enqueueErr.message : enqueueErr,
				);
			}
		}
		if (failed) return false;
		const at = new Date(deps.now());
		const { count } = await deps.prisma.liveChannelRun.updateMany({
			where: {
				id: run.id,
				bitmovinEncodingId: encodingId,
				providerTerminalAt: terminalAt,
				providerFeederStopsEnqueuedAt: null,
			},
			data: { providerFeederStopsEnqueuedAt: at },
		});
		return count === 1;
	}

	/** Retry terminal feeder-stop intents even after the channel left RUNNING. */
	async function retryPendingTerminalFeederStops(): Promise<{
		pending: number;
		completed: number;
		failed: number;
	}> {
		const pendingRuns = await deps.prisma.liveChannelRun.findMany({
			where: {
				providerTerminalAt: { not: null },
				providerFeederStopsEnqueuedAt: null,
			},
			select: {
				id: true,
				bitmovinEncodingId: true,
				providerTerminalAt: true,
				providerFeederStopsEnqueuedAt: true,
			},
			take: 100,
		});
		let completed = 0;
		let failed = 0;
		for (const pendingRun of pendingRuns) {
			try {
				if (await enqueueTerminalFeederStops(pendingRun)) completed += 1;
				else failed += 1;
			} catch (err) {
				failed += 1;
				console.error(
					`[live-channel] terminal feeder-stop retry for run ${pendingRun.id} failed:`,
					err instanceof Error ? err.message : err,
				);
			}
		}
		return { pending: pendingRuns.length, completed, failed };
	}

	/** One readback of the encoding's own status. Never throws. */
	async function observe(
		sdk: SdkOps,
		encodingId: string,
	): Promise<ProviderObservation> {
		try {
			const task = await sdk.getEncodingStatus(encodingId);
			return { ok: true, status: String(task.status), observedAt: deps.now() };
		} catch (err) {
			return {
				ok: false,
				error: redactSecrets(err instanceof Error ? err.message : String(err)),
				observedAt: deps.now(),
			};
		}
	}

	/**
	 * Commits the provider's fresh RUNNING evidence and both local RUNNING
	 * projections as one fact. Lock the channel before the run, then verify the
	 * current run and its exact channel/encoding identity. The channel write
	 * matches that encoding and PROVISIONING claim,
	 * plus the provisioning lease when this is a Start finalize. If either side
	 * moved, throwing inside the interactive transaction rolls the other write
	 * back — a half-green run/channel is never observable.
	 *
	 * Missing coordinates are data too: null clears an earlier encoder's values
	 * instead of retaining a dead ingest endpoint across Restart or revive.
	 */
	async function commitRunning(args: {
		channel: { id: string };
		run: RunLifecycleRow | null;
		encodingId: string;
		observation: ProviderObservation;
		coordinates: { streamKey?: string | null; encoderIp?: string | null };
		/** Restart expects null; provision finalize expects and releases its Date. */
		provisionClaimedAt?: Date | null;
		restartClaim?: LiveEffectClaimHandle;
		/** Provision's redacted snapshot; the run also retains canonical receipts. */
		stepLog?: Prisma.InputJsonValue;
	}): Promise<boolean> {
		const { run, observation, encodingId } = args;
		if (
			!run ||
			run.bitmovinEncodingId !== encodingId ||
			!observation.ok ||
			classifyProviderLifecycle(observation, new Date(deps.now()).getTime()) !==
				"RUNNING"
		) {
			return false;
		}
		const providerObservedAt = new Date(observation.observedAt);
		const runningSince = new Date(deps.now());
		const streamKey = args.coordinates.streamKey ?? null;
		const encoderIp = args.coordinates.encoderIp ?? null;
		try {
			await deps.prisma.$transaction(async (tx) => {
				await lockOwnedChannel(tx, args.channel.id);
				if (args.restartClaim)
					await assertRestartOwner(tx, args.restartClaim, run.id);
				const latest = await tx.liveChannelRun.findFirst({
					where: { liveChannelId: args.channel.id },
					orderBy: { seq: "desc" },
					select: { id: true },
				});
				if (latest?.id !== run.id) throw new RunningCommitFenceLostError();
				const runWrite = await tx.liveChannelRun.updateMany({
					where: {
						id: run.id,
						liveChannelId: args.channel.id,
						bitmovinEncodingId: encodingId,
						providerTerminalAt: null,
					},
					data: {
						status: "RUNNING",
						error: null,
						runningSince,
						streamKey,
						encoderIp,
						providerStatus: observation.status,
						providerStatusObservedAt: providerObservedAt,
						providerUnknownSince: null,
						providerUnknownAlertedAt: null,
					},
				});
				if (runWrite.count !== 1) {
					throw new RunningCommitFenceLostError();
				}
				if (args.stepLog !== undefined) {
					if (!Array.isArray(args.stepLog))
						throw new Error("A live run step-log snapshot must be an array");
					const updated = await replaceLiveRunStepLogSnapshot(
						tx,
						args.channel.id,
						run.id,
						args.stepLog,
					);
					if (updated !== 1) throw new RunningCommitFenceLostError();
				}
				const channelWrite = await tx.liveChannel.updateMany({
					where: {
						id: args.channel.id,
						status: { in: ["PROVISIONING"] },
						bitmovinEncodingId: encodingId,
						...(args.provisionClaimedAt !== undefined
							? { provisionClaimedAt: args.provisionClaimedAt }
							: {}),
					},
					data: {
						status: "RUNNING",
						error: null,
						runningSince,
						streamKey,
						encoderIp,
						...(args.provisionClaimedAt !== undefined
							? { provisionClaimedAt: null }
							: {}),
						...(args.stepLog !== undefined ? { stepLog: args.stepLog } : {}),
					},
				});
				if (channelWrite.count !== 1) {
					throw new RunningCommitFenceLostError();
				}
			});
			return true;
		} catch (err) {
			if (err instanceof RunningCommitFenceLostError) {
				return false;
			}
			throw err;
		}
	}

	/**
	 * Commits a provider-terminal run and its denormalized channel projection in
	 * one database transaction. A channel that already re-aired does not match
	 * the exact encoding fence: the old run still becomes terminal, but the new
	 * airing is untouched. `persistRun:false` repairs the only partial state an
	 * older worker could leave — terminal run stamp with a still-live channel —
	 * without asking the provider again or emitting twice for an ERROR row.
	 */
	async function commitTerminal(args: {
		displaced: DisplacedReadbacks;
		channelId: string;
		run: RunLifecycleRow;
		encodingId: string;
		status: string;
		observedAt: Date;
		message: string;
		fenceWhere?: Record<string, unknown>;
		channelWrite?: {
			where?: Record<string, unknown>;
			data?: Record<string, unknown>;
		};
		persistRun: boolean;
		/** Only a fenced background observation may discard its whole transaction. */
		pollEpoch?: number;
		restartClaim?: LiveEffectClaimHandle;
		signal?: AbortSignal;
	}): Promise<{
		runLanded: boolean;
		channelLanded: boolean;
		durableNotification?: boolean;
	}> {
		const aisa = aisaLiveFinalization({
			...args.run,
			providerStatus: args.status,
		});
		if (aisa === "PENDING") {
			// The persisted encoder result is already sufficient while Analysis
			// drains. Replaying it could replace a newer observation timestamp.
			if (!args.persistRun) return { runLanded: false, channelLanded: false };
			await recordRunObservation(
				{
					where: {
						...(args.fenceWhere ?? {
							id: args.run.id,
							bitmovinEncodingId: args.encodingId,
						}),
						providerTerminalAt: null,
					},
					data: {
						providerStatus: args.status,
						providerStatusObservedAt: args.observedAt,
					},
				},
				args.run.id,
				args.restartClaim,
				args.signal,
			);
			return { runLanded: false, channelLanded: false };
		}
		const finishedNormally =
			aisa === "UNBOUND" && isFinishedAiring(args.status, args.run);
		const error =
			aisa === "COMPLETE"
				? null
				: aisa === "FAILED"
					? "AISA_LIVE_TERMINAL_FAILURE"
					: terminalError(args.status, args.run, args.message);
		const status = error === null ? "STOPPED" : "ERROR";
		let runLanded = !args.persistRun;
		let channelLanded = false;
		let durableNotification = false;
		try {
			await deps.prisma.$transaction(async (tx) => {
				args.signal?.throwIfAborted();
				if (args.pollEpoch === undefined) {
					// Keep old-run terminal facts even after a re-air: lock by channel
					// identity only, then preserve the exact run/projection CAS below.
					await lockOwnedChannel(tx, args.channelId);
					if (args.restartClaim)
						await assertRestartOwner(tx, args.restartClaim, args.run.id);
					args.signal?.throwIfAborted();
				}
				if (args.persistRun) {
					const runWrite = await tx.liveChannelRun.updateMany({
						where: {
							...(args.fenceWhere ?? {
								id: args.run.id,
								bitmovinEncodingId: args.encodingId,
							}),
							...(args.run.previousProviderEncodingIds !== undefined
								? {
										previousProviderEncodingIds: {
											equals: [...args.run.previousProviderEncodingIds],
										},
										archivedRtmpAttempt: args.run.archivedRtmpAttempt ?? 0,
									}
								: {}),
							providerTerminalAt: null,
							// A late FINISHED observation cannot erase an intervening
							// failure, even while the exact encoding ID remains unchanged.
							...(finishedNormally
								? { status: "RUNNING", error: null }
								: { status: { not: "STOPPED" } }),
						},
						data: {
							status,
							error,
							endedAt: args.observedAt,
							providerStatus: args.status,
							providerStatusObservedAt: args.observedAt,
							providerUnknownSince: null,
							providerUnknownAlertedAt: null,
							providerTerminalAt: args.observedAt,
						},
					});
					args.signal?.throwIfAborted();
					runLanded = runWrite.count === 1;
					if (!runLanded) return;
				}
				let polledChannelName: string | undefined;
				if (args.pollEpoch !== undefined) {
					// A cached terminal repair skipped the run CAS above. Keep its
					// exact epoch locked through the projection just like a fresh poll.
					if (!args.persistRun) {
						const rows = await tx.$queryRaw<{ id: string }[]>`
							SELECT id FROM "LiveChannelRun"
							WHERE id = ${args.run.id}::uuid
								AND "liveChannelId" = ${args.channelId}::uuid
								AND "bitmovinEncodingId" = ${args.encodingId}
								AND "heartbeatPollEpoch" = ${args.pollEpoch}
							FOR UPDATE SKIP LOCKED`;
						if (rows.length !== 1) throw new PollChannelUnavailableError();
					}
					const current = await tryLockCurrentPollChannel(
						tx,
						args.channelId,
						args.run.id,
						args.encodingId,
					);
					// A STOP owns terminal projection once admitted, including before
					// the worker sets STOPPING. Roll back the poll's run CAS as well.
					if (!current) throw new PollChannelUnavailableError();
					const canProject = await tx.liveChannel.findUnique({
						where: {
							id: args.channelId,
							status: "RUNNING",
							effectClaims: {
								none: {
									liveChannelRunId: args.run.id,
									action: "STOP",
									state: { in: [...LIVE_EFFECT_OPEN_STATES] },
								},
							},
						},
						select: { name: true },
					});
					if (!canProject) throw new PollChannelUnavailableError();
					polledChannelName = canProject.name;
				}
				// New archive entries must invalidate an in-flight primary-only observation.
				// When history exists, both the current account and every terminal receipt
				// are rechecked under the same locks as the broadcast projection.
				const archived =
					!!args.run.previousProviderEncodingIds?.length ||
					!!args.run.archivedRtmpAttempt ||
					args.displaced.receipts.length > 0;
				if (archived) {
					const current = await tx.liveChannelRun.findFirst({
						where: { id: args.run.id, liveChannelId: args.channelId },
						select: {
							stepLog: true,
							previousProviderEncodingIds: true,
							archivedRtmpAttempt: true,
							rtmpRetirementEvidence: true,
							liveChannel: {
								select: { stepLog: true, bitmovinAccountId: true, plan: true },
							},
						},
					});
					const write =
						current &&
						displacedRetirementWrite(
							current,
							current.liveChannel,
							args.displaced,
						);
					if (!write) throw new RunningCommitFenceLostError();
					if (write.rtmpRetirementEvidence)
						await tx.liveChannelRun.updateMany({
							where: { id: args.run.id, liveChannelId: args.channelId },
							data: write,
						});
				}
				args.signal?.throwIfAborted();
				const channelWrite = await tx.liveChannel.updateMany({
					where: {
						id: args.channelId,
						bitmovinEncodingId: args.encodingId,
						status: { in: [...TERMINAL_RECONCILABLE_CHANNEL_STATUSES] },
						...(args.run.previousProviderEncodingIds !== undefined
							? {
									runs: {
										some: {
											id: args.run.id,
											previousProviderEncodingIds: {
												equals: [...args.run.previousProviderEncodingIds],
											},
											archivedRtmpAttempt: args.run.archivedRtmpAttempt ?? 0,
										},
									},
								}
							: {}),
						...(args.channelWrite?.where ?? {}),
						...(finishedNormally ? { error: null } : {}),
					},
					data: {
						status,
						// SC-01: terminalising the current provider run invalidates every
						// claim admitted against its prior generation in the same atomic
						// channel projection write. A worker paused before send must lose.
						liveEffectFenceVersion: { increment: 1 },
						error,
						lastHeartbeat: DB_NULL,
						runningSince: null,
						streamKey: null,
						encoderIp: null,
						...(args.channelWrite?.data ?? {}),
					},
				});
				args.signal?.throwIfAborted();
				channelLanded = channelWrite.count === 1;
				if (
					channelLanded &&
					status === "STOPPED" &&
					polledChannelName !== undefined
				) {
					await recordConfirmedStopDelivery(tx, {
						liveChannelId: args.channelId,
						liveChannelRunId: args.run.id,
						scheduleIds: [],
						channelName: polledChannelName,
						notificationEligible: true,
						status,
						at: args.observedAt,
					});
					durableNotification = true;
				}
				if ((args.restartClaim || archived) && !channelLanded)
					throw new RunningCommitFenceLostError();
			});
		} catch (error) {
			if (
				error instanceof PollChannelUnavailableError ||
				error instanceof RunningCommitFenceLostError
			) {
				return { runLanded: false, channelLanded: false };
			}
			throw error;
		}
		return { runLanded, channelLanded, durableNotification };
	}

	async function assertRestartOwner(
		tx: AppTransactionClient,
		claim: LiveEffectClaimHandle,
		runId: string,
	) {
		if (
			runId !== claim.liveChannelRunId ||
			!(await assertLiveEffectCurrent(tx, claim, new Date(deps.now())))
		) {
			throw new RunningCommitFenceLostError(
				"Restart refused: its exact run/generation fence is no longer current",
			);
		}
	}

	async function recordRunObservation(
		query: Prisma.LiveChannelRunUpdateManyArgs,
		runId: string,
		restartClaim?: LiveEffectClaimHandle,
		signal?: AbortSignal,
	) {
		if (!restartClaim && !signal)
			return deps.prisma.liveChannelRun.updateMany(query);
		return deps.prisma.$transaction(async (tx) => {
			signal?.throwIfAborted();
			if (restartClaim) {
				await lockOwnedChannel(tx, restartClaim.liveChannelId);
				await assertRestartOwner(tx, restartClaim, runId);
			}
			const result = await tx.liveChannelRun.updateMany(query);
			signal?.throwIfAborted();
			return result;
		});
	}

	async function reconcile(args: {
		channel: { id: string } & RtmpChannelSnapshot;
		run: RunLifecycleRow | null;
		/** The EXACT encoding the caller is about to act on or trust. */
		encodingId: string;
		sdk: SdkOps;
		/** The sweep's poll token — every run write then CASes on it too. */
		fence?: { epoch: number };
		restartClaim?: LiveEffectClaimHandle;
		/** The monitoring attempt may no longer persist after its deadline. */
		signal?: AbortSignal;
		/**
		 * A readback the caller already made (provision finalize observes
		 * first and reconciles only a terminal answer) — skips the SDK call.
		 */
		observation?: ProviderObservation;
		/**
		 * Extra predicate/data for the TERMINAL channel write — the provision
		 * path fences on its lease and releases it in the same statement.
		 */
		channelWrite?: {
			where?: Record<string, unknown>;
			data?: Record<string, unknown>;
		};
	}): Promise<ReconcileOutcome> {
		const { channel, run, encodingId, sdk } = args;
		args.signal?.throwIfAborted();
		let observedAt = deps.now();
		const unknown = (reason: string): ReconcileOutcome => ({
			lifecycle: "UNKNOWN",
			status: null,
			observedAt,
			reason,
			landed: false,
			terminalised: false,
			channelLanded: false,
			refusal: providerEffectRefusal("UNKNOWN"),
			unknownSince: run?.providerUnknownSince ?? null,
		});
		if (!run) {
			return unknown(
				"the channel has no run row to reconcile the provider's status onto",
			);
		}
		if (
			run.bitmovinEncodingId !== null &&
			run.bitmovinEncodingId !== encodingId
		) {
			// The run is bound to ANOTHER encoding: acting on `encodingId` under
			// this run's identity is the confusion the invariant forbids.
			return unknown(
				`run ${run.id} carries encoding ${run.bitmovinEncodingId}, not ${encodingId} — refusing to reconcile across identities`,
			);
		}
		const displacedPending =
			"Displaced RTMP encoder retirement is not yet confirmed for this broadcast";
		const observeDisplaced = () =>
			readDisplacedEncoders(
				run,
				channel,
				liveChannelAccountId(channel),
				sdk,
				deps.now,
				args.signal,
			);
		if (
			deriveProviderLifecycle(run, new Date(observedAt).getTime()) ===
			"TERMINAL"
		) {
			const status = run.providerStatus ?? "ended";
			const persistedAt =
				run.providerStatusObservedAt ??
				run.providerTerminalAt ??
				new Date(observedAt);
			const persistedObservedAt = persistedAt.toISOString();
			const message = providerTerminalMessage(status, persistedObservedAt);
			const displaced = await observeDisplaced();
			if (!displaced) return unknown(displacedPending);
			const repaired = await commitTerminal({
				displaced,
				channelId: channel.id,
				run,
				encodingId,
				status,
				observedAt: persistedAt,
				message,
				channelWrite: args.channelWrite,
				persistRun: false,
				restartClaim: args.restartClaim,
				pollEpoch: args.fence?.epoch,
				signal: args.signal,
			});
			args.signal?.throwIfAborted();
			if (
				run.providerFeederStopsEnqueuedAt === null &&
				((args.fence === undefined &&
					args.restartClaim === undefined &&
					!run.previousProviderEncodingIds?.length &&
					!run.archivedRtmpAttempt) ||
					repaired.runLanded)
			) {
				await enqueueTerminalFeederStops(run).catch((err) => {
					console.error(
						`[live-channel] persisted-terminal feeder-stop attempt for run ${run.id} failed:`,
						err instanceof Error ? err.message : err,
					);
				});
			}
			if (repaired.channelLanded && !repaired.durableNotification) {
				await deps.emitChannel(channel.id, terminalError(status, run, message));
			}
			return {
				lifecycle: "TERMINAL",
				status,
				observedAt: persistedObservedAt,
				reason: message,
				landed: false,
				terminalised: false,
				channelLanded: repaired.channelLanded,
				refusal: providerEffectRefusal("TERMINAL"),
				unknownSince: null,
			};
		}
		let observation = args.observation ?? (await observe(sdk, encodingId));
		args.signal?.throwIfAborted();
		observedAt = observation.observedAt;
		const nowMs = new Date(deps.now()).getTime();
		let displaced: DisplacedReadbacks = {
			accountId: liveChannelAccountId(channel),
			receipts: [],
		};
		if (classifyProviderLifecycle(observation, nowMs) === "TERMINAL") {
			const proof = await observeDisplaced();
			if (proof) displaced = proof;
			else observation = { ok: false, error: displacedPending, observedAt };
		}
		const lifecycle = classifyProviderLifecycle(observation, nowMs);
		const now = new Date(observedAt);
		const fenceWhere = {
			id: run.id,
			providerTerminalAt: null,
			// An AISA encoder can finish while its Analysis is still draining:
			// its terminal word is durable before the final run stamp exists.
			...(run.aisaAnalysisId ? { providerStatus: run.providerStatus } : {}),
			...(run.bitmovinEncodingId !== null
				? { bitmovinEncodingId: encodingId }
				: {}),
			...(args.fence ? { heartbeatPollEpoch: args.fence.epoch } : {}),
		};

		if (lifecycle === "UNKNOWN") {
			const reason = observation.ok
				? `the provider answered an unrecognised status "${observation.status}"`
				: observation.error;
			// First writer opens the window; a later failure keeps the original
			// start, so grace and the customer strip measure from the first loss.
			const existingUnknownSince = run.providerUnknownSince;
			const { count } = await recordRunObservation(
				{
					where:
						existingUnknownSince === null
							? { ...fenceWhere, providerUnknownSince: null }
							: fenceWhere,
					data: {
						providerUnknownSince: existingUnknownSince ?? now,
						...(existingUnknownSince === null
							? { providerUnknownAlertedAt: null }
							: {}),
					},
				},
				run.id,
				args.restartClaim,
				args.signal,
			);
			return {
				...unknown(reason),
				landed: count > 0,
				unknownSince: existingUnknownSince ?? (count > 0 ? now : null),
			};
		}

		const status = observation.ok ? observation.status : null;
		if (lifecycle === "RUNNING" || lifecycle === "TRANSITIONAL") {
			const { count } = await recordRunObservation(
				{
					where: fenceWhere,
					data: {
						providerStatus: status,
						providerStatusObservedAt: now,
						providerUnknownSince: null,
						providerUnknownAlertedAt: null,
					},
				},
				run.id,
				args.restartClaim,
				args.signal,
			);
			return {
				lifecycle,
				status,
				observedAt,
				reason: null,
				landed: count > 0,
				terminalised: false,
				channelLanded: false,
				refusal: null,
				unknownSince: null,
			};
		}

		// TERMINAL — reconcile it onto exactly this run, once.
		const message = providerTerminalMessage(status ?? "ended", observedAt);
		const committed = await commitTerminal({
			displaced,
			channelId: channel.id,
			run,
			encodingId,
			status: status ?? "ended",
			observedAt: now,
			message,
			fenceWhere,
			channelWrite: args.channelWrite,
			persistRun: true,
			restartClaim: args.restartClaim,
			pollEpoch: args.fence?.epoch,
			signal: args.signal,
		});
		args.signal?.throwIfAborted();
		const terminal: ReconcileOutcome = {
			lifecycle: "TERMINAL",
			status,
			observedAt,
			reason: message,
			landed: committed.runLanded,
			terminalised: committed.runLanded,
			channelLanded: committed.channelLanded,
			refusal: providerEffectRefusal("TERMINAL"),
			unknownSince: null,
		};
		if (!committed.runLanded) {
			// Already terminalised (by an earlier entry), a clean stop, or a
			// fenced-out late result: nothing more to do and nothing to emit.
			return terminal;
		}
		// Queueing feeder stops is a durable two-phase operation. A transient
		// Redis failure leaves providerFeederStopsEnqueuedAt null; the repeatable
		// lifecycle sweep retries it even after this channel has moved to ERROR.
		await enqueueTerminalFeederStops({
			id: run.id,
			bitmovinEncodingId: encodingId,
			providerTerminalAt: now,
			providerFeederStopsEnqueuedAt: null,
		}).catch((err) => {
			console.error(
				`[live-channel] terminal feeder-stop attempt for run ${run.id} failed:`,
				err instanceof Error ? err.message : err,
			);
		});
		if (terminal.channelLanded && !committed.durableNotification) {
			await deps.emitChannel(channel.id, terminalError(status, run, message));
		}
		return terminal;
	}

	/**
	 * The refusal a NEW effect gets from the PERSISTED view (no provider
	 * round-trip — the sweep keeps a RUNNING channel's view fresh). Null when
	 * the effect may proceed.
	 */
	async function effectRefusal(
		liveChannelId: string,
		expected: { runId: string | null; encodingId: string | null },
	): Promise<string | null> {
		const run = await loadCurrentRun(liveChannelId);
		const identityRefusal = providerEffectIdentityRefusal({
			expectedRunId: expected.runId,
			expectedEncodingId: expected.encodingId,
			currentRunId: run?.id ?? null,
			currentEncodingId: run?.bitmovinEncodingId ?? null,
		});
		if (identityRefusal) {
			return identityRefusal;
		}
		return providerEffectRefusal(
			deriveProviderLifecycle(run, new Date(deps.now()).getTime()),
		);
	}

	/**
	 * Wait, bounded, for the EXACT encoding to read back RUNNING after an
	 * accepted Restart (§14.5 item 6): local stays PROVISIONING until then. A
	 * terminal word ends the wait at once; UNKNOWN and TRANSITIONAL readings
	 * are retried until the attempts run out.
	 */
	async function awaitRunning(args: {
		sdk: SdkOps;
		encodingId: string;
		attempts: number;
		intervalMs: number;
		sleep(ms: number): Promise<void>;
	}): Promise<{
		lifecycle: ProviderLifecycle;
		status: string | null;
		observedAt: string;
		reason: string | null;
	}> {
		let last: {
			lifecycle: ProviderLifecycle;
			status: string | null;
			observedAt: string;
			reason: string | null;
		} = {
			lifecycle: "UNKNOWN",
			status: null,
			observedAt: deps.now(),
			reason: "no readback attempted",
		};
		for (let attempt = 0; attempt < args.attempts; attempt += 1) {
			if (attempt > 0) {
				await args.sleep(args.intervalMs);
			}
			const observation = await observe(args.sdk, args.encodingId);
			const lifecycle = classifyProviderLifecycle(
				observation,
				new Date(observation.observedAt).getTime(),
			);
			last = {
				lifecycle,
				status: observation.ok ? observation.status : null,
				observedAt: observation.observedAt,
				reason: observation.ok ? null : observation.error,
			};
			if (lifecycle === "RUNNING" || lifecycle === "TERMINAL") {
				return last;
			}
		}
		return last;
	}

	return {
		loadCurrentRun,
		claimHeartbeatPoll,
		claimUnknownAlert,
		retryPendingTerminalFeederStops,
		observe,
		commitRunning,
		reconcile,
		effectRefusal,
		awaitRunning,
	};
}

export type ProviderLifecycleReconciler = ReturnType<
	typeof createProviderLifecycleReconciler
>;
