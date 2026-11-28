import "server-only";

import {
	NATIVE_OPERATION_KEY_CONFLICT,
	type NativeOperationAction,
	type NativeOperationOutcome,
	type NativeOperationTarget,
} from "@/lib/native-account-operations";
import type { ServerContext } from "./context";

type Prisma = ServerContext["prisma"];
type Proposal = NativeOperationTarget & {
	id: string;
	action: NativeOperationAction;
	fingerprint: string;
	targetId: string | null;
};
export type NativeOperationRow = NonNullable<
	Awaited<ReturnType<typeof getNativeOperation>>
>;
const pendingWindowMs = 60_000;

export class NativeOperationConflict extends Error {
	constructor(
		message: string,
		readonly code?: typeof NATIVE_OPERATION_KEY_CONFLICT,
	) {
		super(message);
	}
}

export function nativeOperationExpired(row: NativeOperationRow) {
	return Date.now() >= row.createdAt.getTime() + pendingWindowMs;
}

export function getNativeOperation(prisma: Prisma, id: string) {
	return prisma.nativeEncodingOperation.findFirst({ where: { id } });
}

export function listNativeOperations(
	prisma: Prisma,
	target: NativeOperationTarget,
) {
	return prisma.nativeEncodingOperation.findMany({
		where: target,
		orderBy: [{ createdAt: "desc" }, { id: "desc" }],
		take: 25,
	});
}

export async function ownsNativeResource(
	prisma: Prisma,
	target: NativeOperationTarget,
	creationAction: string,
	providerId: string,
) {
	return (
		(await prisma.nativeEncodingOperation.count({
			where: {
				bitmovinAccountId: target.bitmovinAccountId,
				scopeVersion: target.scopeVersion,
				action: creationAction,
				state: "ACCEPTED",
				providerId,
			},
		})) > 0
	);
}

export function sameNativeOperation(
	receipt: NativeOperationRow,
	proposal: Proposal,
) {
	return (
		receipt.fingerprint === proposal.fingerprint &&
		receipt.bitmovinAccountId === proposal.bitmovinAccountId &&
		receipt.scopeVersion === proposal.scopeVersion
	);
}

export function claimNativeOperation(prisma: Prisma, proposal: Proposal) {
	return prisma.$transaction(async (tx) => {
		const scope = {
			bitmovinAccountId: proposal.bitmovinAccountId,
			scopeVersion: proposal.scopeVersion,
		};
		const [binding] = await tx.$queryRaw<{ id: string }[]>`
			SELECT id FROM "BitmovinAccount"
			WHERE id = ${scope.bitmovinAccountId}::uuid
			AND "resourceScopeVersion" = ${scope.scopeVersion}::uuid
			FOR SHARE
		`;
		if (!binding)
			throw new NativeOperationConflict("The account changed. Refresh it.");

		if (proposal.targetId) {
			// A crashed dispatch is indeterminate. Release the target lock only
			// after its bounded provider request window elapsed, never replay it.
			await tx.$executeRaw`
				UPDATE "NativeEncodingOperation"
				SET "state" = 'UNKNOWN', "updatedAt" = clock_timestamp()
				WHERE "bitmovinAccountId" = ${scope.bitmovinAccountId}::uuid
				  AND "scopeVersion" = ${scope.scopeVersion}::uuid
				  AND "targetId" = ${proposal.targetId}::uuid
				  AND "state" = 'PENDING'
				  AND "createdAt" + (${pendingWindowMs}::double precision * interval '1 millisecond')
					<= clock_timestamp()
			`;
		}
		const inserted = await tx.nativeEncodingOperation.createMany({
			data: { ...proposal, state: "PENDING" },
			skipDuplicates: true,
		});
		const row = await tx.nativeEncodingOperation.findFirst({
			where: { id: proposal.id },
		});
		if (!row)
			throw new NativeOperationConflict(
				"An operation is already running for this resource.",
			);
		if (!sameNativeOperation(row, proposal))
			throw new NativeOperationConflict(
				"This request already identifies a different operation.",
				NATIVE_OPERATION_KEY_CONFLICT,
			);
		return { row, send: inserted.count === 1 };
	});
}

/** Read the remaining dispatch window from the same DB clock that reaps claims. */
export async function nativeOperationDispatchBudget(
	prisma: Prisma,
	claim: NativeOperationRow,
) {
	const [row] = await prisma.$queryRaw<{ remainingMs: number }[]>`
		SELECT (EXTRACT(EPOCH FROM (
			o."createdAt" + (${pendingWindowMs}::double precision * interval '1 millisecond')
			- clock_timestamp()
		)) * 1000)::double precision AS "remainingMs"
		FROM "NativeEncodingOperation" o
		JOIN "BitmovinAccount" a
		  ON a."id" = o."bitmovinAccountId"
		 AND a."organizationId" = o."organizationId"
		 AND a."resourceScopeVersion" = o."scopeVersion"
		WHERE o."id" = ${claim.id}::uuid
		  AND o."bitmovinAccountId" = ${claim.bitmovinAccountId}::uuid
		  AND o."scopeVersion" = ${claim.scopeVersion}::uuid
		  AND o."state" = 'PENDING'
		  AND o."fingerprint" = ${claim.fingerprint}
	`;
	return row && row.remainingMs > 0 ? row.remainingMs : null;
}

export async function settleNativeOperation(
	prisma: Prisma,
	row: NativeOperationRow,
	outcome: NativeOperationOutcome,
) {
	const { count } = await prisma.nativeEncodingOperation.updateMany({
		where: { id: row.id, fingerprint: row.fingerprint, state: "PENDING" },
		data: {
			state: outcome.state,
			providerId: outcome.providerId,
			passed: outcome.passed,
		},
	});
	if (count !== 1)
		throw new NativeOperationConflict("The receipt changed. Check its status.");
	return { ...row, ...outcome };
}

export function projectNativeOperation(row: NativeOperationRow) {
	return {
		id: row.id,
		action: row.action,
		targetId: row.targetId,
		state:
			row.state === "PENDING" && nativeOperationExpired(row)
				? "UNKNOWN"
				: row.state,
		providerId: row.providerId,
		passed: row.passed,
		createdAt: row.createdAt.toISOString(),
	};
}
