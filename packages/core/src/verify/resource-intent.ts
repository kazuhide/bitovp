import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * The VerificationResourceIntent contract
 * shared by the harness (which WRITES the rows), the product's two
 * create routes (which honour the idempotency key) and any later reader.
 *
 * The defect this exists for: the harness learned a paid resource's id from
 * the HTTP RESPONSE — `jobId = (await submit).jobId`, `channelId = created
 * .json.id`. A timeout, a reset connection or an unparseable body between the
 * server's create and that assignment left NOTHING in memory that cleanup
 * could act on, while the job or channel billed. The invariant is therefore:
 * a durable intent exists BEFORE any provider CREATE is sent, the set of
 * "resources that may have been created" is rediscoverable WITHOUT the
 * response (by the intent's key and its name/label marker), and the run's
 * cleanup seal is driven by that intent set — never by in-memory ids.
 *
 * Declared ONCE, here, for the same reason `run-record.ts` is: a union spelled
 * twice drifts the day one copy gains a member.
 */

/**
 * PREPARED  — the intent row landed; nothing has been sent. Nothing can exist.
 * SUBMITTED — the request has been handed to the network. From here on the
 *             resource MAY exist whatever the response says or fails to say.
 * CONFIRMED — the product answered with a local id, or a lookup adopted one.
 * AMBIGUOUS — the response was lost or unreadable after the send; the resource
 *             may exist and must be FOUND (never blindly re-sent).
 * TERMINAL  — resolved: the resource was read back terminal and cleaned, was
 *             proven never created, or was left UNRESOLVED for an operator.
 */
export const VERIFICATION_INTENT_STATES = [
	"PREPARED",
	"SUBMITTED",
	"CONFIRMED",
	"AMBIGUOUS",
	"TERMINAL",
] as const;
export type VerificationIntentState =
	(typeof VERIFICATION_INTENT_STATES)[number];

/** The paid resource kinds the harness creates through the product. */
export const VERIFICATION_INTENT_KINDS = ["VOD_JOB", "LIVE_CHANNEL"] as const;
export type VerificationIntentKind = (typeof VERIFICATION_INTENT_KINDS)[number];

/**
 * One-time bearer fence carried only by the paid verification harness.
 *
 * The token is the unpredictable dispatch owner durably stored on the child
 * intent; the two generations bind it to the exact parent run authority and
 * exact child lease generation. The product create route locks parent first,
 * then child, and validates every field in the SAME transaction that creates
 * the local paid resource. It is transport authorization, not request
 * identity, so `verificationRequestBodySha256` deliberately excludes it.
 */
export const verificationDispatchFenceSchema = z
	.object({
		verificationRunId: z.uuid(),
		runGeneration: z.number().int().min(0),
		intentId: z.uuid(),
		intentGeneration: z.number().int().min(1),
		token: z.string().min(32).max(512),
	})
	.strict();
export type VerificationDispatchFence = z.infer<
	typeof verificationDispatchFenceSchema
>;

/** Safe fields proving why one provider encoding belongs to an intent. */
export type VerificationEncodingIdentity = {
	encodingId: string;
	jobId: string;
	step: string;
	name: string;
	label: string;
	verificationKey: string;
	requestSha256: string;
};

/**
 * PENDING       — not yet resolved.
 * CLEANED       — the resource was read back TERMINAL (local, and the provider
 *                 where one was reached) and its cleanup proved.
 * NEVER_CREATED — proven never sent, or the product refused it definitively
 *                 (a 4xx that is not the idempotency 409) — nothing to clean.
 * UNRESOLVED    — the resource may exist and could not be found or driven
 *                 terminal; operator action is required and the run must not
 *                 seal.
 */
export const VERIFICATION_INTENT_CLEANUP_STATES = [
	"PENDING",
	"CLEANED",
	"NEVER_CREATED",
	"UNRESOLVED",
] as const;
export type VerificationIntentCleanupState =
	(typeof VERIFICATION_INTENT_CLEANUP_STATES)[number];

export function isVerificationIntentState(
	value: unknown,
): value is VerificationIntentState {
	return (VERIFICATION_INTENT_STATES as readonly unknown[]).includes(value);
}

export function isVerificationIntentKind(
	value: unknown,
): value is VerificationIntentKind {
	return (VERIFICATION_INTENT_KINDS as readonly unknown[]).includes(value);
}

/**
 * The idempotency key: one per (run, scenario, kind). Deterministic, so a
 * lookup after a lost response can DERIVE it without any response — and so a
 * second send of the same scenario in the same run carries the same key and
 * the product returns the existing resource instead of creating a twin.
 *
 * `:` is the separator because neither side can carry it: a run id is
 * `[A-Za-z0-9._-]` (validateRunId) and a scenario is a fixture file stem.
 * Refused rather than escaped — a key that could be forged from two different
 * (run, scenario) pairs is no key at all.
 */
export const VERIFICATION_KEY_PREFIX = "verify";

export function verificationKeyFor(
	runId: string,
	scenario: string,
	kind: VerificationIntentKind,
): string {
	for (const [what, value] of [
		["run id", runId],
		["scenario", scenario],
	] as const) {
		if (value.length === 0 || value.includes(":")) {
			throw new Error(
				`a verification key cannot be derived from a ${what} that is empty or contains ":" (got ${JSON.stringify(value)})`,
			);
		}
	}
	return `${VERIFICATION_KEY_PREFIX}:${runId}:${scenario}:${kind}`;
}

/**
 * The marker the key rides under on the resource itself — a Bitmovin
 * Encoding label (VOD: `plan.bitmovin.labels` reaches both the local row's
 * `labels` column and the provider encoding's statistics labels through the
 * compiler's CREATE_ENCODING payload) — so the resource can be found by its
 * marker even where the key column was never written.
 */
export const VERIFICATION_KEY_LABEL_PREFIX = "verify-key:";

export function verificationKeyLabel(key: string): string {
	return `${VERIFICATION_KEY_LABEL_PREFIX}${key}`;
}

/** Stable JSON for a request body. JSON object order is not request identity. */
function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") {
		const encoded = JSON.stringify(value);
		if (encoded === undefined) {
			throw new Error("verification requests must contain only JSON values");
		}
		return encoded;
	}
	if (Array.isArray(value)) {
		return `[${value
			.map((item) => (item === undefined ? "null" : canonicalJson(item)))
			.join(",")}]`;
	}
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.filter((key) => record[key] !== undefined)
		.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
		.join(",")}}`;
}

/**
 * The canonical request SHA both the client and server compute. Same key +
 * same SHA replays; same key + a different SHA conflicts. The server MUST
 * recompute it from the received body instead of trusting the claim.
 */
export function verificationRequestSha256(body: unknown): string {
	return createHash("sha256").update(canonicalJson(body)).digest("hex");
}

/** Recompute an HTTP request body after removing its self-referential claim. */
export function verificationRequestBodySha256(body: unknown): string {
	if (body === null || Array.isArray(body) || typeof body !== "object") {
		throw new Error("a verification create body must be a JSON object");
	}
	const {
		requestSha256: _claim,
		verificationDispatch: _dispatch,
		...unsigned
	} = body as Record<string, unknown>;
	return verificationRequestSha256(unsigned);
}

export const VERIFICATION_KEY_SHA_CONFLICT =
	"VERIFICATION_KEY_SHA_CONFLICT" as const;
export const VERIFICATION_REQUEST_SHA_MISMATCH =
	"VERIFICATION_REQUEST_SHA_MISMATCH" as const;
export const VERIFICATION_DISPATCH_FENCE_REQUIRED =
	"VERIFICATION_DISPATCH_FENCE_REQUIRED" as const;
export const VERIFICATION_DISPATCH_FENCE_REJECTED =
	"VERIFICATION_DISPATCH_FENCE_REJECTED" as const;
export type VerificationCreateErrorCode =
	| typeof VERIFICATION_KEY_SHA_CONFLICT
	| typeof VERIFICATION_REQUEST_SHA_MISMATCH
	| typeof VERIFICATION_DISPATCH_FENCE_REQUIRED
	| typeof VERIFICATION_DISPATCH_FENCE_REJECTED;

/** Read only the bounded machine code; response prose is never authority. */
export function verificationCreateErrorCode(
	value: unknown,
): VerificationCreateErrorCode | undefined {
	const code = (value as { details?: { code?: unknown } } | null)?.details
		?.code;
	return code === VERIFICATION_KEY_SHA_CONFLICT ||
		code === VERIFICATION_REQUEST_SHA_MISMATCH ||
		code === VERIFICATION_DISPATCH_FENCE_REQUIRED ||
		code === VERIFICATION_DISPATCH_FENCE_REJECTED
		? code
		: undefined;
}

/** The durable closure dossier the seal rule validates, not status labels. */
export type VerificationIntentSealInput = {
	verificationKey: string;
	requestSha256?: string;
	state: string;
	cleanupState: string;
	possiblyCreatedKeys?: readonly string[];
	cleanedResourceKeys?: readonly string[];
	providerIds?: readonly string[];
	candidates?: unknown;
	readback?: unknown;
	closureDigest?: string | null;
};

function sortedUniqueStrings(value: unknown): string[] | undefined {
	if (
		!Array.isArray(value) ||
		!value.every((item) => typeof item === "string")
	) {
		return undefined;
	}
	const unique = [...new Set(value as string[])].sort();
	return unique.length === value.length ? unique : undefined;
}

/** Digest over the exact evidence a third party uses to recompute closure. */
export function verificationIntentClosureDigest(
	intent: Omit<VerificationIntentSealInput, "closureDigest">,
): string {
	const candidateSet = Array.isArray(intent.candidates)
		? intent.candidates.map((candidate) => canonicalJson(candidate)).sort()
		: intent.candidates;
	return createHash("sha256")
		.update(
			canonicalJson({
				verificationKey: intent.verificationKey,
				requestSha256: intent.requestSha256,
				state: intent.state,
				cleanupState: intent.cleanupState,
				possiblyCreatedKeys:
					sortedUniqueStrings(intent.possiblyCreatedKeys) ??
					intent.possiblyCreatedKeys,
				cleanedResourceKeys:
					sortedUniqueStrings(intent.cleanedResourceKeys) ??
					intent.cleanedResourceKeys,
				providerIds:
					sortedUniqueStrings(intent.providerIds) ?? intent.providerIds,
				candidates: candidateSet,
				readback: intent.readback,
			}),
		)
		.digest("hex");
}

function neverCreatedProof(readback: unknown): boolean {
	return (
		readback !== null &&
		typeof readback === "object" &&
		((readback as { neverSent?: unknown }).neverSent === true ||
			(readback as { refused?: unknown }).refused === true)
	);
}

/**
 * The seal rule (§14.4 EV-01 change 6): the run may seal ONLY when
 * `possibly-created set == terminal-readback-and-cleaned set`. Every intent
 * must be TERMINAL, and its cleanup must be CLEANED (read back terminal and
 * cleaned) or NEVER_CREATED (proven nothing exists). PENDING and UNRESOLVED
 * are both refusals — an intent nobody resolved is exactly the lost id this
 * table exists to keep.
 */
export function verificationIntentsSealable<
	T extends VerificationIntentSealInput,
>(intents: readonly T[]): { sealable: boolean; unresolved: T[] } {
	const unresolved = intents.filter((intent) => {
		if (intent.state !== "TERMINAL") return true;
		const possible = sortedUniqueStrings(intent.possiblyCreatedKeys);
		const cleaned = sortedUniqueStrings(intent.cleanedResourceKeys);
		const providers = sortedUniqueStrings(intent.providerIds);
		if (!possible || !cleaned || !providers || !intent.requestSha256)
			return true;
		const expectedDigest = verificationIntentClosureDigest(intent);
		if (intent.closureDigest !== expectedDigest) return true;
		if (intent.cleanupState === "NEVER_CREATED") {
			return (
				possible.length !== 0 ||
				cleaned.length !== 0 ||
				providers.length !== 0 ||
				!neverCreatedProof(intent.readback)
			);
		}
		if (intent.cleanupState !== "CLEANED" || intent.readback == null)
			return true;
		return (
			possible.length === 0 ||
			possible.length !== cleaned.length ||
			possible.some((key, index) => key !== cleaned[index])
		);
	});
	return { sealable: unresolved.length === 0, unresolved };
}
