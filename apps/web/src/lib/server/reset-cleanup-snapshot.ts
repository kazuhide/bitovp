import type { SecretCipher } from "@bitovp/core";
import {
	type AppTransactionClient,
	createResetCleanupTask,
	liveChannelAccountId,
	type Prisma,
	type ResetCleanupPayload,
	readVerificationCleanupWork,
} from "@bitovp/db";
import type { ResetCategory } from "@/lib/reset-selection";
import {
	IncompleteRtmpArchive,
	readResetRtmpArchives,
} from "./reset-rtmp-archives";

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
	const ownerSince = new Map<string, Date>();
	const accountIds = new Set<string>();
	const requireTerminal = new Set<string>();
	let neverStarted = new Set<string>();
	function entity(
		kind: string,
		row: {
			id: string;
			createdAt?: Date;
			status: string;
			bitmovinAccountId: string | null;
			bitmovinEncodingId?: string | null;
			stepLog?: Prisma.JsonValue;
			previousProviderEncodingIds?: string[];
			attemptClaimedAt?: Date | null;
			provisionClaimedAt?: Date | null;
			recoveryLeaseUntil?: Date | null;
		},
	) {
		const entityKey = `${kind}:${row.id}`;
		if (row.createdAt) ownerSince.set(entityKey, row.createdAt);
		entityKeys.push(entityKey);
		if (row.bitmovinAccountId) accountIds.add(row.bitmovinAccountId);
		const ids = new Set(row.previousProviderEncodingIds ?? []);
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
				...(neverStarted.has(
					JSON.stringify([kind, row.id, row.bitmovinAccountId, encodingId]),
				)
					? { allowCreated: true as const }
					: {}),
				...(requireTerminal.has(`${row.bitmovinAccountId}:${encodingId}`)
					? { requireTerminal: true }
					: {}),
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
				createdAt: true,
				bitmovinAccountId: true,
				bitmovinEncodingId: true,
				stepLog: true,
			},
		}))
			entity("encodingJob", row);
	if (selected.has("liveChannels")) {
		const archive = await readResetRtmpArchives(tx);
		if (archive.incomplete.length) throw new IncompleteRtmpArchive();
		neverStarted = archive.neverStarted;
		for (const pointer of archive.pointers)
			requireTerminal.add(
				`${pointer.bitmovinAccountId}:${pointer.bitmovinEncodingId}`,
			);
		for (const row of await tx.liveChannel.findMany({
			select: {
				id: true,
				status: true,
				provisionClaimedAt: true,
				createdAt: true,
				bitmovinAccountId: true,
				bitmovinEncodingId: true,
				stepLog: true,
				plan: true,
			},
		}))
			entity("liveChannel", {
				...row,
				bitmovinAccountId: liveChannelAccountId(row),
			});
		for (const row of await tx.liveChannelRun.findMany({
			select: {
				id: true,
				status: true,
				bitmovinEncodingId: true,
				stepLog: true,
				previousProviderEncodingIds: true,
				liveChannel: {
					select: { bitmovinAccountId: true, plan: true, createdAt: true },
				},
			},
		}))
			entity("liveChannelRun", {
				...row,
				createdAt: row.liveChannel.createdAt,
				bitmovinAccountId: liveChannelAccountId(row.liveChannel),
			});
		const recorded = new Set(
			payload.encodings.map((e) =>
				JSON.stringify([e.entityKey, e.accountId, e.encodingId]),
			),
		);
		for (const p of archive.pointers) {
			const entityKey = `${p.kind}:${p.id}`;
			if (
				!recorded.has(
					JSON.stringify([
						entityKey,
						p.bitmovinAccountId,
						p.bitmovinEncodingId,
					]),
				)
			)
				payload.encodings.push({
					entityKey,
					accountId: p.bitmovinAccountId,
					encodingId: p.bitmovinEncodingId,
					requireTerminal: true,
				});
		}
		for (const effect of await tx.liveEffectClaim.findMany({
			where: { state: { in: ["CLAIMED", "DISPATCHING", "AMBIGUOUS"] } },
			select: {
				id: true,
				token: true,
				state: true,
				attempt: true,
				providerEncodingId: true,
				liveChannel: { select: { bitmovinAccountId: true, plan: true } },
			},
		})) {
			const entityKey = `liveEffectClaim:${effect.id}`;
			const accountId = liveChannelAccountId(effect.liveChannel);
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
		const work = await readVerificationCleanupWork(tx, rows, {
			vod: selected.has("vodJobs"),
			live: selected.has("liveChannels"),
		});
		for (const candidate of work.candidates) {
			entityKeys.push(candidate.entityKey);
			if (candidate.accountId) accountIds.add(candidate.accountId);
			payload.encodings.push(candidate);
		}
		payload.verificationWorklistMaterialized = true;
		payload.verificationIntents = JSON.parse(
			JSON.stringify(rows),
		) as Prisma.JsonObject[];
	}
	if (!entityKeys.length && !payload.verificationIntents.length) return null;
	const accounts = await tx.bitmovinAccount.findMany({
		where: { id: { in: [...accountIds] } },
		select: {
			id: true,
			encryptedApiKey: true,
			tenantOrgId: true,
			updatedAt: true,
		},
	});
	const versions = new Map(accounts.map((a) => [a.id, a.updatedAt]));
	for (const pointer of payload.encodings) {
		const version = pointer.accountId && versions.get(pointer.accountId);
		const origin = ownerSince.get(pointer.entityKey);
		if (version && origin && version < origin)
			pointer.allowVerifiedMissing = true;
	}
	payload.accounts = accounts.map(
		({ updatedAt: _updatedAt, ...account }) => account,
	);
	return createResetCleanupTask(tx, cipher, payload, entityKeys);
}
