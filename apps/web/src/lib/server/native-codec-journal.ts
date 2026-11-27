import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { type AppTransactionClient, DB_NULL } from "@bitovp/db";
import {
	type CheckNativeCodec,
	type CreateNativeCodec,
	createNativeCodecSchema,
	type DeleteNativeCodec,
	type NativeCodecReceipt,
	type NativeCodecState,
	nativeCodecKind,
} from "../native-codec-configurations";
import type { ServerContext } from "./context";

type Scope = Pick<CheckNativeCodec, "bitmovinAccountId" | "scopeVersion">;
type AccountScope = Scope & { providerScopeIdentity: string };
type Journal = Pick<AppTransactionClient, "nativeCodecConfiguration">;
type Row = NonNullable<Awaited<ReturnType<typeof findCodecReceipt>>>;
const DELETE_LEASE_MS = 60_000;

const codecJournalErrors = {
	accountMissing: [404, "Bitmovin account not found."],
	accountChanged: [
		409,
		"The provider account scope changed. Refresh the account.",
	],
	accountTenantMissing: [
		409,
		"Enter the Bitmovin organization ID or clear it to use the default organization.",
	],
	receiptMissing: [404, "Codec configuration receipt not found."],
	receiptScopeChanged: [
		409,
		"This receipt belongs to an earlier provider account scope.",
	],
	keyAlreadyUsed: [
		409,
		"This idempotency key already belongs to another request.",
	],
	keyRemoved: [410, "The configuration created by this key was removed."],
	confirmationMismatch: [409, "Confirm the exact provider configuration ID."],
	creationPending: [
		409,
		"Check creation status before removing the configuration.",
	],
	creationChanged: [409, "The creation receipt changed. Refresh it."],
	removalChanged: [409, "The removal receipt changed. Refresh it."],
	removalMissing: [409, "The removal receipt is missing."],
} as const;

export class CodecJournalError extends Error {
	readonly status: 404 | 409 | 410;
	readonly publicMessage: string;

	constructor(reason: keyof typeof codecJournalErrors) {
		const [status, publicMessage] = codecJournalErrors[reason];
		super(publicMessage);
		this.status = status;
		this.publicMessage = publicMessage;
	}
}

function findCodecReceipt(db: Journal, id: string) {
	return db.nativeCodecConfiguration.findFirst({ where: { id } });
}

type CodecRecord = Omit<Row, "codec"> & {
	codec: NativeCodecReceipt["codec"];
};

export function normalizeCodecTenantOrgId(value: string | null) {
	if (value === null) return null;
	const tenantOrgId = value.trim();
	// Only a stored null tracks credential rotation as a default organization.
	if (!tenantOrgId) throw new CodecJournalError("accountTenantMissing");
	return tenantOrgId;
}

function validatedRecord(row: Row): CodecRecord {
	return { ...row, codec: nativeCodecKind.parse(row.codec) };
}

async function lockScope(tx: AppTransactionClient, scope: Scope) {
	// A restored explicit tenant keeps the same provider identity. With the
	// provider default, require the original stored credential revision.
	const [binding] = await tx.$queryRaw<
		{ tenantOrgId: string | null; credentialIdentity: string }[]
	>`
		SELECT "tenantOrgId",
			encode(sha256(convert_to('credential:' || "encryptedApiKey", 'UTF8')), 'hex')
			AS "credentialIdentity"
		FROM "BitmovinAccount"
		WHERE id = ${scope.bitmovinAccountId}::uuid
		AND "resourceScopeVersion" = ${scope.scopeVersion}::uuid
		FOR SHARE
	`;
	if (!binding) throw new CodecJournalError("accountChanged");
	const tenantOrgId = normalizeCodecTenantOrgId(binding.tenantOrgId);
	const providerScopeIdentity = tenantOrgId
		? createHash("sha256").update(`tenant:${tenantOrgId}`, "utf8").digest("hex")
		: binding.credentialIdentity;
	return { ...scope, providerScopeIdentity };
}

function requireRecord(row: Row | null, scope: AccountScope) {
	if (!row || row.bitmovinAccountId !== scope.bitmovinAccountId)
		throw new CodecJournalError("receiptMissing");
	if (row.providerScopeIdentity !== scope.providerScopeIdentity)
		throw new CodecJournalError("receiptScopeChanged");
	return validatedRecord(row);
}

async function lockReceipt(
	tx: AppTransactionClient,
	command: CheckNativeCodec,
) {
	const scope = await lockScope(tx, command);
	await tx.$queryRaw`
		SELECT id FROM "NativeCodecConfiguration"
		WHERE id = ${command.id}::uuid FOR UPDATE
	`;
	return requireRecord(await findCodecReceipt(tx, command.id), scope);
}

export function codecReceipt(row: Row, canAct = true): NativeCodecReceipt {
	return {
		id: row.id,
		name: row.name,
		codec: nativeCodecKind.parse(row.codec),
		state: row.state as NativeCodecState,
		providerId: row.providerId,
		canAct,
		canResumeCreate:
			canAct && row.state === "CREATING" && row.pendingCreateRequest !== null,
		canRetryDelete:
			canAct &&
			row.state === "DELETING" &&
			Date.now() - row.updatedAt.getTime() >= DELETE_LEASE_MS,
	};
}

export function listCodecReceipts(
	prisma: ServerContext["prisma"],
	command: Scope,
	offset: number,
	limit: number,
) {
	return prisma.$transaction(async (tx) => {
		const scope = await lockScope(tx, command);
		const rows = await tx.nativeCodecConfiguration.findMany({
			where: { bitmovinAccountId: scope.bitmovinAccountId },
			orderBy: [{ createdAt: "desc" }, { id: "desc" }],
			skip: offset,
			take: limit + 1,
		});
		return {
			rows: rows
				.slice(0, limit)
				.map((row) =>
					codecReceipt(
						row,
						row.providerScopeIdentity === scope.providerScopeIdentity,
					),
				),
			hasMore: rows.length > limit,
			scopeVersion: scope.scopeVersion,
		};
	});
}

export function reserveCodecCreate(
	prisma: ServerContext["prisma"],
	body: CreateNativeCodec,
	id: string,
	requestSha256: string,
) {
	return prisma.$transaction(async (tx) => {
		const scope = await lockScope(tx, body);
		await tx.nativeCodecConfiguration.createMany({
			data: {
				id,
				bitmovinAccountId: body.bitmovinAccountId,
				scopeVersion: body.scopeVersion,
				providerScopeIdentity: scope.providerScopeIdentity,
				codec: body.codec,
				name: body.name,
				requestSha256,
				pendingCreateRequest: body,
				ownerToken: randomUUID(),
				state: "CREATING",
			},
			skipDuplicates: true,
		});
		const record = requireRecord(await findCodecReceipt(tx, id), scope);
		if (record.requestSha256 !== requestSha256)
			throw new CodecJournalError("keyAlreadyUsed");
		if (record.state === "REMOVED") throw new CodecJournalError("keyRemoved");
	});
}

export function claimCodecCreate(
	prisma: ServerContext["prisma"],
	command: CheckNativeCodec,
) {
	return prisma.$transaction(async (tx) => {
		const record = await lockReceipt(tx, command);
		if (record.state === "REMOVED") throw new CodecJournalError("keyRemoved");
		if (record.state !== "CREATING" || record.pendingCreateRequest === null)
			return { send: false as const, record };
		const body = createNativeCodecSchema.parse(record.pendingCreateRequest);
		if (
			body.bitmovinAccountId !== record.bitmovinAccountId ||
			body.scopeVersion !== record.scopeVersion ||
			body.codec !== record.codec ||
			body.name !== record.name
		)
			throw new CodecJournalError("creationChanged");
		// Clearing the stored request consumes the only permission to send.
		// From this point a lost result is resolved by lookup, including when
		// the connection drops before the provider can confirm receipt.
		const consumed = await tx.nativeCodecConfiguration.updateMany({
			where: { id: record.id, state: "CREATING" },
			data: { pendingCreateRequest: DB_NULL },
		});
		if (consumed.count !== 1) throw new CodecJournalError("creationChanged");
		return {
			send: true as const,
			record: { ...record, pendingCreateRequest: null },
			body,
		};
	});
}

export function readCodecReceipt(
	prisma: ServerContext["prisma"],
	command: CheckNativeCodec,
) {
	return prisma.$transaction(async (tx) => {
		const scope = await lockScope(tx, command);
		return requireRecord(await findCodecReceipt(tx, command.id), scope);
	});
}

export function claimCodecDelete(
	prisma: ServerContext["prisma"],
	command: DeleteNativeCodec,
) {
	return prisma.$transaction(async (tx) => {
		const record = await lockReceipt(tx, command);
		if (record.providerId !== command.confirmProviderId)
			throw new CodecJournalError("confirmationMismatch");
		if (record.state === "REMOVED") return { send: false as const, record };
		const retry = record.state === "DELETING";
		if (retry && Date.now() - record.updatedAt.getTime() < DELETE_LEASE_MS)
			return { send: false as const, record };
		if (!retry && record.state !== "ACTIVE")
			throw new CodecJournalError("creationPending");
		const deleteToken = randomUUID();
		const where = {
			id: record.id,
			bitmovinAccountId: record.bitmovinAccountId,
			scopeVersion: record.scopeVersion,
			providerId: command.confirmProviderId,
			state: record.state,
			deleteToken: record.deleteToken,
		};
		const claim = await tx.nativeCodecConfiguration.updateMany({
			where,
			data: { state: "DELETING", deleteToken },
		});
		if (claim.count !== 1) throw new CodecJournalError("removalChanged");
		return {
			send: true as const,
			retry,
			record: {
				...record,
				state: "DELETING",
				deleteToken,
				providerId: command.confirmProviderId,
			},
		};
	});
}

export async function finishCodecCreate(
	prisma: ServerContext["prisma"],
	record: CodecRecord,
	providerId: string | null,
) {
	return prisma.$transaction(async (tx) => {
		// Store the provider result in the original receipt even if the account
		// was reconfigured mid-request. A later mutation still checks its scope.
		await tx.nativeCodecConfiguration.updateMany({
			where: {
				id: record.id,
				ownerToken: record.ownerToken,
				state: "CREATING",
				pendingCreateRequest: { equals: DB_NULL },
			},
			data: providerId
				? { state: "ACTIVE", providerId }
				: { state: "REJECTED" },
		});
		return requireRecord(await findCodecReceipt(tx, record.id), record);
	});
}

export async function finishCodecDelete(
	prisma: ServerContext["prisma"],
	record: CodecRecord,
	state: "ACTIVE" | "REMOVED",
) {
	if (!record.deleteToken) throw new CodecJournalError("removalMissing");
	return prisma.$transaction(async (tx) => {
		await tx.nativeCodecConfiguration.updateMany({
			where: {
				id: record.id,
				state: "DELETING",
				deleteToken: record.deleteToken,
			},
			data: { state, deleteToken: null },
		});
		return requireRecord(await findCodecReceipt(tx, record.id), record);
	});
}
