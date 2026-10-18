import { verificationDispatchFenceSchema } from "@bitovp/core";
import { z } from "zod";

/**
 * The idempotency contract the two paid create routes honour for the
 * verification harness.
 *
 * The harness sends `verificationKey` (derived from run + scenario + kind,
 * so it can be re-derived with no response) and `requestSha256` (its own
 * digest of the body it meant to send). The route stamps both on the row it
 * creates. A repeat with the same key:
 *
 * same SHA → the EXISTING row, 200, `replayed: true` — the harness's
 * lost response is answered without a second paid resource;
 * different SHA → 409 — the key was used for a different request, and a
 * silent "return the existing" would hand back a resource
 * the caller did not describe.
 *
 * The SHA is the CLIENT's statement; the route never recomputes it — its
 * parsed plan is not the raw body. Both fields go together or not at all.
 */
export const VERIFICATION_KEY_FIELDS = {
	verificationKey: z.string().min(1).max(200).optional(),
	requestSha256: z
		.string()
		.regex(/^[0-9a-f]{64}$/, "requestSha256 must be a lowercase hex SHA-256")
		.optional(),
	verificationDispatch: verificationDispatchFenceSchema.optional(),
} as const;

export function verificationKeyPairComplete(value: {
	verificationKey?: string | undefined;
	requestSha256?: string | undefined;
}): boolean {
	return (
		(value.verificationKey === undefined) ===
		(value.requestSha256 === undefined)
	);
}

export const VERIFICATION_KEY_PAIR_MESSAGE =
	"verificationKey and requestSha256 go together";

export function verificationDispatchHasKeyPair(value: {
	verificationKey?: string | undefined;
	requestSha256?: string | undefined;
	verificationDispatch?: unknown;
}): boolean {
	return (
		value.verificationDispatch === undefined ||
		(value.verificationKey !== undefined && value.requestSha256 !== undefined)
	);
}

export const VERIFICATION_DISPATCH_KEY_PAIR_MESSAGE =
	"verificationDispatch requires verificationKey and requestSha256";

export type VerificationReplay<T> =
	| { kind: "none" }
	| { kind: "replay"; row: T }
	| { kind: "conflict" };

/**
 * The decision, over whatever the route's lookup found. `row` comes back
 * WITHOUT the stored SHA — a response carries the resource, not the
 * bookkeeping column.
 */
export function verificationReplay<T extends object>(
	existing: (T & { verificationRequestSha256: string | null }) | null,
	requestSha256: string,
): VerificationReplay<T> {
	if (!existing) {
		return { kind: "none" };
	}
	const { verificationRequestSha256, ...row } = existing;
	if (verificationRequestSha256 === requestSha256) {
		return { kind: "replay", row: row as T };
	}
	return { kind: "conflict" };
}

/**
 * Two concurrent sends of one key both pass the pre-check and both INSERT;
 * the loser's create is a P2002 on the unique key. That is the same
 * situation as a replay — the winner's row is the answer — so the route
 * re-runs the lookup rather than answering 500. Only the verificationKey
 * target counts: any other unique violation is still an error.
 */
export function isVerificationKeyConflict(err: unknown): boolean {
	const e = err as { code?: unknown; meta?: { target?: unknown } };
	if (e?.code !== "P2002") {
		return false;
	}
	const target = e.meta?.target;
	if (Array.isArray(target)) {
		return target.some((t) => String(t).includes("verificationKey"));
	}
	return typeof target === "string" && target.includes("verificationKey");
}
