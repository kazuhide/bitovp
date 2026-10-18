import type {
	VerificationDispatchFence,
	VerificationIntentKind,
} from "@bitovp/core";
import type { Prisma } from "@bitovp/db";

type DispatchTransaction = Pick<Prisma.TransactionClient, "$queryRaw">;

type LockedVerificationRun = {
	id: string;
	status: string;
	recoveryGeneration: number;
	recoveryOwner: string | null;
};

type LockedVerificationIntent = {
	id: string;
	verificationRunId: string;
	kind: string;
	verificationKey: string;
	requestSha256: string;
	state: string;
	cleanupState: string;
	recoveryOwner: string | null;
	recoveryGeneration: number;
};

/**
 * Deliberately carries no field values: the dispatch token is a bearer secret
 * and must never reach a response, log, AuditLog row or error tracker.
 */
export class VerificationDispatchFenceError extends Error {
	constructor() {
		super("verification dispatch authority changed; paid create refused");
		this.name = "VerificationDispatchFenceError";
	}
}

function rejectFence(): never {
	throw new VerificationDispatchFenceError();
}

/**
 * Atomically proves that a verification producer still owns this paid create.
 *
 * Recovery locks the VerificationRun before changing any child intent. Taking
 * that same parent lock first gives one total order: either recovery wins and
 * this request refuses, or this request keeps the parent locked until its
 * local resource row has committed. The child lock then binds the unguessable
 * dispatch owner to the exact intent generation, request identity and kind.
 *
 * Lease expiry is intentionally not checked. Expiry merely makes recovery
 * eligible to claim; only a successful recovery claim changes the generations
 * and revokes this producer. This lets an already-arrived POST win safely.
 */
export async function assertVerificationDispatchFence(
	tx: DispatchTransaction,
	input: {
		fence: VerificationDispatchFence;
		kind: VerificationIntentKind;
		verificationKey: string;
		requestSha256: string;
	},
): Promise<void> {
	const runs = await tx.$queryRaw<LockedVerificationRun[]>`
		SELECT "id", "status", "recoveryGeneration", "recoveryOwner"
		FROM "VerificationRun"
		WHERE "id" = ${input.fence.verificationRunId}::uuid
		FOR UPDATE
	`;
	const run = runs[0];
	if (
		!run ||
		run.id !== input.fence.verificationRunId ||
		run.status !== "RUNNING" ||
		run.recoveryGeneration !== input.fence.runGeneration ||
		run.recoveryOwner !== null
	) {
		rejectFence();
	}

	const intents = await tx.$queryRaw<LockedVerificationIntent[]>`
		SELECT "id", "verificationRunId", "kind", "verificationKey",
		       "requestSha256", "state", "cleanupState", "recoveryOwner",
		       "recoveryGeneration"
		FROM "VerificationResourceIntent"
		WHERE "id" = ${input.fence.intentId}::uuid
		FOR UPDATE
	`;
	const intent = intents[0];
	if (
		!intent ||
		intent.id !== input.fence.intentId ||
		intent.verificationRunId !== input.fence.verificationRunId ||
		intent.kind !== input.kind ||
		intent.verificationKey !== input.verificationKey ||
		intent.requestSha256 !== input.requestSha256 ||
		intent.state !== "SUBMITTED" ||
		intent.cleanupState !== "PENDING" ||
		intent.recoveryOwner !== input.fence.token ||
		intent.recoveryGeneration !== input.fence.intentGeneration
	) {
		rejectFence();
	}
}
