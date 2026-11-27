import "server-only";
import { randomUUID } from "node:crypto";
import type { AppTransactionClient } from "@bitovp/db";
import {
	type CheckNativeCodec,
	type CreateNativeCodec,
	type DeleteNativeCodec,
	type NativeCodecReceipt,
	type NativeCodecState,
	nativeCodecKind,
} from "../native-codec-configurations";
import type { ServerContext } from "./context";

type Scope = Pick<CheckNativeCodec, "bitmovinAccountId" | "scopeVersion">;
type Journal = Pick<AppTransactionClient, "nativeCodecConfiguration">;
type Row = NonNullable<Awaited<ReturnType<typeof findCodecReceipt>>>;
const DELETE_LEASE_MS = 60_000;

export class CodecJournalError extends Error {
	constructor(
		readonly status: 404 | 409 | 410,
		message: string,
	) {
		super(message);
	}
}

function findCodecReceipt(db: Journal, id: string) {
	return db.nativeCodecConfiguration.findFirst({ where: { id } });
}

type CodecRecord = Omit<Row, "codec"> & {
	codec: NativeCodecReceipt["codec"];
};

function validatedRecord(row: Row): CodecRecord {
	return { ...row, codec: nativeCodecKind.parse(row.codec) };
}

async function lockScope(tx: AppTransactionClient, scope: Scope) {
	const binding = await tx.$queryRaw<{ id: string }[]>`
		SELECT id FROM "BitmovinAccount"
		WHERE id = ${scope.bitmovinAccountId}::uuid
		AND "resourceScopeVersion" = ${scope.scopeVersion}::uuid
		FOR SHARE
	`;
	if (binding.length !== 1)
		throw new CodecJournalError(
			409,
			"The provider account scope changed. Refresh the account.",
		);
}

function requireRecord(row: Row | null, scope: Scope) {
	if (!row || row.bitmovinAccountId !== scope.bitmovinAccountId)
		throw new CodecJournalError(404, "Codec configuration receipt not found.");
	if (row.scopeVersion !== scope.scopeVersion)
		throw new CodecJournalError(
			409,
			"This receipt belongs to an earlier provider account scope.",
		);
	return validatedRecord(row);
}

export function codecReceipt(
	row: Row,
	activeScopeVersion: string,
): NativeCodecReceipt {
	return {
		id: row.id,
		name: row.name,
		codec: nativeCodecKind.parse(row.codec),
		state: row.state as NativeCodecState,
		providerId: row.providerId,
		canAct: row.scopeVersion === activeScopeVersion,
		canRetryDelete:
			row.scopeVersion === activeScopeVersion &&
			row.state === "DELETING" &&
			Date.now() - row.updatedAt.getTime() >= DELETE_LEASE_MS,
	};
}

export function claimCodecCreate(
	prisma: ServerContext["prisma"],
	body: CreateNativeCodec,
	id: string,
	requestSha256: string,
) {
	return prisma.$transaction(async (tx) => {
		await lockScope(tx, body);
		const claim = await tx.nativeCodecConfiguration.createMany({
			data: {
				id,
				bitmovinAccountId: body.bitmovinAccountId,
				scopeVersion: body.scopeVersion,
				codec: body.codec,
				name: body.name,
				requestSha256,
				ownerToken: randomUUID(),
				state: "CREATING",
			},
			skipDuplicates: true,
		});
		const record = requireRecord(await findCodecReceipt(tx, id), body);
		if (record.requestSha256 !== requestSha256)
			throw new CodecJournalError(
				409,
				"This idempotency key already belongs to another request.",
			);
		if (record.state === "REMOVED")
			throw new CodecJournalError(
				410,
				"The configuration created by this key was removed.",
			);
		return { send: claim.count === 1, record };
	});
}

export function readCodecReceipt(
	prisma: ServerContext["prisma"],
	command: CheckNativeCodec,
) {
	return prisma.$transaction(async (tx) => {
		await lockScope(tx, command);
		return requireRecord(await findCodecReceipt(tx, command.id), command);
	});
}

export function claimCodecDelete(
	prisma: ServerContext["prisma"],
	command: DeleteNativeCodec,
) {
	return prisma.$transaction(async (tx) => {
		await lockScope(tx, command);
		await tx.$queryRaw`
			SELECT id FROM "NativeCodecConfiguration"
			WHERE id = ${command.id}::uuid FOR UPDATE
		`;
		const record = requireRecord(
			await findCodecReceipt(tx, command.id),
			command,
		);
		if (record.providerId !== command.confirmProviderId)
			throw new CodecJournalError(
				409,
				"Confirm the exact provider configuration ID.",
			);
		if (record.state === "REMOVED") return { send: false as const, record };
		const retry = record.state === "DELETING";
		if (retry && Date.now() - record.updatedAt.getTime() < DELETE_LEASE_MS)
			return { send: false as const, record };
		if (!retry && record.state !== "ACTIVE")
			throw new CodecJournalError(
				409,
				"Check creation status before removing the configuration.",
			);
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
		if (claim.count !== 1)
			throw new CodecJournalError(
				409,
				"The removal receipt changed. Refresh it.",
			);
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
	if (!record.deleteToken)
		throw new CodecJournalError(409, "The removal receipt is missing.");
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
