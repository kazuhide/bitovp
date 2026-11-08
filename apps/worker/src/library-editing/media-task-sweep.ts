import { createHash, randomUUID } from "node:crypto";
import {
	mediaTaskEnvelopeSchema,
	mediaTaskResultCacheable,
} from "@bitovp/core";
import type { LibraryMediaTask, Prisma } from "@bitovp/db";
import {
	executeMediaTask,
	type MediaTaskExecutionDependencies,
	speechSelectionIntentFailureCode,
	trackingIntentFailureCode,
	type VerifiedMediaTask,
	verifyMediaTaskEvidence,
} from "./media-task-execution";
import { MediaOperationError } from "./process";

export const MEDIA_TASK_LEASE_MS = 120_000;
export const MEDIA_TASK_HEARTBEAT_MS = 5_000;
export const MEDIA_TASK_MAX_ATTEMPTS = 3;
let activeLocalTasks = 0;
const json = (value: unknown): Prisma.InputJsonValue => {
	const serialized = JSON.stringify(value);
	if (!serialized || serialized.length > 8 * 1024 * 1024)
		throw new MediaOperationError("TASK_RESULT_LIMIT");
	return JSON.parse(serialized) as Prisma.InputJsonValue;
};
const errorCode = (error: unknown) => {
	const code =
		error && typeof error === "object" && "code" in error
			? error.code
			: undefined;
	return typeof code === "string" && /^[A-Z][A-Z0-9_]{1,79}$/.test(code)
		? code
		: "PRODUCTION_TASK_FAILED";
};
const cacheLock = (organizationId: string, cacheKey: string) =>
	BigInt.asIntN(
		64,
		BigInt(
			`0x${createHash("sha256").update(`media-task-cache:${organizationId}:${cacheKey}`).digest("hex").slice(0, 16)}`,
		),
	);
type Dependencies = MediaTaskExecutionDependencies & {
	now?: () => Date;
	signal?: AbortSignal;
	concurrency?: number;
	timeoutMs?: number;
	localStoryTimeoutMs?: number;
	canClaim: () => Promise<boolean>;
};
type Claimed = { task: LibraryMediaTask; verified: VerifiedMediaTask };

async function claim(
	deps: Dependencies,
	candidate: LibraryMediaTask,
	now: () => Date,
): Promise<Claimed | null> {
	return deps.prisma.$transaction(
		async (tx) => {
			await tx.$executeRaw`SELECT pg_advisory_xact_lock(${cacheLock(candidate.organizationId, candidate.cacheKey)})`;
			const task = await tx.libraryMediaTask.findUnique({
				where: { id: candidate.id },
			});
			if (
				!task ||
				task.organizationId !== candidate.organizationId ||
				!["PENDING", "RUNNING"].includes(task.state) ||
				(task.state === "RUNNING" &&
					(!task.leaseUntil || task.leaseUntil > now()))
			)
				return null;
			const fence = {
				id: task.id,
				organizationId: task.organizationId,
				state: task.state,
				...(task.state === "RUNNING"
					? { leaseToken: task.leaseToken, leaseUntil: { lte: now() } }
					: {}),
			};
			if (task.cancelRequestedAt) {
				await tx.libraryMediaTask.updateMany({
					where: fence,
					data: {
						state: "CANCELED",
						phase: "CANCELED",
						finishedAt: now(),
						leaseToken: null,
						leaseUntil: null,
					},
				});
				return null;
			}
			if ((await deps.canClaim?.()) !== true) return null;
			const rejectIntent = async (code: string) => {
				await tx.libraryMediaTask.updateMany({
					where: fence,
					data: {
						state: "ERROR",
						phase: "FAILED",
						error: code,
						finishedAt: now(),
						leaseToken: null,
						leaseUntil: null,
					},
				});
			};
			const stored = mediaTaskEnvelopeSchema.safeParse(task.parameters);
			const unsupportedSpeech = stored.success
				? speechSelectionIntentFailureCode(stored.data)
				: undefined;
			if (unsupportedSpeech) {
				await rejectIntent(unsupportedSpeech);
				return null;
			}
			const media = await tx.libraryMediaVersion.findUnique({
				where: { id: task.mediaVersionId },
			});
			if (
				media &&
				media.organizationId === task.organizationId &&
				["PENDING", "RUNNING"].includes(media.state)
			) {
				await tx.libraryMediaTask.updateMany({
					where: fence,
					data: {
						state: "PENDING",
						phase: "WAITING_FOR_MEDIA",
						availableAt: new Date(now().getTime() + 5_000),
						leaseToken: null,
						leaseUntil: null,
					},
				});
				return null;
			}
			const verified = await verifyMediaTaskEvidence(tx, task);
			const intentFailure =
				trackingIntentFailureCode(verified.envelope) ??
				speechSelectionIntentFailureCode(verified.envelope);
			if (intentFailure) {
				await rejectIntent(intentFailure);
				return null;
			}
			// A previous generated project's draft/export may have been edited since completion.
			if (task.kind !== "GENERATE" && verified.envelope.identity.mediaSha256) {
				const cached = await tx.libraryMediaTask.findFirst({
					where: {
						id: { not: task.id },
						organizationId: task.organizationId,
						kind: task.kind,
						cacheKey: task.cacheKey,
						state: "SUCCEEDED",
					},
					orderBy: { createdAt: "desc" },
				});
				if (cached && mediaTaskResultCacheable(cached.result)) {
					await tx.libraryMediaTask.updateMany({
						where: fence,
						data: {
							state: "SUCCEEDED",
							phase: "CACHED",
							result: cached.result ?? {},
							progress: json({ cachedFromTaskId: cached.id }),
							finishedAt: now(),
							leaseToken: null,
							leaseUntil: null,
						},
					});
					return null;
				}
			}
			const active = await tx.libraryMediaTask.findFirst({
				where: {
					id: { not: task.id },
					organizationId: task.organizationId,
					kind: task.kind,
					cacheKey: task.cacheKey,
					state: "RUNNING",
				},
			});
			if (active) {
				await tx.libraryMediaTask.updateMany({
					where: fence,
					data: {
						state: "PENDING",
						phase: "WAITING_FOR_CACHE",
						availableAt: new Date(now().getTime() + 5_000),
						leaseToken: null,
						leaseUntil: null,
					},
				});
				return null;
			}
			if (task.attempts >= MEDIA_TASK_MAX_ATTEMPTS) {
				await tx.libraryMediaTask.updateMany({
					where: fence,
					data: {
						state: "ERROR",
						phase: "FAILED",
						error: "TASK_ATTEMPTS_EXHAUSTED",
						finishedAt: now(),
						leaseToken: null,
						leaseUntil: null,
					},
				});
				return null;
			}
			const startedAt = task.startedAt ?? now();
			const leaseToken = randomUUID(),
				leaseUntil = new Date(now().getTime() + MEDIA_TASK_LEASE_MS);
			const changed = await tx.libraryMediaTask.updateMany({
				where: fence,
				data: {
					state: "RUNNING",
					phase: "STARTING",
					attempts: { increment: 1 },
					leaseToken,
					leaseUntil,
					startedAt,
					error: null,
				},
			});
			return changed.count
				? {
						task: {
							...task,
							state: "RUNNING",
							leaseToken,
							leaseUntil,
							startedAt,
							attempts: task.attempts + 1,
						},
						verified,
					}
				: null;
		},
		{ maxWait: 5_000, timeout: 15_000, statementTimeoutMs: 5_000 },
	);
}

async function runClaimed(
	deps: Dependencies,
	owned: Claimed,
	timeoutMs: number,
	now: () => Date,
) {
	const task = owned.task,
		started = performance.now(),
		controller = new AbortController();
	const stop = (code: string) => {
		if (!controller.signal.aborted)
			controller.abort(new MediaOperationError(code));
	};
	const shutdown = () => stop("LEASE_LOST");
	deps.signal?.addEventListener("abort", shutdown, { once: true });
	if (deps.signal?.aborted) shutdown();
	const fence = () => ({
		id: task.id,
		organizationId: task.organizationId,
		state: "RUNNING",
		leaseToken: task.leaseToken,
		leaseUntil: { gt: now() },
		cancelRequestedAt: null,
	});
	let touching: Promise<void> | undefined;
	const touch = () =>
		(touching ??= (async () => {
			if (controller.signal.aborted) throw controller.signal.reason;
			const current = await deps.prisma.libraryMediaTask.findUnique({
				where: { id: task.id },
			});
			if (
				current?.leaseToken !== task.leaseToken ||
				current.state !== "RUNNING"
			) {
				stop("LEASE_LOST");
				throw controller.signal.reason;
			}
			if (current.cancelRequestedAt) {
				stop("CANCELED");
				throw controller.signal.reason;
			}
			const changed = await deps.prisma.libraryMediaTask.updateMany({
				where: fence(),
				data: { leaseUntil: new Date(now().getTime() + MEDIA_TASK_LEASE_MS) },
			});
			if (!changed.count) {
				stop("LEASE_LOST");
				throw controller.signal.reason;
			}
		})()
			.catch((error) => {
				if (!controller.signal.aborted) stop("LEASE_LOST");
				throw error;
			})
			.finally(() => {
				touching = undefined;
			}));
	const heartbeat = setInterval(() => {
		void touch().catch(() => {});
	}, MEDIA_TASK_HEARTBEAT_MS);
	heartbeat.unref?.();
	const timeout = setTimeout(() => stop("TIMED_OUT"), timeoutMs);
	timeout.unref?.();
	const onProgress = async (
		phase: string,
		progress?: Record<string, unknown>,
	) => {
		if (
			!/^[A-Z][A-Z0-9_]{0,63}$/.test(phase) ||
			(progress && JSON.stringify(progress).length > 64 * 1024)
		)
			throw new MediaOperationError("TASK_PROGRESS_INVALID");
		await touch();
		const changed = await deps.prisma.libraryMediaTask.updateMany({
			where: fence(),
			data: {
				phase,
				progress: json({
					...progress,
					elapsedMs: Math.round(performance.now() - started),
				}),
			},
		});
		if (!changed.count) {
			stop("LEASE_LOST");
			throw controller.signal.reason;
		}
	};
	try {
		await touch();
		const result = await executeMediaTask({
			task,
			verified: owned.verified,
			dependencies: deps,
			signal: controller.signal,
			timeoutMs,
			onProgress,
		});
		// GENERATE commits its projects and successful task result together.
		// Its terminal row is immutable and must never be touched by a late heartbeat.
		if (task.kind === "GENERATE") {
			const completed = await deps.prisma.libraryMediaTask.findUnique({
				where: { id: task.id },
			});
			if (
				completed?.organizationId === task.organizationId &&
				completed.state === "SUCCEEDED"
			)
				return;
		}
		await touch();
		await deps.prisma.$transaction(
			async (tx) => {
				const current = await tx.libraryMediaTask.findFirst({ where: fence() });
				if (!current) throw new MediaOperationError("LEASE_LOST");
				await verifyMediaTaskEvidence(tx, current, owned.verified.binding);
				const changed = await tx.libraryMediaTask.updateMany({
					where: fence(),
					data: {
						state: "SUCCEEDED",
						phase: "COMPLETE",
						result: json(result),
						progress: json({
							executionMs: Math.round(performance.now() - started),
							queueWaitMs: Math.max(
								0,
								(task.startedAt ?? task.createdAt).getTime() -
									task.createdAt.getTime(),
							),
						}),
						finishedAt: now(),
						leaseToken: null,
						leaseUntil: null,
						error: null,
					},
				});
				if (!changed.count) throw new MediaOperationError("LEASE_LOST");
			},
			{ maxWait: 5_000, timeout: 15_000, statementTimeoutMs: 5_000 },
		);
	} catch (failure) {
		const remoteCleanupUnconfirmed =
			owned.verified.envelope.input.kind === "GENERATE" &&
			owned.verified.envelope.input.parameters.policy === "LOCAL_STORY" &&
			errorCode(failure) === "LOCAL_SEMANTIC_CANCEL_UNCONFIRMED";
		const code = errorCode(
			!remoteCleanupUnconfirmed && controller.signal.aborted
				? controller.signal.reason
				: failure,
		);
		const where = {
			id: task.id,
			organizationId: task.organizationId,
			state: "RUNNING",
			leaseToken: task.leaseToken,
		};
		if (code === "LEASE_LOST") {
			// The same task remains recoverable after shutdown or an interrupted owner.
			await deps.prisma.libraryMediaTask.updateMany({
				where,
				data: { leaseUntil: new Date(now().getTime() - 1), availableAt: now() },
			});
		} else {
			const current = await deps.prisma.libraryMediaTask.findUnique({
				where: { id: task.id },
			});
			const canceled =
				!remoteCleanupUnconfirmed &&
				(code === "CANCELED" || !!current?.cancelRequestedAt);
			await deps.prisma.libraryMediaTask.updateMany({
				where,
				data: {
					state: canceled ? "CANCELED" : "ERROR",
					phase: remoteCleanupUnconfirmed
						? "CANCEL_UNCONFIRMED"
						: canceled
							? "CANCELED"
							: "FAILED",
					error: canceled ? null : code,
					finishedAt: now(),
					leaseToken: null,
					leaseUntil: null,
				},
			});
		}
	} finally {
		clearInterval(heartbeat);
		clearTimeout(timeout);
		deps.signal?.removeEventListener("abort", shutdown);
		await touching?.catch(() => {});
	}
}

/** Bounded across tenant factories in one worker, and cache-serialized across processes. */
export function createLibraryMediaTaskSweep(deps: Dependencies) {
	const concurrency =
			deps.concurrency ??
			Number(process.env.LIBRARY_MEDIA_TASK_CONCURRENCY ?? 1),
		timeoutMs = deps.timeoutMs ?? 15 * 60_000,
		localStoryTimeoutMs = deps.localStoryTimeoutMs ?? 90 * 60_000;
	if (
		!Number.isInteger(concurrency) ||
		concurrency < 1 ||
		concurrency > 2 ||
		!Number.isSafeInteger(timeoutMs) ||
		timeoutMs < 1 ||
		timeoutMs > 30 * 60_000 ||
		!Number.isSafeInteger(localStoryTimeoutMs) ||
		localStoryTimeoutMs < 1 ||
		localStoryTimeoutMs > 120 * 60_000
	)
		throw new RangeError("Invalid production worker bounds");
	const now = deps.now ?? (() => new Date());
	let pending: Promise<void> | undefined;
	return () =>
		(pending ??= (async () => {
			if (deps.signal?.aborted || activeLocalTasks >= concurrency) return;
			const candidates = await deps.prisma.libraryMediaTask.findMany({
				where: {
					availableAt: { lte: now() },
					OR: [
						{ state: "PENDING" },
						{ state: "RUNNING", leaseUntil: { lte: now() } },
					],
				},
				orderBy: [{ createdAt: "asc" }, { id: "asc" }],
				take: 20,
			});
			const running: Promise<void>[] = [];
			for (const candidate of candidates) {
				if (deps.signal?.aborted || activeLocalTasks >= concurrency) break;
				activeLocalTasks++;
				try {
					const owned = await claim(deps, candidate, now);
					if (!owned) {
						activeLocalTasks--;
						continue;
					}
					const localStory =
						owned.verified.envelope.input.kind === "GENERATE" &&
						owned.verified.envelope.input.parameters.policy === "LOCAL_STORY";
					running.push(
						runClaimed(
							deps,
							owned,
							localStory ? localStoryTimeoutMs : timeoutMs,
							now,
						).finally(() => {
							activeLocalTasks--;
						}),
					);
				} catch (failure) {
					activeLocalTasks--;
					await deps.prisma.libraryMediaTask.updateMany({
						where: {
							id: candidate.id,
							organizationId: candidate.organizationId,
							OR: [
								{ state: "PENDING" },
								{ state: "RUNNING", leaseUntil: { lte: now() } },
							],
						},
						data: {
							state: "ERROR",
							phase: "FAILED",
							error: errorCode(failure),
							finishedAt: now(),
							leaseToken: null,
							leaseUntil: null,
						},
					});
				}
			}
			await Promise.all(running);
		})().finally(() => {
			pending = undefined;
		}));
}
