import { randomUUID } from "node:crypto";
import type { SecretCipher } from "@bitovp/core";
import type { Prisma } from "../generated/client";
import type { AppPrismaClient, AppTransactionClient } from "./client";
import { DEFAULT_ORGANIZATION_ID, tenantOrganizationId } from "./tenant-client";

export type ResetCleanupAccount = {
	id: string;
	encryptedApiKey: string;
	tenantOrgId: string | null;
};
export type ResetCleanupEncoding = {
	entityKey: string;
	encodingId: string;
	accountId: string | null;
};
export type ResetCleanupWebhook = {
	id: string;
	scope: string;
	encodingId: string;
	accountId: string;
	kind: string;
	providerWebhookId: string | null;
	providerWebhookIds?: string[];
	url: string | null;
	tokenHash: string | null;
	configuration: Prisma.JsonValue;
	status: string;
	claimedUntil: string | null;
};
export type ResetCleanupPayload = {
	v: 1;
	organizationId?: string;
	accounts: ResetCleanupAccount[];
	encodings: ResetCleanupEncoding[];
	webhooks: ResetCleanupWebhook[];
	verificationIntents: Prisma.JsonObject[];
	pendingEntities: {
		entityKey: string;
		accountId: string | null;
		status: string;
		ownerToken?: string;
	}[];
};
type Client = AppPrismaClient | AppTransactionClient;
const aad = (id: string, organizationId?: string) =>
	`reset-cleanup:${id}${organizationId ? `:org:${organizationId}` : ""}`;

/** Called in the same transaction that deletes the original ownership rows. */
export async function createResetCleanupTask(
	prisma: Client,
	cipher: SecretCipher,
	payload: ResetCleanupPayload,
	entityKeys: string[] = payload.pendingEntities.map(
		(entry) => entry.entityKey,
	),
) {
	const id = randomUUID();
	const organizationId = tenantOrganizationId(prisma);
	if (organizationId) {
		if (payload.organizationId && payload.organizationId !== organizationId)
			throw new Error("Reset cleanup organization does not match its owner");
		const accountIds = [
			...new Set(payload.accounts.map((account) => account.id)),
		];
		const accounts = accountIds.length
			? await prisma.bitmovinAccount.findMany({
					where: { id: { in: accountIds } },
					select: { id: true },
				})
			: [];
		if (accounts.length !== accountIds.length)
			throw new Error(
				"Reset cleanup contains an account outside its organization",
			);
	}
	const owned = organizationId ? { ...payload, organizationId } : payload;
	await prisma.resetCleanupTask.create({
		data: {
			id,
			entityKeys: [...new Set(entityKeys)],
			encryptedPayload: await cipher.encrypt(
				JSON.stringify(owned),
				aad(id, organizationId),
			),
		},
	});
	return id;
}

export async function readResetCleanupTask(
	prisma: Client,
	cipher: SecretCipher,
	id: string,
) {
	const row = await prisma.resetCleanupTask.findUnique({
		where: { id },
		select: {
			id: true,
			organizationId: true,
			revision: true,
			encryptedPayload: true,
		},
	});
	if (!row) return null;
	const organizationId = tenantOrganizationId(prisma) ?? row.organizationId;
	if (
		row.organizationId &&
		organizationId &&
		row.organizationId !== organizationId
	)
		throw new Error("Reset cleanup ownership does not match its context");
	let plaintext: string;
	try {
		plaintext = await cipher.decrypt(
			row.encryptedPayload,
			aad(id, organizationId),
		);
	} catch (error) {
		if (organizationId && organizationId !== DEFAULT_ORGANIZATION_ID)
			throw error;
		plaintext = await cipher.decrypt(row.encryptedPayload, aad(id));
	}
	const payload = JSON.parse(plaintext) as ResetCleanupPayload;
	if (payload.v !== 1) throw new Error("Unsupported reset cleanup payload");
	if (payload.organizationId && payload.organizationId !== organizationId)
		throw new Error("Reset cleanup payload belongs to another organization");
	if (
		!payload.organizationId &&
		organizationId &&
		organizationId !== DEFAULT_ORGANIZATION_ID
	)
		throw new Error("Legacy cleanup belongs only to the default organization");
	if (organizationId) payload.organizationId = organizationId;
	return { id: row.id, revision: row.revision, payload };
}

/** Optimistic revision protects late SDK results from a concurrent sweep. */
export async function mutateResetCleanupTask(
	prisma: Client,
	cipher: SecretCipher,
	id: string,
	mutate: (payload: ResetCleanupPayload) => void,
	expectedRevision?: number,
) {
	for (let attempt = 0; attempt < 12; attempt++) {
		const row = await readResetCleanupTask(prisma, cipher, id);
		if (!row) return false;
		if (expectedRevision !== undefined && row.revision !== expectedRevision)
			return false;
		const owner = row.payload.organizationId;
		mutate(row.payload);
		if (row.payload.organizationId !== owner)
			throw new Error("Reset cleanup ownership is immutable");
		const result = await prisma.resetCleanupTask.updateMany({
			where: { id, revision: row.revision },
			data: {
				encryptedPayload: await cipher.encrypt(
					JSON.stringify(row.payload),
					aad(id, row.payload.organizationId),
				),
				revision: { increment: 1 },
				settledAt: null,
				nextAttemptAt: new Date(),
			},
		});
		if (result.count === 1) return true;
		if (expectedRevision !== undefined) return false;
	}
	throw new Error("Reset cleanup ownership changed concurrently");
}

export async function findResetCleanupTaskForEntity(
	prisma: Client,
	entityKey: string,
) {
	// Include settled receipts: a late provider response must reopen ownership.
	return prisma.resetCleanupTask.findFirst({
		where: { entityKeys: { has: entityKey } },
		select: { id: true },
		orderBy: { createdAt: "desc" },
	});
}

export async function appendResetCleanupEncoding(
	prisma: Client,
	cipher: SecretCipher,
	entityKey: string,
	encodingId: string,
	accountId: string | null,
) {
	const task = await findResetCleanupTaskForEntity(prisma, entityKey);
	if (!task) return false;
	return mutateResetCleanupTask(prisma, cipher, task.id, (payload) => {
		if (
			!payload.encodings.some(
				(row) => row.encodingId === encodingId && row.accountId === accountId,
			)
		) {
			payload.encodings.push({ entityKey, encodingId, accountId });
		}
	});
}

/** A completed provider call may outlive the registration row selected for reset. */
export async function recordResetCleanupWebhookResult(
	prisma: Client,
	cipher: SecretCipher,
	registrationId: string,
	providerWebhookId: string | null,
	ownerToken: string,
) {
	const entityKey = `webhookRegistration:${registrationId}`;
	const task = await findResetCleanupTaskForEntity(prisma, entityKey);
	if (!task) return false;
	return mutateResetCleanupTask(prisma, cipher, task.id, (payload) => {
		const hook = payload.webhooks.find((row) => row.id === registrationId);
		if (hook && providerWebhookId) {
			hook.providerWebhookIds = [
				...new Set([
					...(hook.providerWebhookIds ?? []),
					...(hook.providerWebhookId ? [hook.providerWebhookId] : []),
					providerWebhookId,
				]),
			];
			hook.providerWebhookId = providerWebhookId;
		}
		payload.pendingEntities = payload.pendingEntities.filter(
			(row) => row.entityKey !== entityKey || row.ownerToken !== ownerToken,
		);
	});
}

export async function acknowledgeResetCleanupEntity(
	prisma: Client,
	cipher: SecretCipher,
	entityKey: string,
	ownerToken: string | null,
) {
	if (!ownerToken) return false;
	const task = await findResetCleanupTaskForEntity(prisma, entityKey);
	if (!task) return false;
	return mutateResetCleanupTask(prisma, cipher, task.id, (payload) => {
		payload.pendingEntities = payload.pendingEntities.filter(
			(row) => row.entityKey !== entityKey || row.ownerToken !== ownerToken,
		);
	});
}

export async function revealResetCleanupAccount(
	cipher: SecretCipher,
	account: ResetCleanupAccount,
) {
	return {
		apiKey: await cipher.decrypt(
			account.encryptedApiKey,
			`bitmovin-account:${account.id}`,
		),
		tenantOrgId: account.tenantOrgId,
	};
}
