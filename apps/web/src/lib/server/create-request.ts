import "server-only";
import { createHash } from "node:crypto";
import type { AppPrismaClient } from "@bitovp/db";
import type { AuthenticatedContext } from "../auth/tenancy";
import {
	CREATE_SESSION_CHANGED,
	CREATE_SESSION_HEADER,
	canonicalCreateRequestJson,
} from "../creation-submission-contract";
import { jsonError } from "./http";

export type CreateRequestKind = "VOD_JOB" | "LIVE_CHANNEL" | "LIBRARY_EDIT";
export type CreateRequestIdentity = {
	requestKey: string;
	requestSha256: string;
};

type ReceiptClient = Pick<AppPrismaClient, "createRequest">;

export class InvalidCreateRequestError extends Error {}

export class CreateRequestUniqueConflictError extends Error {
	constructor() {
		super("Another request already accepted this create key");
		this.name = "CreateRequestUniqueConflictError";
	}
}

/** Compare a browser's click-time binding with the authenticated request. */
export function changedCreationSession(
	req: Request,
	tenant?: AuthenticatedContext,
) {
	const expected = req.headers.get(CREATE_SESSION_HEADER);
	if (expected === null) return undefined;
	if (
		tenant &&
		!tenant.isImpersonating &&
		(tenant.role === "ADMIN" || tenant.role === "OPERATOR")
	) {
		const principal =
			tenant.actor === "session"
				? "main:password"
				: tenant.actor === "none"
					? "main:none"
					: tenant.actorUserId &&
							tenant.actorUserId === tenant.effectiveUserId &&
							tenant.actor === `user:${tenant.actorUserId}`
						? tenant.actorUserId
						: null;
		if (
			principal &&
			expected === JSON.stringify([tenant.organizationId, principal])
		)
			return undefined;
	}
	return jsonError(409, "The creation session has changed", {
		code: CREATE_SESSION_CHANGED,
	});
}

/** Hash the accepted request before account defaults or time-dependent derivation. */
export function createRequestIdentity(
	req: Request,
	acceptedBody: object,
): CreateRequestIdentity | undefined {
	const requestKey = req.headers.get("Idempotency-Key");
	if (requestKey === null) return undefined;
	if (!/^[A-Za-z0-9._:-]{1,200}$/.test(requestKey)) {
		throw new InvalidCreateRequestError(
			"Idempotency-Key must contain 1 to 200 ASCII letters, digits, periods, underscores, colons or hyphens",
		);
	}
	if (
		["verificationKey", "requestSha256", "verificationDispatch"].some((field) =>
			Object.hasOwn(acceptedBody, field),
		)
	) {
		throw new InvalidCreateRequestError(
			"Idempotency-Key cannot be combined with verification fields",
		);
	}
	return {
		requestKey,
		requestSha256: createHash("sha256")
			.update(canonicalCreateRequestJson(acceptedBody))
			.digest("hex"),
	};
}

/** The tenant client scopes the receipt, including raw SQL and transactions. */
export async function lookupCreateRequest(
	prisma: ReceiptClient,
	kind: CreateRequestKind,
	identity: CreateRequestIdentity,
	matchesHistoricalDigest?: (digest: string) => boolean,
) {
	const receipt = await prisma.createRequest.findFirst({
		where: { kind, requestKey: identity.requestKey },
		select: { requestSha256: true, resourceId: true },
	});
	if (!receipt) return { kind: "none" } as const;
	if (
		receipt.requestSha256 !== identity.requestSha256 &&
		!matchesHistoricalDigest?.(receipt.requestSha256)
	)
		return { kind: "conflict" } as const;
	return { kind: "existing", resourceId: receipt.resourceId } as const;
}

/** Call only in the transaction that creates the resource and its schedules. */
export async function recordCreateRequest(
	tx: ReceiptClient,
	kind: CreateRequestKind,
	identity: CreateRequestIdentity,
	resourceId: string,
): Promise<void> {
	try {
		await tx.createRequest.create({ data: { kind, ...identity, resourceId } });
	} catch (err) {
		// The receipt primary key is this table's only unique constraint. Prisma
		// can omit its target under RLS, so the exact insert is the authority;
		// resource and schedule unique violations never enter this catch.
		if ((err as { code?: unknown } | null)?.code === "P2002") {
			throw new CreateRequestUniqueConflictError();
		}
		throw err;
	}
}

export function createRequestConflictResponse() {
	return jsonError(
		409,
		"Idempotency-Key was already used for a different request",
		{ code: "CREATE_REQUEST_CONFLICT" },
	);
}

export function createRequestGoneResponse() {
	return jsonError(
		410,
		"The resource created by this request was deleted; this key cannot create another resource",
		{ code: "CREATE_REQUEST_GONE" },
	);
}

/** Only a collision raised by the receipt insert can trigger race replay. */
export function isCreateRequestUniqueConflict(err: unknown): boolean {
	return err instanceof CreateRequestUniqueConflictError;
}
