import {
	classifyProviderStatusWord,
	type SecretCipher,
	type VerificationIntentSealInput,
	verificationIntentsSealable,
} from "@bitovp/core";
import {
	type AppPrismaClient,
	mutateResetCleanupTask,
	type ResetCleanupAccount,
	type ResetCleanupPayload,
	type ResetCleanupWebhook,
	readResetCleanupTask,
	readResetRtmpArchives,
} from "@bitovp/db";

export const RESET_ENCODING_ABSENT = Symbol("verified encoding absence");
export type ResetCleanupProvider = {
	status(id: string): Promise<string | typeof RESET_ENCODING_ABSENT>;
	stop(id: string): Promise<void>;
	releaseTemporaryKeys(id: string): Promise<void>;
	/** True only after an exact owned hook is deleted (including 404). */
	removeWebhook(hook: ResetCleanupWebhook): Promise<boolean>;
};

/** Returns only proven completions. Unknown ownership remains durable. */
export async function cleanResetPayload(
	payload: ResetCleanupPayload,
	providerFor: (account: ResetCleanupAccount) => Promise<ResetCleanupProvider>,
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
	const requireTerminal = new Set(
		payload.encodings
			.filter(
				(row) =>
					row.requireTerminal ||
					((row.entityKey.startsWith("liveChannel") ||
						row.entityKey.startsWith("liveEffectClaim:")) &&
						!row.allowCreated),
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
			.filter((e) => !e.allowVerifiedMissing)
			.map((e) => `${e.accountId}:${e.encodingId}`),
	);
	for (const row of payload.encodings) {
		try {
			const key = `${row.accountId}:${row.encodingId}`;
			const api = await provider(row.accountId);
			let status = await api.status(row.encodingId);
			if (
				status !== RESET_ENCODING_ABSENT &&
				classifyProviderStatusWord(status) !== "TERMINAL" &&
				status !== "CREATED"
			) {
				await api.stop(row.encodingId);
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
				if (
					row.entityKey.startsWith("liveChannel") ||
					row.entityKey.startsWith("liveEffectClaim:")
				)
					await api.releaseTemporaryKeys(row.encodingId);
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
				const current = await readResetCleanupTask(
					deps.prisma,
					deps.cipher,
					task.id,
				);
				if (!current) continue;
				// Older receipts can contain a verification intent's provider ID even though
				// another airing retained it in an effect journal. Recheck before any STOP.
				const snapshot = current.payload;
				const inventory =
					snapshot.verificationIntents.length && snapshot.encodings.length
						? await readResetRtmpArchives(deps.prisma)
						: null;
				const retained = new Set<string>();
				const encodings = snapshot.encodings.filter((row) => {
					if (!inventory) return true;
					if (inventory.ownedIds.has(row.encodingId)) {
						retained.add(
							JSON.stringify([row.entityKey, row.accountId, row.encodingId]),
						);
						return false;
					}
					return (
						!inventory.incompleteAccounts.has(null) &&
						!inventory.incompleteAccounts.has(row.accountId)
					);
				});
				const done = await cleanResetPayload(
					{ ...snapshot, encodings },
					deps.providerFor,
				);
				const applied = await mutateResetCleanupTask(
					deps.prisma,
					deps.cipher,
					task.id,
					(payload) => {
						payload.verificationIntents = payload.verificationIntents.filter(
							(intent) => !closedVerificationIntent(intent),
						);
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
