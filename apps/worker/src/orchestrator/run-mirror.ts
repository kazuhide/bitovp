import type { AppPrismaClient, Prisma } from "@bitovp/db";
import { tryLockCurrentPollChannel } from "../live/poll-channel-lock";

/**
 *  §6 step 3 — the DUAL-WRITE seam. The worker still writes the
 * channel columns (the rollback-safe side); this mirror copies each write
 * onto the channel's CURRENT run row, so readers can move to runs (PR2's
 * second half) before the channel columns are dropped (a later migration).
 *
 * Mirroring is deliberately BEST-EFFORT-SHAPED but not silent: a mirror
 * failure throws — the two sides drifting silently is the exact disease the
 * run model exists to cure. The one tolerated absence: a channel with NO run
 * row (never started, or a pre-PR3 start path that hasn't ensured one) —
 * `mirror` is a no-op there, because there is no history to lie about, and
 * the provision path calls `ensure` first.
 */
export type RunMirrorData = {
	status?:
		| "CREATED"
		| "PROVISIONING"
		| "RUNNING"
		| "STOPPING"
		| "STOPPED"
		| "ERROR";
	error?: string | null;
	stepLog?: Prisma.InputJsonValue;
	encoderIp?: string;
	streamKey?: string;
	runningSince?: Date;
	liveToVod?: Prisma.InputJsonValue;
	bitmovinEncodingId?: string;
	/** rev431: null clears the run's stop/CREATED confirmation (a (re)start). */
	encoderStoppedConfirmedFor?: null;
};

const TERMINAL = new Set(["STOPPED", "ERROR"]);

export function createRunMirror(
	prisma: Pick<AppPrismaClient, "liveChannelRun">,
) {
	async function latestRun(liveChannelId: string) {
		return prisma.liveChannelRun.findFirst({
			where: { liveChannelId },
			orderBy: { seq: "desc" },
			select: {
				id: true,
				seq: true,
				status: true,
				providerStatus: true,
				providerStatusObservedAt: true,
				providerUnknownSince: true,
				providerTerminalAt: true,
			},
		});
	}

	return {
		/**
		 * The newest run's coordinates — what the sweep's start arms need to
		 * decide seq, revive-vs-create and the #155 rebase. A READ only: the
		 * start arms' run WRITES ride the channel-claim transaction (the
		 * sweep's claimWithRun, exactly like the route's own tx — review-284
		 * N2), so a failed run write rolls the claim back instead of
		 * committing an orphan step log.
		 */
		async latest(liveChannelId: string) {
			return latestRun(liveChannelId);
		},

		/**
		 * The current run's id, creating a CREATED row when the latest run is
		 * absent or terminal (the lazy path for channels whose start predates
		 * PR3's run-creating START). Serialized by the partial unique index
		 * `LiveChannelRun_one_live_per_channel`: a concurrent creator loses
		 * with P2002 and re-reads — the transition-is-the-lock pattern.
		 */
		async ensureCurrentRun(liveChannelId: string): Promise<string> {
			const latest = await latestRun(liveChannelId);
			if (latest && !TERMINAL.has(latest.status)) {
				return latest.id;
			}
			// review-242 A2: P2002 is a CONTENTION signal, and both unique
			// indexes raise it (the one-live-per-channel partial AND the
			// (channel,seq) pair) — indistinguishable here. Two attempts,
			// seq RECOMPUTED each time (the winner consumed latest.seq+1):
			// if the racing winner is still live we join it; if it already
			// went terminal, the index is demonstrably free and a fresh
			// create succeeds. Throwing was the old shape — fail-loud for a
			// state that had already resolved itself.
			for (let attempt = 0; attempt < 2; attempt += 1) {
				const current = await latestRun(liveChannelId);
				if (current && !TERMINAL.has(current.status)) {
					return current.id;
				}
				try {
					const created = await prisma.liveChannelRun.create({
						data: {
							liveChannelId,
							seq: (current?.seq ?? 0) + 1,
							status: "CREATED",
							// The lazy path serves channels whose start predates the
							// run-creating START — those wrote at the plan's own
							// destinations, so "" stays the honest record here even
							// now that #155 rebases the runs the start paths create.
							outputPrefix: "",
						},
						select: { id: true },
					});
					return created.id;
				} catch (err) {
					if ((err as { code?: string }).code !== "P2002") {
						throw err;
					}
				}
			}
			const final = await latestRun(liveChannelId);
			if (final && !TERMINAL.has(final.status)) {
				return final.id;
			}
			throw new Error(
				`ensureCurrentRun: run creation for ${liveChannelId} lost two races and no live run exists`,
			);
		},

		/**
		 * Copy a channel-column write onto the current run. `endedAt` is
		 * stamped only on its first terminal transition (the run's clock, not
		 * a later cleanup observation or a subsequent run's clock).
		 */
		async mirror(liveChannelId: string, data: RunMirrorData): Promise<void> {
			const latest = await latestRun(liveChannelId);
			if (!latest) {
				return;
			}
			// EXPLICIT pick, never a spread (review-109pr1, round 6): a spread
			// would let any wider object smuggle fields — including the
			// heartbeat anchor — past the type into the row. With the pick,
			// mirror CANNOT write lastHeartbeatAt no matter what it is
			// handed; the door factory is the anchor's only entrance. Nor can
			// it write lastHeartbeat (review-242 final suggestion): the
			// displayed sample and the alerting anchor must move TOGETHER,
			// so recordHeartbeat writes both halves and nothing else writes
			// either.
			await prisma.liveChannelRun.update({
				where: { id: latest.id },
				data: {
					...(data.status !== undefined ? { status: data.status } : {}),
					...(data.error !== undefined ? { error: data.error } : {}),
					...(data.stepLog !== undefined ? { stepLog: data.stepLog } : {}),
					...(data.encoderIp !== undefined
						? { encoderIp: data.encoderIp }
						: {}),
					...(data.streamKey !== undefined
						? { streamKey: data.streamKey }
						: {}),
					...(data.runningSince !== undefined
						? { runningSince: data.runningSince }
						: {}),
					...(data.liveToVod !== undefined
						? { liveToVod: data.liveToVod }
						: {}),
					// rev431: a mirrored pointer is an encoding being (re)started —
					// the run's stop/CREATED confirmation cannot stand for it.
					...(data.bitmovinEncodingId !== undefined
						? {
								bitmovinEncodingId: data.bitmovinEncodingId,
								encoderStoppedConfirmedFor: null,
							}
						: {}),
					...(data.encoderStoppedConfirmedFor !== undefined
						? { encoderStoppedConfirmedFor: data.encoderStoppedConfirmedFor }
						: {}),
				},
			});
			if (data.status && TERMINAL.has(data.status)) {
				// Null-only at the write, not a stale read's `??`: another writer
				// may already have recorded the first end while mirror awaited.
				await prisma.liveChannelRun.updateMany({
					where: { id: latest.id, status: data.status, endedAt: null },
					data: { endedAt: new Date() },
				});
			}
		},
	};
}

export type RunMirror = ReturnType<typeof createRunMirror>;

/**
 * The HEARTBEAT_STALE anchor's ONLY door — a SEPARATE FACTORY, not a method
 * on the mirror (review-109pr1 round 7): the round-6 call-shaped grep was
 * escaped by measurement twice (destructure `const { recordHeartbeat } =
 * runs`, then aliasing), and a regex cannot decide reachability. The
 * structural end: the mirror OBJECT physically lacks the door, so a consumer
 * holding a RunMirror cannot reach recordHeartbeat by destructure, alias,
 * bracket or any other spelling — tsc refuses, the instrument that killed a
 * mutation vitest survived. The door exists only where THIS factory is
 * constructed, and importing it is the only way in — which is what the
 * token-presence pin watches (dynamic import remains the named residual).
 */
/**
 * the poll token a sweep holds for one
 * channel's tick — the run it read, the encoding that run carried, and the
 * epoch its claim bumped to. A heartbeat write carrying a token lands only
 * while the run still IS that run, still carries that encoding, and no later
 * sweep has claimed the channel since; otherwise it is discarded whole.
 */
export type HeartbeatPollToken = {
	runId: string;
	encodingId: string;
	epoch: number;
};

class StaleHeartbeatPollError extends Error {}

export function createHeartbeatDoor(prisma: AppPrismaClient) {
	return {
		/**
		 * Returns whether the write LANDED. Unfenced (no token — the manual
		 * `heartbeat` action and channels whose run carries no encoding id),
		 * count 0 is the tolerated absence mirror has and reads as landed;
		 * fenced, count 0 means the token no longer matches and the caller
		 * must discard the sample, its history row and its alert evaluation.
		 */
		async recordHeartbeat(
			liveChannelId: string,
			encodingId: string,
			at: Date,
			redactedSample: Prisma.InputJsonValue,
			token?: HeartbeatPollToken,
			history?: {
				raw: Prisma.InputJsonValue;
				deltas: Prisma.InputJsonValue;
			},
			signal?: AbortSignal,
		): Promise<boolean> {
			signal?.throwIfAborted();
			// review-242 A3: match the run by the ENCODING the sample was
			// fetched for — a unique-index hit, and it deletes the "sample
			// stamped onto the wrong run" race when a stop landed between the
			// poll and this write. count 0 (no run carries the id yet) is the
			// same tolerated absence as mirror's.
			if (!token) {
				await prisma.liveChannelRun.updateMany({
					where: { liveChannelId, bitmovinEncodingId: encodingId },
					data: { lastHeartbeat: redactedSample, lastHeartbeatAt: at },
				});
				return true;
			}
			if (!history) {
				throw new Error(
					"a fenced heartbeat write requires its history payload",
				);
			}
			try {
				await prisma.$transaction(async (tx) => {
					signal?.throwIfAborted();
					// This row update both validates the token and locks the exact run.
					// A later sweep's epoch claim therefore cannot pass this point until
					// the run sample, channel fallback and history row commit together.
					const runWrite = await tx.liveChannelRun.updateMany({
						where: {
							id: token.runId,
							liveChannelId,
							bitmovinEncodingId: encodingId,
							heartbeatPollEpoch: token.epoch,
						},
						data: { lastHeartbeat: redactedSample, lastHeartbeatAt: at },
					});
					signal?.throwIfAborted();
					if (runWrite.count !== 1) {
						throw new StaleHeartbeatPollError();
					}
					// Channel-first transitions may already be waiting for this run.
					// A miss must roll back the run sample, not just its projection.
					if (
						!(await tryLockCurrentPollChannel(
							tx,
							liveChannelId,
							token.runId,
							encodingId,
						))
					) {
						throw new StaleHeartbeatPollError();
					}
					signal?.throwIfAborted();
					const channelWrite = await tx.liveChannel.updateMany({
						where: { id: liveChannelId, bitmovinEncodingId: encodingId },
						data: { lastHeartbeat: redactedSample },
					});
					signal?.throwIfAborted();
					if (channelWrite.count !== 1) {
						throw new StaleHeartbeatPollError();
					}
					await tx.liveHeartbeat.create({
						data: {
							liveChannelId,
							liveChannelRunId: token.runId,
							at,
							raw: history.raw,
							deltas: history.deltas,
						},
					});
					signal?.throwIfAborted();
				});
				return true;
			} catch (err) {
				if (err instanceof StaleHeartbeatPollError) {
					return false;
				}
				throw err;
			}
		},
	};
}
