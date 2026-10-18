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
} from "@bitovp/db";

export type ResetCleanupProvider = {
	status(id: string): Promise<string>;
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
	for (const row of payload.encodings) {
		try {
			const api = await provider(row.accountId);
			let status = await api.status(row.encodingId);
			if (
				classifyProviderStatusWord(status) !== "TERMINAL" &&
				status !== "CREATED"
			) {
				await api.stop(row.encodingId);
				status = await api.status(row.encodingId);
			}
			// A CREATED resource is safe only when no dispatched owner can still START it.
			if (
				classifyProviderStatusWord(status) === "TERMINAL" ||
				(status === "CREATED" &&
					!payload.pendingEntities.some(
						(pending) => pending.entityKey === row.entityKey,
					))
			) {
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
				const done = await cleanResetPayload(current.payload, deps.providerFor);
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
								!done.encodings.has(`${row.accountId}:${row.encodingId}`) ||
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
