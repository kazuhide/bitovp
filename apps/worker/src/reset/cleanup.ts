import {
	classifyProviderStatusWord,
	type SecretCipher,
	type VerificationIntentSealInput,
	verificationIntentsSealable,
} from "@bitovp/core";
import {
	type AppPrismaClient,
	type AppTransactionClient,
	mutateResetCleanupTask,
	type ResetCleanupAccount,
	type ResetCleanupEncoding,
	type ResetCleanupPayload,
	type ResetCleanupWebhook,
	readResetCleanupTask,
	readVerificationCleanupWork,
} from "@bitovp/db";

export const RESET_ENCODING_ABSENT = Symbol("verified encoding absence");
export type ResetMutationWindow = { signal: AbortSignal; deadline: number };
export type ResetMutationGuard = (
	send: (window?: ResetMutationWindow) => Promise<unknown>,
) => Promise<boolean>;
export type ResetCleanupProvider = {
	status(id: string): Promise<string | typeof RESET_ENCODING_ABSENT>;
	stop(id: string, dispatch?: ResetMutationGuard): Promise<undefined | false>;
	releaseTemporaryKeys(
		id: string,
		dispatch?: ResetMutationGuard,
	): Promise<undefined | false>;
	/** True only after an exact owned hook is deleted (including 404). */
	removeWebhook(hook: ResetCleanupWebhook): Promise<boolean>;
};

/** Returns only proven completions. Unknown ownership remains durable. */
export async function cleanResetPayload(
	payload: ResetCleanupPayload,
	providerFor: (account: ResetCleanupAccount) => Promise<ResetCleanupProvider>,
	canMutate?: (row: ResetCleanupEncoding) => Promise<boolean>,
	dispatch?: (
		row: ResetCleanupEncoding,
		send: Parameters<ResetMutationGuard>[0],
	) => Promise<boolean>,
) {
	const encodings = new Set<string>();
	const webhooks = new Set<string>();
	const providers = new Map<string, ResetCleanupProvider>();
	const provider = async (accountId: string | null) => {
		const account = payload.accounts.find((row) => row.id === accountId);
		if (!account) throw new Error("Reset cleanup account unavailable");
		let api = providers.get(account.id);
		if (!api) {
			api = await providerFor(account);
			providers.set(account.id, api);
		}
		return api;
	};
	// Old combined selections could store an additional verification alias for
	// an encoder already covered by the direct owner's never-started proof.
	const proven = new Set(
		payload.encodings
			.filter((e) => e.allowCreated)
			.map((e) => JSON.stringify([e.accountId, e.encodingId])),
	);
	const provedOwnerRows = new Set(
		payload.encodings.filter((e) => e.allowCreated).map(cleanupOwnershipKey),
	);
	const isVerificationAlias = (row: ResetCleanupEncoding) =>
		!row.allowCreated &&
		(row.entityKey.includes(":verification-intent:") ||
			(row.verificationOwnerCheck &&
				provedOwnerRows.has(cleanupOwnershipKey(row)))) &&
		proven.has(JSON.stringify([row.accountId, row.encodingId]));
	const requireTerminal = new Set(
		payload.encodings
			.filter(
				(row) =>
					row.requireTerminal ||
					((row.entityKey.startsWith("liveChannel") ||
						row.entityKey.startsWith("liveEffectClaim:")) &&
						!row.allowCreated &&
						!isVerificationAlias(row)),
			)
			.map((row) => `${row.accountId}:${row.encodingId}`),
	);
	const pendingEntities = new Set(
		payload.pendingEntities.map((p) => p.entityKey),
	);
	const unsettled = new Set(
		payload.encodings
			.filter((e) => pendingEntities.has(e.entityKey))
			.map((e) => `${e.accountId}:${e.encodingId}`),
	);
	const unprovenAccount = new Set(
		payload.encodings
			.filter((e) => !e.allowVerifiedMissing && !isVerificationAlias(e))
			.map((e) => `${e.accountId}:${e.encodingId}`),
	);
	const withTemporaryKeys = new Set(
		payload.encodings
			.filter(
				(row) =>
					row.entityKey.startsWith("liveChannel") ||
					row.entityKey.startsWith("liveEffectClaim:"),
			)
			.map((row) => `${row.accountId}:${row.encodingId}`),
	);
	for (const row of payload.encodings) {
		try {
			const key = `${row.accountId}:${row.encodingId}`;
			if (encodings.has(key)) continue;
			const api = await provider(row.accountId);
			const authorized = canMutate ? () => canMutate(row) : undefined;
			const guarded: ResetMutationGuard | undefined = dispatch
				? (send) => dispatch(row, send)
				: undefined;
			let status = await api.status(row.encodingId);
			if (
				status !== RESET_ENCODING_ABSENT &&
				classifyProviderStatusWord(status) !== "TERMINAL" &&
				status !== "CREATED"
			) {
				if (authorized && !(await authorized())) continue;
				if ((await api.stop(row.encodingId, guarded)) === false) continue;
				status = await api.status(row.encodingId);
			}
			// A healthy replacement credential can see both exact endpoints as absent.
			const safe =
				status === RESET_ENCODING_ABSENT
					? !unprovenAccount.has(key) && !unsettled.has(key)
					: classifyProviderStatusWord(status) === "TERMINAL" ||
						(status === "CREATED" &&
							!requireTerminal.has(key) &&
							!unsettled.has(key));
			if (safe) {
				if (withTemporaryKeys.has(key)) {
					if (authorized && !(await authorized())) continue;
					if (
						(await api.releaseTemporaryKeys(row.encodingId, guarded)) === false
					)
						continue;
				}
				encodings.add(`${row.accountId}:${row.encodingId}`);
			}
		} catch {
			/* Retry without exposing provider errors or saved credentials. */
		}
	}
	for (const row of payload.webhooks) {
		try {
			if (
				await (await provider(row.accountId)).removeWebhook({
					...row,
					claimedUntil: payload.pendingEntities.some(
						(pending) => pending.entityKey === `webhookRegistration:${row.id}`,
					)
						? row.claimedUntil
						: null,
				})
			)
				webhooks.add(row.id);
		} catch {
			/* Retain exact ownership evidence for the next tick. */
		}
	}
	return { encodings, webhooks };
}

const cleanupOwnershipKey = (row: ResetCleanupEncoding) =>
	JSON.stringify([row.entityKey, row.accountId, row.encodingId]);

export function createResetCleanupSweep(deps: {
	prisma: AppPrismaClient;
	cipher: SecretCipher;
	providerFor: (account: ResetCleanupAccount) => Promise<ResetCleanupProvider>;
}) {
	let running = false;
	return async () => {
		if (running) return;
		running = true;
		try {
			const tasks = await deps.prisma.resetCleanupTask.findMany({
				where: { settledAt: null, nextAttemptAt: { lte: new Date() } },
				select: { id: true },
				orderBy: { nextAttemptAt: "asc" },
				take: 20,
			});
			for (const task of tasks) {
				let current = await readResetCleanupTask(
					deps.prisma,
					deps.cipher,
					task.id,
				);
				if (!current) continue;
				const checkedWorklist =
					current.payload.verificationIntents.length > 0 ||
					current.payload.encodings.some(
						(row) =>
							row.verificationOwnerCheck ||
							row.entityKey.includes(":verification-intent:"),
					);
				const verificationIntents = current.payload.verificationIntents;
				const cleanupAccounts = current.payload.accounts;
				const readWork = (
					db: AppPrismaClient | AppTransactionClient = deps.prisma,
				) =>
					readVerificationCleanupWork(
						db,
						verificationIntents,
						undefined,
						cleanupAccounts,
					);
				const work = checkedWorklist ? await readWork() : null;

				if (
					current.payload.verificationIntents.length &&
					!current.payload.verificationWorklistMaterialized
				) {
					const migrated = await mutateResetCleanupTask(
						deps.prisma,
						deps.cipher,
						task.id,
						(payload) => {
							const rows = new Map(
								payload.encodings.map((row) => [cleanupOwnershipKey(row), row]),
							);
							for (const candidate of work?.candidates ?? []) {
								const existing = rows.get(cleanupOwnershipKey(candidate));
								if (existing) existing.verificationOwnerCheck = true;
								else {
									payload.encodings.push(candidate);
									rows.set(cleanupOwnershipKey(candidate), candidate);
								}
							}
							payload.verificationWorklistMaterialized = true;
						},
						current.revision,
					);
					if (!migrated) continue;
					current = await readResetCleanupTask(
						deps.prisma,
						deps.cipher,
						task.id,
					);
					if (!current) continue;
				}
				// Older receipts can contain a verification intent's provider ID even though
				// another airing retained it in an effect journal. Recheck before any STOP.
				const snapshot = current.payload;
				const retained = new Set<string>();
				function permitted(
					row: ResetCleanupEncoding,
					currentWork: Awaited<ReturnType<typeof readWork>> | null,
				) {
					if (!currentWork) return true;
					const key = cleanupOwnershipKey(row);
					if (
						currentWork.owned(row.accountId, row.encodingId) ||
						currentWork.protectedWorkKeys.has(key)
					) {
						retained.add(key);
						return false;
					}
					const incomplete = currentWork.archive?.incompleteAccounts;
					return !Array.from(incomplete ?? []).some((owner) =>
						currentWork.overlaps(row.accountId, owner),
					);
				}
				const encodings = snapshot.encodings.filter((row) =>
					permitted(row, work),
				);
				const done = await cleanResetPayload(
					{ ...snapshot, encodings },
					deps.providerFor,
					// A retained job can adopt a verification asset during the provider GET.
					work ? async (row) => permitted(row, await readWork()) : undefined,
					work
						? async (row, send) => {
								// Start the budget before pool checkout. The transport must finish or
								// abort before Prisma can release the transaction's ownership lock.
								const deadline = performance.now() + 6_000;
								return deps.prisma.$transaction(
									async (tx) => {
										const [lock] = await tx.$queryRaw<
											{ acquired: boolean }[]
										>`SELECT pg_try_advisory_xact_lock(hashtextextended('bitovp/reset-ownership/' || current_setting('bitovp.organization_id'), 0)) AS acquired`;
										if (!lock?.acquired || !permitted(row, await readWork(tx)))
											return false;
										const remaining = Math.floor(deadline - performance.now());
										if (remaining <= 0) return false;
										await send({
											signal: AbortSignal.timeout(remaining),
											deadline,
										});
										return true;
									},
									{ timeout: 8_000, maxWait: 1_000, statementTimeoutMs: 3_000 },
								);
							}
						: undefined,
				);
				const applied = await mutateResetCleanupTask(
					deps.prisma,
					deps.cipher,
					task.id,
					(payload) => {
						// Do not consume a late append or a worker's remaining in-flight operation.
						payload.encodings = payload.encodings.filter(
							(row) =>
								(!done.encodings.has(`${row.accountId}:${row.encodingId}`) &&
									!retained.has(
										JSON.stringify([
											row.entityKey,
											row.accountId,
											row.encodingId,
										]),
									)) ||
								payload.pendingEntities.some(
									(pending) => pending.entityKey === row.entityKey,
								),
						);
						// Keep original verification identities while a deferred target awaits
						// classification; another live run or VOD job can adopt it between ticks.
						if (!payload.encodings.length)
							payload.verificationIntents = payload.verificationIntents.filter(
								(intent) => !closedVerificationIntent(intent),
							);
						payload.webhooks = payload.webhooks.filter(
							(row) =>
								!done.webhooks.has(row.id) ||
								payload.pendingEntities.some(
									(pending) =>
										pending.entityKey === `webhookRegistration:${row.id}`,
								),
						);
					},
					current.revision,
				);
				if (!applied) continue;
				const latest = await readResetCleanupTask(
					deps.prisma,
					deps.cipher,
					task.id,
				);
				if (!latest) continue;
				const pending = latest.payload;
				const settled =
					pending.encodings.length +
						pending.webhooks.length +
						pending.verificationIntents.length +
						pending.pendingEntities.length ===
					0;
				if (settled) {
					// No worker can append after its explicit ACK. Delete credentials with
					// the receipt only under the same revision that proved empty ownership.
					await deps.prisma.resetCleanupTask.deleteMany({
						where: { id: task.id, revision: latest.revision },
					});
					continue;
				}
				await deps.prisma.resetCleanupTask.updateMany({
					where: { id: task.id, revision: latest.revision },
					data: {
						nextAttemptAt: new Date(Date.now() + 30_000),
						settledAt: settled ? new Date() : null,
					},
				});
			}
		} finally {
			running = false;
		}
	};
}

function closedVerificationIntent(intent: Record<string, unknown>): boolean {
	if (
		typeof intent.verificationKey !== "string" ||
		typeof intent.state !== "string" ||
		typeof intent.cleanupState !== "string"
	)
		return false;
	return verificationIntentsSealable([intent as VerificationIntentSealInput])
		.sealable;
}
