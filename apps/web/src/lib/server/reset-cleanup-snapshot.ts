import type { SecretCipher } from "@bitovp/core";
import {
	type AppTransactionClient,
	createResetCleanupTask,
	type Prisma,
	type ResetCleanupPayload,
} from "@bitovp/db";
import type { ResetCategory } from "@/lib/reset-selection";

/** Unbounded ownership snapshot; the bounded customer report is not a cleanup index. */
export async function snapshotResetCleanup(
	tx: AppTransactionClient,
	selected: Set<ResetCategory>,
	cipher: SecretCipher,
) {
	const payload: ResetCleanupPayload = {
		v: 1,
		accounts: [],
		encodings: [],
		webhooks: [],
		verificationIntents: [],
		pendingEntities: [],
	};
	const entityKeys: string[] = [];
	const accountIds = new Set<string>();
	function entity(
		kind: string,
		row: {
			id: string;
			status: string;
			bitmovinAccountId: string | null;
			bitmovinEncodingId?: string | null;
			stepLog?: Prisma.JsonValue;
			attemptClaimedAt?: Date | null;
			provisionClaimedAt?: Date | null;
			recoveryLeaseUntil?: Date | null;
		},
	) {
		const entityKey = `${kind}:${row.id}`;
		entityKeys.push(entityKey);
		if (row.bitmovinAccountId) accountIds.add(row.bitmovinAccountId);
		const ids = new Set<string>();
		if (row.bitmovinEncodingId) ids.add(row.bitmovinEncodingId);
		if (Array.isArray(row.stepLog))
			for (const step of row.stepLog) {
				if (
					step &&
					typeof step === "object" &&
					!Array.isArray(step) &&
					step.kind === "CREATE_ENCODING" &&
					typeof step.resourceId === "string"
				)
					ids.add(step.resourceId);
			}
		for (const encodingId of ids)
			payload.encodings.push({
				entityKey,
				encodingId,
				accountId: row.bitmovinAccountId,
			});
		if (
			row.attemptClaimedAt ||
			row.provisionClaimedAt ||
			row.recoveryLeaseUntil
		) {
			payload.pendingEntities.push({
				entityKey,
				accountId: row.bitmovinAccountId,
				status: row.status,
				ownerToken: (
					row.attemptClaimedAt ??
					row.provisionClaimedAt ??
					row.recoveryLeaseUntil
				)?.toISOString(),
			});
			// Timestamp leases record only the latest holder, not all displaced
			// SDK calls. Its ACK cannot prove an older expired holder has stopped.
			if (row.attemptClaimedAt || row.provisionClaimedAt)
				payload.pendingEntities.push({
					entityKey,
					accountId: row.bitmovinAccountId,
					status: "UNCONFIRMED_PRIOR_OWNER",
					ownerToken: "unconfirmed-prior-owner",
				});
		}
	}
	if (selected.has("vodJobs"))
		for (const row of await tx.encodingJob.findMany({
			select: {
				id: true,
				status: true,
				attemptClaimedAt: true,
				bitmovinAccountId: true,
				bitmovinEncodingId: true,
				stepLog: true,
			},
		}))
			entity("encodingJob", row);
	if (selected.has("liveChannels")) {
		for (const row of await tx.liveChannel.findMany({
			select: {
				id: true,
				status: true,
				provisionClaimedAt: true,
				bitmovinAccountId: true,
				bitmovinEncodingId: true,
				stepLog: true,
			},
		}))
			entity("liveChannel", row);
		for (const row of await tx.liveChannelRun.findMany({
			select: {
				id: true,
				status: true,
				bitmovinEncodingId: true,
				stepLog: true,
				liveChannel: { select: { bitmovinAccountId: true } },
			},
		}))
			entity("liveChannelRun", {
				...row,
				bitmovinAccountId: row.liveChannel.bitmovinAccountId,
			});
		for (const effect of await tx.liveEffectClaim.findMany({
			where: { state: { in: ["CLAIMED", "DISPATCHING", "AMBIGUOUS"] } },
			select: {
				id: true,
				token: true,
				state: true,
				attempt: true,
				providerEncodingId: true,
				liveChannel: { select: { bitmovinAccountId: true } },
			},
		})) {
			const entityKey = `liveEffectClaim:${effect.id}`;
			const accountId = effect.liveChannel.bitmovinAccountId;
			entityKeys.push(entityKey);
			if (accountId) accountIds.add(accountId);
			payload.pendingEntities.push({
				entityKey,
				accountId,
				status: effect.state,
				ownerToken: effect.token,
			});
			if (effect.attempt > 1 || effect.state === "AMBIGUOUS")
				payload.pendingEntities.push({
					entityKey,
					accountId,
					status: "UNCONFIRMED_PRIOR_OWNER",
					ownerToken: "unconfirmed-prior-owner",
				});
			payload.encodings.push({
				entityKey,
				accountId,
				encodingId: effect.providerEncodingId,
			});
		}
	}
	if (
		selected.has("webhookRegistrations") ||
		selected.has("applicationSettings")
	) {
		const rows = await tx.webhookRegistration.findMany({
			where: {
				OR: [{ status: { not: "DELETED" } }, { claimedUntil: { not: null } }],
			},
		});
		for (const row of rows) {
			entityKeys.push(`webhookRegistration:${row.id}`);
			accountIds.add(row.bitmovinAccountId);
			payload.webhooks.push({
				id: row.id,
				scope: row.scope,
				encodingId: row.encodingId,
				accountId: row.bitmovinAccountId,
				kind: row.kind,
				providerWebhookId: row.providerWebhookId,
				url: row.url,
				tokenHash: row.tokenHash,
				configuration: row.configuration,
				status: row.status,
				claimedUntil: row.claimedUntil?.toISOString() ?? null,
			});
			if (row.claimedUntil) {
				payload.pendingEntities.push({
					entityKey: `webhookRegistration:${row.id}`,
					accountId: row.bitmovinAccountId,
					status: row.status,
					ownerToken: row.claimedUntil.toISOString(),
				});
				// Registrations also replace expired claims without an outstanding
				// attempt ledger. Preserve recovery credentials until uncertainty closes.
				payload.pendingEntities.push({
					entityKey: `webhookRegistration:${row.id}`,
					accountId: row.bitmovinAccountId,
					status: "UNCONFIRMED_PRIOR_OWNER",
					ownerToken: "unconfirmed-prior-owner",
				});
			}
		}
	}
	if (selected.has("verificationHistory")) {
		const runs = await tx.verificationRun.findMany({
			select: {
				id: true,
				status: true,
				recoveryLeaseUntil: true,
				bitmovinAccountId: true,
			},
		});
		for (const row of runs) entity("verificationRun", row);
		const rows = await tx.verificationResourceIntent.findMany({
			include: { verificationRun: { select: { bitmovinAccountId: true } } },
		});
		// An intent can learn provider IDs before local adoption. Protect retained
		// owners by canonical local key, verification key, and exact encoder refs.
		const [jobs, channels, runsWithOwners] = await Promise.all([
			selected.has("vodJobs")
				? []
				: tx.encodingJob.findMany({
						select: {
							id: true,
							verificationKey: true,
							bitmovinEncodingId: true,
							bitmovinAccountId: true,
							stepLog: true,
						},
					}),
			selected.has("liveChannels")
				? []
				: tx.liveChannel.findMany({
						select: {
							id: true,
							verificationKey: true,
							bitmovinEncodingId: true,
							bitmovinAccountId: true,
							stepLog: true,
						},
					}),
			selected.has("liveChannels")
				? []
				: tx.liveChannelRun.findMany({
						select: {
							id: true,
							bitmovinEncodingId: true,
							stepLog: true,
							liveChannel: { select: { bitmovinAccountId: true } },
						},
					}),
		]);
		const retained = [
			...jobs.map((row) => ({ ...row, kind: "VOD_JOB" })),
			...channels.map((row) => ({ ...row, kind: "LIVE_CHANNEL" })),
			...runsWithOwners.map((row) => ({
				...row,
				kind: "LIVE_RUN",
				verificationKey: null,
				bitmovinAccountId: row.liveChannel.bitmovinAccountId,
			})),
		];
		const stepEncodingIds = (stepLog: Prisma.JsonValue | undefined) =>
			Array.isArray(stepLog)
				? stepLog.flatMap((step) =>
						step &&
						typeof step === "object" &&
						!Array.isArray(step) &&
						step.kind === "CREATE_ENCODING" &&
						typeof step.resourceId === "string"
							? [step.resourceId]
							: [],
					)
				: [];
		for (const intent of rows) {
			const accountId = intent.verificationRun.bitmovinAccountId;
			if (!accountId) continue;
			const kind =
				intent.kind === "VOD_JOB"
					? "encodingJob"
					: intent.kind === "LIVE_CHANNEL"
						? "liveChannel"
						: null;
			if (!kind) continue;
			const localPrefix = `local:${intent.kind}:`;
			const localIds = new Set([
				...(intent.localId ? [intent.localId] : []),
				...(intent.possiblyCreatedKeys ?? [])
					.filter(
						(key) =>
							key.startsWith(localPrefix) && key.length > localPrefix.length,
					)
					.map((key) => key.slice(localPrefix.length)),
			]);
			if (
				retained.some(
					(row) =>
						row.kind === intent.kind &&
						(localIds.has(row.id) ||
							(typeof intent.verificationKey === "string" &&
								row.verificationKey === intent.verificationKey)),
				)
			)
				continue;
			const providerPrefix = "provider:BITMOVIN_ENCODING:";
			const providerIds = new Set([
				...intent.providerIds,
				...(intent.providerId ? [intent.providerId] : []),
				...(intent.possiblyCreatedKeys ?? [])
					.filter(
						(key) =>
							key.startsWith(providerPrefix) &&
							key.length > providerPrefix.length,
					)
					.map((key) => key.slice(providerPrefix.length)),
			]);
			const localId =
				intent.localId ?? (localIds.size === 1 ? [...localIds][0] : undefined);
			const entityKey = `${kind}:${localId ?? `verification-intent:${intent.id}`}`;
			for (const encodingId of providerIds) {
				if (
					retained.some(
						(row) =>
							(row.bitmovinAccountId == null ||
								row.bitmovinAccountId === accountId) &&
							(row.bitmovinEncodingId === encodingId ||
								stepEncodingIds(row.stepLog).includes(encodingId)),
					)
				)
					continue;
				entityKeys.push(entityKey);
				accountIds.add(accountId);
				payload.encodings.push({ entityKey, accountId, encodingId });
			}
		}
		payload.verificationIntents = JSON.parse(
			JSON.stringify(rows),
		) as Prisma.JsonObject[];
	}
	if (!entityKeys.length && !payload.verificationIntents.length) return null;
	payload.accounts = await tx.bitmovinAccount.findMany({
		where: { id: { in: [...accountIds] } },
		select: { id: true, encryptedApiKey: true, tenantOrgId: true },
	});
	return createResetCleanupTask(tx, cipher, payload, entityKeys);
}
