import { randomUUID } from "node:crypto";
import {
	redactSecrets,
	type VerificationDispatchFence,
	type VerificationIntentCleanupState,
	type VerificationIntentKind,
	type VerificationIntentState,
	verificationIntentClosureDigest,
	verificationIntentsSealable,
	verificationKeyLabel,
} from "@bitovp/core";
import type { AppPrismaClient, AppTransactionClient, Prisma } from "@bitovp/db";
import { recordableError, redactIntentDossier } from "./run-record";

export { redactIntentDossier } from "./run-record";

/**
 * The durable-intent ledger for paid creates

 *
 * What was wrong: both spend sites learned the resource's id from the HTTP
 * RESPONSE. `submit` threw on a lost or unparseable response and the catch
 * saw `!jobId` and walked away; `runLiveScenario` POSTed the channel BEFORE its
 * `try/finally`, so a create-time throw ran no teardown at all. In both cases
 * the product had created — and was billing — a resource that no in-memory
 * variable named and no cleanup could reach.
 *
 * The invariant this module carries (§14.4 EV-01):
 *
 * 1. A durable intent row lands BEFORE the create is sent (`prepare` =
 * PREPARED, `submitted` = SUBMITTED). Both are HARD writes: if either
 * does not land, the caller must NOT send.
 * 2. The possibly-created set is rediscoverable WITHOUT the response: the
 * intent's key is derived from (run, scenario, kind); the product stamps
 * it on the row it creates; the resource's name/label carries it too.
 * 3. A lost, reset or unparseable response after the send is AMBIGUOUS —
 * never a blind retry. The resource is LOOKED UP by key and marker:
 * exactly one candidate is adopted; zero or several stay UNRESOLVED and
 * the run exits nonzero with 0 SEALED rows (an unfinished lookup could
 * still land, so "zero" is not "never created" once the request left).
 * 4. Teardown enumerates every intent from the DATABASE — the authority —
 * and the run seals only when `possibly-created == terminal-readback-
 * and-cleaned` (`verificationIntentsSealable`).
 *
 * Behind a narrow store, like run-record.ts, so the decisions are driven by a
 * fake and the Prisma adapter is a field-for-field pass-through.
 */

export type IntentEvent = {
	sequence: number;
	eventType: string;
	fromState: string | null;
	toState: string | null;
	cleanupState: string | null;
	details: unknown;
	createdAt: Date;
};

export type IntentRow = {
	id: string;
	scenario: string;
	kind: VerificationIntentKind;
	verificationKey: string;
	requestSha256: string;
	resourceName: string | null;
	state: VerificationIntentState;
	localId: string | null;
	providerId: string | null;
	providerIds: string[];
	candidates: LocalCandidate[] | null;
	cleanupState: VerificationIntentCleanupState;
	readback: unknown;
	possiblyCreatedKeys: string[];
	cleanedResourceKeys: string[];
	closureDigest: string | null;
	error: string | null;
	recoveryOwner: string | null;
	recoveryLeaseUntil: Date | null;
	recoveryGeneration: number;
	events?: IntentEvent[];
};

/**
 * Project a database-authoritative intent into report/recovery evidence.
 *
 * `recoveryOwner` is concurrency state in Postgres. While a dispatch is live
 * it is also the bearer accepted by the paid-create route, so copying it into
 * a portable JSON dossier would extend that authority beyond the database.
 * Preserve null for sealed-report equality; mask only live owner values and
 * never mutate the row the recovery state machine is using.
 */
export type IntentRecoveryClaim = {
	owner: string;
	generation: number;
	leaseUntil: Date;
};

/** The parent run generation reserved before any paid work can begin. */
export type IntentProducerFence = {
	verificationRunId: string;
	recoveryGeneration: number;
};

/** One local row that answered the marker lookup, and by which marker(s). */
export type LocalCandidate = {
	localId: string;
	matchedBy: ("key" | "label" | "name")[];
	status: string;
	providerId: string | null;
	requestSha256: string | null;
};

export type IntentCreate = {
	verificationRunId: string;
	scenario: string;
	kind: VerificationIntentKind;
	verificationKey: string;
	requestSha256: string;
	resourceName?: string;
};

export type IntentUpdate = {
	eventType?: string;
	state?: VerificationIntentState;
	localId?: string;
	providerId?: string | null;
	providerIds?: readonly string[];
	candidates?: readonly LocalCandidate[];
	cleanupState?: VerificationIntentCleanupState;
	readback?: unknown;
	possiblyCreatedKeys?: readonly string[];
	cleanedResourceKeys?: readonly string[];
	closureDigest?: string | null;
	sealedAt?: Date;
	/** Current row error; terminal CLEANED/NEVER_CREATED explicitly clear it. */
	error?: string | null;
	/** Error retained only in the append-only transition event. */
	eventError?: string;
	/**
	 * Atomically acquire the row while committing SUBMITTED. The producer keeps
	 * this lease across the paid POST; restart recovery must not reconcile the
	 * intent until the response was classified or the bounded lease expired.
	 */
	dispatchLease?: { owner: string; now: Date; leaseMs: number };
	/** Release the live dispatch/recovery lease in the same durable transition. */
	releaseLease?: boolean;
};

export type IntentStore = {
	create: (
		data: IntentCreate,
		producerFence: IntentProducerFence,
	) => Promise<{ id: string }>;
	update: (
		id: string,
		data: IntentUpdate,
		claim?: IntentRecoveryClaim,
		producerFence?: IntentProducerFence,
	) => Promise<unknown>;
	/** Atomically fence one reconciler; null means another live owner won. */
	claimForRecovery: (
		id: string,
		input: { owner: string; now: Date; leaseMs: number },
		producerFence?: IntentProducerFence,
	) => Promise<IntentRecoveryClaim | null>;
	/** Every intent of one run — the teardown's population. */
	listForRun: (verificationRunId: string) => Promise<IntentRow[]>;
	/**
	 * The unique exact-key row, when present, plus bounded weak marker rows for
	 * diagnostics. The exact lookup must never share a result limit with weak
	 * name/label matches.
	 */
	findLocal: (
		kind: VerificationIntentKind,
		marker: { verificationKey: string; label?: string; name?: string },
	) => Promise<LocalCandidate[]>;
};

/**
 * Where a send failed relative to the wire (§14.4 EV-01 change 4).
 *
 * BEFORE_SEND — the request provably never left this process: the socket was
 *   refused, the host did not resolve, the route was unreachable. Nothing can
 *   exist. Only the codes that mean exactly that are listed; everything else
 *   — a timeout after connect, a reset, EPIPE, a body read failure, a JSON
 *   parse failure, an error with no code at all — is AMBIGUOUS, because the
 *   request may have reached the server. Fail closed: an unknown failure is
 *   treated as "may have been created".
 */
export type SendFailurePhase = "BEFORE_SEND" | "AMBIGUOUS";

const BEFORE_SEND_CODES: ReadonlySet<string> = new Set([
	"ECONNREFUSED",
	"ENOTFOUND",
	"EAI_AGAIN",
	"EHOSTUNREACH",
	"ENETUNREACH",
	"EADDRNOTAVAIL",
	"UND_ERR_CONNECT_TIMEOUT",
	"ERR_INVALID_URL",
]);

export function classifySendFailure(err: unknown): SendFailurePhase {
	let current: unknown = err;
	for (
		let depth = 0;
		depth < 6 && current !== undefined && current !== null;
		depth += 1
	) {
		const code = (current as { code?: unknown }).code;
		if (typeof code === "string" && BEFORE_SEND_CODES.has(code)) {
			return "BEFORE_SEND";
		}
		// Happy-eyeballs failures arrive as an AggregateError whose members each
		// carry the refusal; the aggregate itself has no code.
		const members = (current as { errors?: unknown }).errors;
		if (
			Array.isArray(members) &&
			members.length > 0 &&
			members.every((m) => {
				const c = (m as { code?: unknown })?.code;
				return typeof c === "string" && BEFORE_SEND_CODES.has(c);
			})
		) {
			return "BEFORE_SEND";
		}
		current = (current as { cause?: unknown }).cause;
	}
	return "AMBIGUOUS";
}

export type IntentResolution =
	| {
			adopted: true;
			localId: string;
			providerId: string | null;
			candidates: LocalCandidate[];
	  }
	| { adopted: false; reason: string; candidates: LocalCandidate[] };

/** What a kind's resolver read back when it drove an adopted resource terminal. */
export type IntentReadback = {
	terminal: boolean;
	readback: unknown;
	providerId?: string | null;
	providerIds?: readonly string[];
	possiblyCreatedKeys?: readonly string[];
	cleanedResourceKeys?: readonly string[];
	error?: string;
};

export type IntentTerminalInput = {
	cleanupState: "CLEANED" | "UNRESOLVED";
	readback: unknown;
	providerId?: string | null;
	providerIds?: readonly string[];
	possiblyCreatedKeys?: readonly string[];
	cleanedResourceKeys?: readonly string[];
	error?: string;
};

export type IntentHandle = {
	key: string;
	kind: VerificationIntentKind;
	requestSha256: string;
	/** HARD: throws when the SUBMITTED write did not land — do NOT send. */
	submitted: () => Promise<VerificationDispatchFence>;
	/** The product answered with an id. Soft: the product holds the key too. */
	confirmed: (localId: string, providerId?: string | null) => Promise<void>;
	/**
	 * HARD: retain a successful product HTTP CREATE response id as a cleanup
	 * possibility before any lookup/adoption can persist a different localId.
	 * This does not set `localId` and is never adoption evidence.
	 */
	recordCreateResponseId: (localId: string) => Promise<void>;
	/** The request provably never left (BEFORE_SEND) — nothing to clean. */
	neverSent: (reason: string) => Promise<void>;
	/** The product refused definitively (a 4xx other than 409) — nothing exists. */
	refused: (reason: string) => Promise<void>;
	/** The response was lost or unreadable after the send. Retried write. */
	ambiguous: (reason: string) => Promise<void>;
	/** Look the resource up by key + markers; adopt exactly one. */
	resolve: () => Promise<IntentResolution>;
	/** Close the intent with its terminal readback. */
	terminal: (input: IntentTerminalInput) => Promise<void>;
	/** The id this handle knows, from the response or from an adoption. */
	localId: () => string | undefined;
};

/** Merge every resource discovered by a canary mismatch into one fail-closed closure. */
export function mergeIntentTerminalInputs(
	primary: IntentTerminalInput,
	additional: readonly IntentTerminalInput[],
): IntentTerminalInput {
	if (additional.length === 0) return primary;
	const all = [primary, ...additional];
	const unique = (values: readonly (string | undefined | null)[]) =>
		[
			...new Set(values.filter((value): value is string => Boolean(value))),
		].sort();
	const providerIds = unique(
		all.flatMap((item) => [item.providerId, ...(item.providerIds ?? [])]),
	);
	const possiblyCreatedKeys = unique(
		all.flatMap((item) => [...(item.possiblyCreatedKeys ?? [])]),
	);
	const cleanedResourceKeys = unique(
		all.flatMap((item) => [...(item.cleanedResourceKeys ?? [])]),
	);
	const errors = all
		.map((item) => item.error)
		.filter((error): error is string => Boolean(error));
	const clean = all.every((item) => item.cleanupState === "CLEANED");
	return {
		cleanupState: clean ? "CLEANED" : "UNRESOLVED",
		readback: {
			primary: primary.readback,
			additional: additional.map((item) => item.readback),
		},
		providerId: primary.providerId ?? providerIds[0] ?? null,
		providerIds,
		possiblyCreatedKeys,
		cleanedResourceKeys,
		...(!clean || errors.length > 0
			? {
					error:
						errors.join("; ") ||
						"one or more response-loss canary resources did not close cleanly",
				}
			: {}),
	};
}

export type IntentResolvers = Record<
	VerificationIntentKind,
	(row: IntentRow & { localId: string }) => Promise<IntentReadback>
>;

export type IntentTeardown = {
	sealable: boolean;
	unresolved: IntentRow[];
	/** One line per intent, for the report and the log. */
	lines: string[];
	/** Redacted, database-authoritative closure dossier for the run report. */
	dossier: IntentRow[];
};

export type IntentLedger = {
	/**
	 * Commit PREPARED. HARD: throws when the row did not land, and the caller
	 * must then not send — "no durable intent, no paid create".
	 */
	prepare: (
		input: Omit<IntentCreate, "verificationRunId">,
	) => Promise<IntentHandle>;
	/**
	 * Enumerate every intent of the run from the database, resolve what is not
	 * durably CLEANED/NEVER_CREATED through the kind's resolver, and say whether
	 * the run may seal. Idempotent: a second call re-reads the rows and retries
	 * every still-open or legacy TERMINAL/UNRESOLVED row.
	 */
	teardown: (resolvers: IntentResolvers) => Promise<IntentTeardown>;
};

/** Soft-write retry: attempts and the backoff between them (injected sleep). */
export const INTENT_WRITE_ATTEMPTS = 3;
export const INTENT_WRITE_BACKOFF_MS = [250, 1000] as const;

function distinctByLocalId(candidates: LocalCandidate[]): LocalCandidate[] {
	const seen = new Map<string, LocalCandidate>();
	for (const c of candidates) {
		const prior = seen.get(c.localId);
		if (prior) {
			prior.matchedBy = [...new Set([...prior.matchedBy, ...c.matchedBy])];
		} else {
			seen.set(c.localId, { ...c, matchedBy: [...c.matchedBy] });
		}
	}
	return [...seen.values()];
}

/**
 * Only the exact durable key is adoption authority, and it must also carry the
 * exact request SHA. Name/label matches are diagnostics, never ownership: a
 * SUBMITTED request may still land under its unique key after a weak row was
 * observed.
 */
function adoptableCandidates(
	candidates: LocalCandidate[],
	requestSha256: string,
): LocalCandidate[] {
	return candidates.filter(
		(candidate) =>
			candidate.matchedBy.includes("key") &&
			candidate.requestSha256 === requestSha256,
	);
}

export function verificationLocalResourceKey(
	kind: VerificationIntentKind,
	localId: string,
): string {
	return `local:${kind}:${localId}`;
}

export function verificationProviderEncodingKey(providerId: string): string {
	return `provider:BITMOVIN_ENCODING:${providerId}`;
}

function uniqueSorted(values: readonly string[]): string[] {
	return [...new Set(values)].sort();
}

function localIdsFromPossibleKeys(
	kind: VerificationIntentKind,
	keys: readonly string[],
): string[] {
	const prefix = `local:${kind}:`;
	return uniqueSorted(
		keys.flatMap((key) =>
			key.startsWith(prefix) && key.length > prefix.length
				? [key.slice(prefix.length)]
				: [],
		),
	);
}

function closureUpdate(
	identity: {
		verificationKey: string;
		requestSha256: string;
		candidates: LocalCandidate[] | null;
	},
	input: {
		cleanupState: "CLEANED" | "NEVER_CREATED" | "UNRESOLVED";
		readback: unknown;
		providerIds: readonly string[];
		possiblyCreatedKeys: readonly string[];
		cleanedResourceKeys: readonly string[];
	},
): IntentUpdate {
	const providerIds = uniqueSorted(input.providerIds);
	const possiblyCreatedKeys = uniqueSorted(input.possiblyCreatedKeys);
	const cleanedResourceKeys = uniqueSorted(input.cleanedResourceKeys);
	const candidates = redactSecrets(identity.candidates ?? []);
	const readback = redactSecrets(input.readback);
	const closure = {
		verificationKey: identity.verificationKey,
		requestSha256: identity.requestSha256,
		state: "TERMINAL",
		cleanupState: input.cleanupState,
		providerIds,
		possiblyCreatedKeys,
		cleanedResourceKeys,
		candidates,
		readback,
	};
	return {
		state: "TERMINAL",
		cleanupState: input.cleanupState,
		providerIds,
		possiblyCreatedKeys,
		cleanedResourceKeys,
		candidates,
		readback,
		closureDigest: verificationIntentClosureDigest(closure),
		...(input.cleanupState === "CLEANED" ||
		input.cleanupState === "NEVER_CREATED"
			? { error: null }
			: {}),
	};
}

export function createIntentLedger(
	store: IntentStore,
	options: {
		verificationRunId: string;
		/** Required for producer prepare/transitions; absent on restart recovery. */
		producerRecoveryGeneration?: number;
		recoveryOwner?: string;
		recoveryLeaseMs?: number;
		log?: (line: string) => void;
		sleep?: (ms: number) => Promise<void>;
		now?: () => number;
	},
): IntentLedger {
	const log = options.log ?? (() => {});
	const sleep =
		options.sleep ??
		((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
	const now = options.now ?? Date.now;
	const recoveryOwner =
		options.recoveryOwner ?? `verify:${process.pid}:${randomUUID()}`;
	const recoveryLeaseMs = options.recoveryLeaseMs ?? 15 * 60 * 1000;
	const producerFence: IntentProducerFence | undefined =
		options.producerRecoveryGeneration === undefined
			? undefined
			: {
					verificationRunId: options.verificationRunId,
					recoveryGeneration: options.producerRecoveryGeneration,
				};

	/**
	 * A retried write that RESOLVES to whether it landed. Never rejects: past
	 * the send, a lost bookkeeping write must not abort the scenario that is
	 * driving a paid resource terminal — and the DB row it failed to update is
	 * re-read at teardown, which re-resolves anything still open. The database
	 * is the authority; the handle is a cache.
	 */
	const soft = async (
		what: string,
		write: () => Promise<unknown>,
		attempts = INTENT_WRITE_ATTEMPTS,
	): Promise<boolean> => {
		for (let attempt = 1; attempt <= attempts; attempt += 1) {
			try {
				await write();
				return true;
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				log(
					`[verify] could not record ${what} on the intent row (attempt ${attempt} of ${attempts}): ${message}`,
				);
				if (attempt < attempts) {
					await sleep(
						INTENT_WRITE_BACKOFF_MS[attempt - 1] ??
							(INTENT_WRITE_BACKOFF_MS.at(-1) as number),
					);
				}
			}
		}
		return false;
	};

	const lookup = async (
		kind: VerificationIntentKind,
		verificationKey: string,
		resourceName: string | null | undefined,
	): Promise<LocalCandidate[]> =>
		distinctByLocalId(
			await store.findLocal(kind, {
				verificationKey,
				label: verificationKeyLabel(verificationKey),
				...(resourceName ? { name: resourceName } : {}),
			}),
		);

	const describe = (candidates: LocalCandidate[]): string =>
		candidates
			.map(
				(c) =>
					`${c.localId} (${c.status}; matched by ${c.matchedBy.join("+")})`,
			)
			.join(", ");

	const handleFor = (
		id: string,
		input: Omit<IntentCreate, "verificationRunId">,
	): IntentHandle => {
		if (!producerFence) {
			throw new Error(
				"paid-resource intent producer has no reserved VerificationRun generation fence",
			);
		}
		const dispatchProducerFence = producerFence;
		// One unguessable bearer per child intent. It is durable only in that
		// child's recoveryOwner and transported once to the matching create route.
		const dispatchOwner = `verify-dispatch:${randomUUID()}`;
		let known: string | undefined;
		let dispatchClaim: IntentRecoveryClaim | undefined;
		const write = (data: IntentUpdate): Promise<unknown> =>
			store.update(id, data, dispatchClaim, producerFence);
		let knownProviderIds: string[] = [];
		let knownCandidates: LocalCandidate[] | null = null;
		const knownPossibleLocalIds = new Set<string>();
		const knownPossibleLocalKeys = () =>
			[...knownPossibleLocalIds].map((localId) =>
				verificationLocalResourceKey(input.kind, localId),
			);
		return {
			key: input.verificationKey,
			kind: input.kind,
			requestSha256: input.requestSha256,
			submitted: async () => {
				// HARD. A SUBMITTED row is what lets teardown tell "never sent"
				// from "sent, response lost, process died" — without it the two
				// are the same PREPARED row, and the second one is a bill.
				const result = (await store.update(
					id,
					{
						eventType: "SUBMITTED",
						state: "SUBMITTED",
						dispatchLease: {
							owner: dispatchOwner,
							now: new Date(now()),
							leaseMs: recoveryLeaseMs,
						},
					},
					undefined,
					dispatchProducerFence,
				)) as { claim?: IntentRecoveryClaim };
				if (!result.claim) {
					throw new Error(
						"intent SUBMITTED transition did not return its durable dispatch lease",
					);
				}
				dispatchClaim = result.claim;
				return {
					verificationRunId: dispatchProducerFence.verificationRunId,
					runGeneration: dispatchProducerFence.recoveryGeneration,
					intentId: id,
					intentGeneration: result.claim.generation,
					token: result.claim.owner,
				};
			},
			recordCreateResponseId: async (localId) => {
				knownPossibleLocalIds.add(localId);
				// HARD. The event lands before AMBIGUOUS/ADOPTED. It deliberately
				// carries no `localId` scalar, so it cannot be used as adoption proof.
				await store.update(
					id,
					{
						eventType: "CREATE_RESPONSE_ID_CAPTURED",
						possiblyCreatedKeys: uniqueSorted(knownPossibleLocalKeys()),
					},
					dispatchClaim,
					producerFence,
				);
			},
			confirmed: async (localId, providerId) => {
				known = localId;
				knownPossibleLocalIds.add(localId);
				knownProviderIds = providerId ? [providerId] : [];
				const landed = await soft(`CONFIRMED ${input.verificationKey}`, () =>
					store.update(
						id,
						{
							eventType: "CONFIRMED",
							state: "CONFIRMED",
							releaseLease: true,
							localId,
							providerIds: knownProviderIds,
							possiblyCreatedKeys: uniqueSorted([
								...knownPossibleLocalKeys(),
								...knownProviderIds.map(verificationProviderEncodingKey),
							]),
							...(providerId !== undefined ? { providerId } : {}),
						},
						dispatchClaim,
						producerFence,
					),
				);
				if (landed) dispatchClaim = undefined;
			},
			neverSent: async (reason) => {
				const readback = { neverSent: true };
				const landed = await soft(`never-sent ${input.verificationKey}`, () =>
					store.update(
						id,
						{
							eventType: "NEVER_SENT",
							...closureUpdate(
								{
									verificationKey: input.verificationKey,
									requestSha256: input.requestSha256,
									candidates: knownCandidates,
								},
								{
									cleanupState: "NEVER_CREATED",
									readback,
									providerIds: [],
									possiblyCreatedKeys: [],
									cleanedResourceKeys: [],
								},
							),
							sealedAt: new Date(now()),
							eventError: recordableError(reason),
							releaseLease: true,
						},
						dispatchClaim,
						producerFence,
					),
				);
				if (landed) dispatchClaim = undefined;
			},
			refused: async (reason) => {
				const readback = { refused: true };
				const landed = await soft(`refusal ${input.verificationKey}`, () =>
					store.update(
						id,
						{
							eventType: "REFUSED",
							...closureUpdate(
								{
									verificationKey: input.verificationKey,
									requestSha256: input.requestSha256,
									candidates: knownCandidates,
								},
								{
									cleanupState: "NEVER_CREATED",
									readback,
									providerIds: [],
									possiblyCreatedKeys: [],
									cleanedResourceKeys: [],
								},
							),
							sealedAt: new Date(now()),
							eventError: recordableError(reason),
							releaseLease: true,
						},
						dispatchClaim,
						producerFence,
					),
				);
				if (landed) dispatchClaim = undefined;
			},
			ambiguous: async (reason) => {
				const landed = await soft(`AMBIGUOUS ${input.verificationKey}`, () =>
					store.update(
						id,
						{
							eventType: "AMBIGUOUS",
							state: "AMBIGUOUS",
							error: recordableError(reason),
							releaseLease: true,
						},
						dispatchClaim,
						producerFence,
					),
				);
				if (landed) dispatchClaim = undefined;
			},
			resolve: async () => {
				const candidates = await lookup(
					input.kind,
					input.verificationKey,
					input.resourceName,
				);
				const adoptable = adoptableCandidates(candidates, input.requestSha256);
				knownCandidates = candidates;
				if (adoptable.length === 1) {
					const only = adoptable[0] as LocalCandidate;
					known = only.localId;
					knownPossibleLocalIds.add(only.localId);
					knownProviderIds = only.providerId ? [only.providerId] : [];
					const landed = await soft(`adoption ${input.verificationKey}`, () =>
						store.update(
							id,
							{
								eventType: "ADOPTED",
								state: "CONFIRMED",
								localId: only.localId,
								providerId: only.providerId,
								providerIds: knownProviderIds,
								possiblyCreatedKeys: uniqueSorted([
									...knownPossibleLocalKeys(),
									...knownProviderIds.map(verificationProviderEncodingKey),
								]),
								candidates,
								releaseLease: true,
							},
							dispatchClaim,
							producerFence,
						),
					);
					if (landed) dispatchClaim = undefined;
					log(
						`[verify] intent ${input.verificationKey}: adopted ${only.localId} (matched by ${only.matchedBy.join("+")})`,
					);
					return {
						adopted: true,
						localId: only.localId,
						providerId: only.providerId,
						candidates,
					};
				}
				const reason =
					candidates.length === 0
						? "no local row carries its key or marker yet — the request left this process, so it may still land; UNRESOLVED until an operator checks"
						: adoptable.length === 0
							? `local rows carry the key or marker, but none carries request SHA ${input.requestSha256} (${describe(candidates)}) — UNRESOLVED; never adopt a different request`
							: `${adoptable.length} request-SHA-qualified local rows carry its key or marker (${describe(adoptable)}) — UNRESOLVED until an operator picks`;
				const landed = await soft(`unresolved ${input.verificationKey}`, () =>
					store.update(
						id,
						{
							eventType: "UNRESOLVED",
							state: "AMBIGUOUS",
							cleanupState: "UNRESOLVED",
							candidates,
							error: recordableError(reason),
							releaseLease: true,
						},
						dispatchClaim,
						producerFence,
					),
				);
				if (landed) dispatchClaim = undefined;
				return { adopted: false, reason, candidates };
			},
			terminal: async (result) => {
				const providerIds = uniqueSorted([
					...knownProviderIds,
					...(result.providerIds ?? []),
					...(result.providerId ? [result.providerId] : []),
				]);
				const possible = uniqueSorted([
					...knownPossibleLocalKeys(),
					...(known ? [verificationLocalResourceKey(input.kind, known)] : []),
					...providerIds.map(verificationProviderEncodingKey),
					...(result.possiblyCreatedKeys ?? []),
				]);
				const cleaned = uniqueSorted(
					result.cleanedResourceKeys ??
						(result.cleanupState === "CLEANED" ? possible : []),
				);
				const exactSetClosed =
					possible.length === cleaned.length &&
					possible.every((key, index) => key === cleaned[index]);
				const cleanupState: "CLEANED" | "UNRESOLVED" =
					result.cleanupState === "CLEANED" && !result.error && exactSetClosed
						? "CLEANED"
						: "UNRESOLVED";
				const terminalError =
					result.error ??
					(!exactSetClosed
						? "possibly-created and terminal-readback-and-cleaned sets differ"
						: undefined);
				await soft(`TERMINAL ${input.verificationKey}`, () =>
					write({
						eventType: "TERMINAL_READBACK",
						...closureUpdate(
							{
								verificationKey: input.verificationKey,
								requestSha256: input.requestSha256,
								candidates: knownCandidates,
							},
							{
								cleanupState,
								readback: result.readback,
								providerIds,
								possiblyCreatedKeys: possible,
								cleanedResourceKeys: cleaned,
							},
						),
						...(result.providerId !== undefined
							? { providerId: result.providerId }
							: {}),
						...(known ? { localId: known } : {}),
						sealedAt: new Date(now()),
						...(terminalError
							? { eventError: recordableError(terminalError) }
							: {}),
						...(cleanupState === "UNRESOLVED" && terminalError
							? { error: recordableError(terminalError) }
							: {}),
					}),
				);
			},
			localId: () => known,
		};
	};

	return {
		prepare: async (input) => {
			// HARD: no durable intent, no paid create.
			if (!producerFence) {
				throw new Error(
					"paid-resource intent prepare requires the reserved VerificationRun generation fence",
				);
			}
			const row = await store.create(
				{
					verificationRunId: options.verificationRunId,
					...input,
				},
				producerFence,
			);
			return handleFor(row.id, input);
		},

		teardown: async (resolvers) => {
			const lines: string[] = [];
			const rows = await store.listForRun(options.verificationRunId);
			for (const listedRow of rows) {
				let row = listedRow;
				const closed = verificationIntentsSealable([row]).sealable;
				if (closed) {
					lines.push(
						`${row.verificationKey}: ${row.state}/${row.cleanupState}${row.localId ? ` ${row.localId}` : ""}`,
					);
					continue;
				}
				let claim: IntentRecoveryClaim | null;
				try {
					claim = await store.claimForRecovery(
						row.id,
						{
							owner: recoveryOwner,
							now: new Date(now()),
							leaseMs: recoveryLeaseMs,
						},
						producerFence,
					);
				} catch (err) {
					lines.push(
						`${row.verificationKey}: recovery lease failed — ${recordableError(err)}`,
					);
					continue;
				}
				if (!claim) {
					lines.push(
						`${row.verificationKey}: recovery lease is held by another reconciler — not touched`,
					);
					continue;
				}
				// `rows` predates the recovery CAS. A SUBMITTED/capture write may
				// have won between that list and our claim. Only a fresh row read
				// under this live owner+generation lease may drive cleanup or the
				// PREPARED -> NEVER_CREATED decision.
				let claimedRow: IntentRow | undefined;
				try {
					claimedRow = (await store.listForRun(options.verificationRunId)).find(
						(candidate) => candidate.id === listedRow.id,
					);
				} catch (err) {
					lines.push(
						`${listedRow.verificationKey}: claimed-row refresh failed — ${recordableError(err)}`,
					);
					continue;
				}
				if (
					!claimedRow ||
					claimedRow.recoveryOwner !== claim.owner ||
					claimedRow.recoveryGeneration !== claim.generation ||
					!claimedRow.recoveryLeaseUntil ||
					claimedRow.recoveryLeaseUntil.getTime() <= now()
				) {
					lines.push(
						`${listedRow.verificationKey}: claimed-row refresh did not prove the live recovery fence — not touched`,
					);
					continue;
				}
				row = claimedRow;
				// Re-discover on every recovery, even when row.localId is populated.
				// A prior lookup may have persisted the wrong unique candidate while the
				// successful CREATE response id was only a cleanup possibility.
				let candidates: LocalCandidate[] = [];
				let lookupFailure: string | undefined;
				try {
					candidates = await lookup(
						row.kind,
						row.verificationKey,
						row.resourceName,
					);
				} catch (err) {
					lookupFailure = recordableError(err);
				}
				const exactKeyCandidates = candidates.filter((candidate) =>
					candidate.matchedBy.includes("key"),
				);
				const exactOwnedCandidates = exactKeyCandidates.filter(
					(candidate) => candidate.requestSha256 === row.requestSha256,
				);
				const conflictingExactCandidates = exactKeyCandidates.filter(
					(candidate) => candidate.requestSha256 !== row.requestSha256,
				);
				// A different-SHA exact-key row must never be adopted as this
				// request's evidence, but the key is still authoritative cleanup
				// ownership: it is the very resource that made the create route return
				// VERIFICATION_KEY_SHA_CONFLICT. Drive it terminal so a stale/running
				// paid resource cannot keep billing. Keep evidence-owned ids separate so
				// cleanup-only conflicts never become `localId` adoption evidence.
				let evidenceLocalIds = uniqueSorted([
					...localIdsFromPossibleKeys(row.kind, row.possiblyCreatedKeys),
					...(row.localId ? [row.localId] : []),
					...exactOwnedCandidates.map((candidate) => candidate.localId),
				]);
				let localIds = uniqueSorted([
					...evidenceLocalIds,
					...conflictingExactCandidates.map((candidate) => candidate.localId),
				]);

				// Preserve the legacy label/name fallback only when no stronger durable
				// or exact-key identity exists. Several weak candidates are never guessed.
				if (localIds.length === 0 && !lookupFailure) {
					const adoptable = adoptableCandidates(candidates, row.requestSha256);
					if (adoptable.length === 1) {
						evidenceLocalIds = [adoptable[0]?.localId as string];
						localIds = [...evidenceLocalIds];
					}
				}

				if (localIds.length === 0) {
					if (
						row.state === "PREPARED" &&
						candidates.length === 0 &&
						!lookupFailure
					) {
						// Never handed to the network: nothing can exist.
						await soft(`never-sent ${row.verificationKey}`, () =>
							store.update(
								row.id,
								{
									eventType: "NEVER_SENT_RECOVERY",
									...closureUpdate(
										{
											verificationKey: row.verificationKey,
											requestSha256: row.requestSha256,
											candidates: row.candidates,
										},
										{
											cleanupState: "NEVER_CREATED",
											readback: { neverSent: true, teardown: true },
											providerIds: [],
											possiblyCreatedKeys: [],
											cleanedResourceKeys: [],
										},
									),
									sealedAt: new Date(now()),
								},
								claim,
								producerFence,
							),
						);
						lines.push(
							`${row.verificationKey}: PREPARED and never sent — NEVER_CREATED`,
						);
						continue;
					}
					const adoptable = adoptableCandidates(candidates, row.requestSha256);
					const reason = lookupFailure
						? `marker lookup failed (${lookupFailure}) — the possible resource set is incomplete; operator action required`
						: candidates.length === 0
							? `${row.state} with no local row carrying its key or marker — the request left this process and may still land; operator action required`
							: adoptable.length === 0
								? `local rows carry the key or marker, but none carries request SHA ${row.requestSha256} (${describe(candidates)}) — operator action required`
								: `${adoptable.length} weak request-SHA-qualified local rows carry its marker (${describe(adoptable)}) — operator action required`;
					await soft(`unresolved ${row.verificationKey}`, () =>
						store.update(
							row.id,
							{
								eventType: "UNRESOLVED",
								state: row.state,
								cleanupState: "UNRESOLVED",
								candidates,
								error: reason,
								releaseLease: true,
							},
							claim,
							producerFence,
						),
					);
					lines.push(`${row.verificationKey}: UNRESOLVED — ${reason}`);
					continue;
				}

				const providerIdsKnownBeforeCleanup = uniqueSorted([
					...row.providerIds,
					...(row.providerId ? [row.providerId] : []),
					...exactKeyCandidates.flatMap((candidate) =>
						candidate.providerId ? [candidate.providerId] : [],
					),
				]);
				const possibleBeforeCleanup = uniqueSorted([
					...row.possiblyCreatedKeys,
					...localIds.map((localId) =>
						verificationLocalResourceKey(row.kind, localId),
					),
					...providerIdsKnownBeforeCleanup.map(verificationProviderEncodingKey),
				]);
				// Best-effort checkpoint of the complete discovered set before side
				// effects. Failure leaves the row open; cleanup still takes priority.
				await soft(`reconciliation set ${row.verificationKey}`, () =>
					store.update(
						row.id,
						{
							eventType: "RECONCILIATION_SET_CAPTURED",
							possiblyCreatedKeys: possibleBeforeCleanup,
							candidates,
						},
						claim,
						producerFence,
					),
				);

				const terminalInputs: IntentTerminalInput[] = [];
				for (const localId of localIds) {
					let result: IntentReadback;
					try {
						result = await resolvers[row.kind]({ ...row, localId });
					} catch (err) {
						result = {
							terminal: false,
							readback: null,
							error: err instanceof Error ? err.message : String(err),
						};
					}
					const resultProviderIds = uniqueSorted([
						...(result.providerIds ?? []),
						...(result.providerId ? [result.providerId] : []),
					]);
					const resultPossible = uniqueSorted([
						verificationLocalResourceKey(row.kind, localId),
						...resultProviderIds.map(verificationProviderEncodingKey),
						...(result.possiblyCreatedKeys ?? []),
					]);
					terminalInputs.push({
						cleanupState: result.terminal ? "CLEANED" : "UNRESOLVED",
						readback: result.readback,
						...(result.providerId !== undefined
							? { providerId: result.providerId }
							: {}),
						providerIds: resultProviderIds,
						possiblyCreatedKeys: resultPossible,
						cleanedResourceKeys: uniqueSorted(
							result.cleanedResourceKeys ??
								(result.terminal ? resultPossible : []),
						),
						...(result.error ? { error: result.error } : {}),
					});
				}
				const first = terminalInputs[0] as IntentTerminalInput;
				const merged = mergeIntentTerminalInputs(
					first,
					terminalInputs.slice(1),
				);
				const providerIds = uniqueSorted([
					...providerIdsKnownBeforeCleanup,
					...(merged.providerIds ?? []),
					...(merged.providerId ? [merged.providerId] : []),
				]);
				const possible = uniqueSorted([
					...possibleBeforeCleanup,
					...(merged.possiblyCreatedKeys ?? []),
					...providerIds.map(verificationProviderEncodingKey),
				]);
				const cleaned = uniqueSorted(merged.cleanedResourceKeys ?? []);
				const conflictingEvidenceCandidates = conflictingExactCandidates.filter(
					(candidate) => evidenceLocalIds.includes(candidate.localId),
				);
				const identityErrors = [
					...(lookupFailure ? [`marker lookup failed: ${lookupFailure}`] : []),
					...(conflictingEvidenceCandidates.length > 0
						? [
								`${conflictingEvidenceCandidates.length} evidence-owned exact-key candidate(s) carry a different request SHA`,
							]
						: []),
				];
				const exactSetClosed =
					possible.length === cleaned.length &&
					possible.every((key, index) => key === cleaned[index]);
				const cleanupState: "CLEANED" | "UNRESOLVED" =
					merged.cleanupState === "CLEANED" &&
					!merged.error &&
					identityErrors.length === 0 &&
					exactSetClosed
						? "CLEANED"
						: "UNRESOLVED";
				const terminalError = [
					...(merged.error ? [merged.error] : []),
					...identityErrors,
					...(!exactSetClosed
						? ["possibly-created and terminal-readback-and-cleaned sets differ"]
						: []),
				].join("; ");
				await soft(`TERMINAL ${row.verificationKey}`, () =>
					store.update(
						row.id,
						{
							eventType: "TERMINAL_READBACK",
							...closureUpdate(
								{
									verificationKey: row.verificationKey,
									requestSha256: row.requestSha256,
									candidates:
										candidates.length > 0 ? candidates : row.candidates,
								},
								{
									cleanupState,
									readback: merged.readback,
									providerIds,
									possiblyCreatedKeys: possible,
									cleanedResourceKeys: cleaned,
								},
							),
							...((row.localId ?? evidenceLocalIds[0])
								? { localId: row.localId ?? (evidenceLocalIds[0] as string) }
								: {}),
							providerId:
								row.providerId ??
								(evidenceLocalIds.length > 0
									? (merged.providerId ??
										(providerIds.length === 1 ? providerIds[0] : null))
									: null),
							sealedAt: new Date(now()),
							...(terminalError
								? { eventError: recordableError(terminalError) }
								: {}),
							...(cleanupState === "UNRESOLVED" && terminalError
								? { error: recordableError(terminalError) }
								: {}),
						},
						claim,
						producerFence,
					),
				);
				lines.push(
					`${row.verificationKey}: [${localIds.join(", ")}] → ${cleanupState}${terminalError ? ` (${terminalError})` : ""}${conflictingExactCandidates.length > 0 && conflictingEvidenceCandidates.length === 0 ? " (different-SHA exact-key resource cleaned without adoption)" : ""}`,
				);
			}
			// The seal reads the ROWS, not this loop's memory: a write that did
			// not land leaves the row open, and an open row must refuse the seal.
			const after = await store.listForRun(options.verificationRunId);
			const verdict = verificationIntentsSealable(after);
			return {
				sealable: verdict.sealable,
				unresolved: redactIntentDossier(verdict.unresolved),
				lines,
				dossier: redactIntentDossier(after),
			};
		},
	};
}

/** The Prisma adapter — thin, like `prismaRunRecordStore`. */
export function prismaIntentStore(prisma: AppPrismaClient): IntentStore {
	const json = (value: unknown) => value as Prisma.InputJsonValue;
	const assertProducerFence = async (
		tx: AppTransactionClient,
		fence: IntentProducerFence,
	): Promise<void> => {
		// Lock the parent first. Recovery claims the same row before touching child
		// intents, so one winner is established for the whole producer operation.
		const locked = await tx.$queryRaw<Array<{ id: string }>>`
			SELECT "id"
			FROM "VerificationRun"
			WHERE "id" = ${fence.verificationRunId}::uuid
			  AND "status" = 'RUNNING'
			  AND "recoveryGeneration" = ${fence.recoveryGeneration}
			  AND "recoveryOwner" IS NULL
			  AND "recoveryLeaseUntil" IS NULL
			FOR UPDATE
		`;
		if (locked.length !== 1) {
			throw new Error(
				"verification run producer fence changed; refusing paid-resource intent write",
			);
		}
	};
	const eventDetails = (data: IntentUpdate): Prisma.InputJsonValue =>
		json({
			...(data.localId !== undefined ? { localId: data.localId } : {}),
			...(data.providerIds !== undefined
				? { providerIds: uniqueSorted(data.providerIds) }
				: {}),
			...(data.possiblyCreatedKeys !== undefined
				? { possiblyCreatedKeys: uniqueSorted(data.possiblyCreatedKeys) }
				: {}),
			...(data.cleanedResourceKeys !== undefined
				? { cleanedResourceKeys: uniqueSorted(data.cleanedResourceKeys) }
				: {}),
			...(data.candidates !== undefined
				? { candidateCount: data.candidates.length }
				: {}),
			...(data.closureDigest !== undefined
				? { closureDigest: data.closureDigest }
				: {}),
			...(data.eventError !== undefined || typeof data.error === "string"
				? { error: recordableError(data.eventError ?? data.error) }
				: {}),
		});
	return {
		create: async (data, producerFence) =>
			prisma.$transaction(async (tx) => {
				if (producerFence.verificationRunId !== data.verificationRunId) {
					throw new Error(
						"verification run producer fence does not match the intent parent",
					);
				}
				await assertProducerFence(tx, producerFence);
				const row = await tx.verificationResourceIntent.create({
					data,
					select: { id: true },
				});
				await tx.verificationResourceIntentEvent.create({
					data: {
						verificationResourceIntentId: row.id,
						sequence: 0,
						eventType: "PREPARED",
						toState: "PREPARED",
						cleanupState: "PENDING",
						details: json({
							verificationKey: data.verificationKey,
							requestSha256: data.requestSha256,
							kind: data.kind,
							scenario: data.scenario,
						}),
					},
				});
				return row;
			}),
		claimForRecovery: async (id, input, producerFence) =>
			prisma.$transaction(async (tx) => {
				if (producerFence) await assertProducerFence(tx, producerFence);
				const current = await tx.verificationResourceIntent.findUniqueOrThrow({
					where: { id },
					select: {
						eventSeq: true,
						state: true,
						cleanupState: true,
						recoveryOwner: true,
						recoveryLeaseUntil: true,
						recoveryGeneration: true,
					},
				});
				// CLEANED/NEVER_CREATED are absorbing. Historical TERMINAL/UNRESOLVED
				// rows are deliberately reclaimable so a resource that became visible
				// after the first empty lookup can still be found and stopped.
				if (
					current.state === "TERMINAL" &&
					current.cleanupState !== "UNRESOLVED"
				) {
					return null;
				}
				const leaseUntil = new Date(input.now.getTime() + input.leaseMs);
				const generation = current.recoveryGeneration + 1;
				const sequence = current.eventSeq + 1;
				const won = await tx.verificationResourceIntent.updateMany({
					where: {
						id,
						eventSeq: current.eventSeq,
						recoveryGeneration: current.recoveryGeneration,
						OR: [
							{ recoveryOwner: input.owner },
							{ recoveryLeaseUntil: null },
							{ recoveryLeaseUntil: { lte: input.now } },
						],
					},
					data: {
						recoveryOwner: input.owner,
						recoveryLeaseUntil: leaseUntil,
						recoveryGeneration: { increment: 1 },
						eventSeq: { increment: 1 },
					},
				});
				if (won.count !== 1) return null;
				await tx.verificationResourceIntentEvent.create({
					data: {
						verificationResourceIntentId: id,
						sequence,
						eventType: "RECOVERY_CLAIMED",
						fromState: current.state,
						toState: current.state,
						details: json({
							owner: input.owner,
							generation,
							leaseUntil: leaseUntil.toISOString(),
						}),
					},
				});
				return { owner: input.owner, generation, leaseUntil };
			}),
		update: async (id, data, claim, producerFence) => {
			const {
				eventType = "UPDATED",
				dispatchLease,
				releaseLease,
				candidates,
				readback,
				providerIds,
				possiblyCreatedKeys,
				cleanedResourceKeys,
				eventError: _eventError,
				...scalars
			} = data;
			return prisma.$transaction(async (tx) => {
				const writeAt = new Date();
				if (producerFence) {
					await assertProducerFence(tx, producerFence);
				} else if (!claim) {
					throw new Error(
						"ordinary intent writes require the reserved VerificationRun producer fence",
					);
				}
				const current = await tx.verificationResourceIntent.findUniqueOrThrow({
					where: { id },
					select: {
						eventSeq: true,
						state: true,
						cleanupState: true,
						recoveryOwner: true,
						recoveryLeaseUntil: true,
						recoveryGeneration: true,
					},
				});
				if (
					current.state === "TERMINAL" &&
					data.state !== "TERMINAL" &&
					!(claim && current.cleanupState === "UNRESOLVED")
				) {
					throw new Error(
						`intent ${id} is TERMINAL and cannot regress to ${data.state ?? "a mutable non-terminal update"}`,
					);
				}
				if (dispatchLease && claim) {
					throw new Error(
						"a dispatch lease cannot be acquired under another lease",
					);
				}
				const nextSequence = current.eventSeq + 1;
				const dispatchLeaseUntil = dispatchLease
					? new Date(dispatchLease.now.getTime() + dispatchLease.leaseMs)
					: undefined;
				const dispatchGeneration = dispatchLease
					? current.recoveryGeneration + 1
					: undefined;
				const updated = await tx.verificationResourceIntent.updateMany({
					where: {
						id,
						eventSeq: current.eventSeq,
						...(dispatchLease
							? {
									state: "PREPARED",
									recoveryGeneration: current.recoveryGeneration,
									OR: [
										{ recoveryLeaseUntil: null },
										{ recoveryLeaseUntil: { lte: dispatchLease.now } },
									],
								}
							: claim
								? {
										recoveryOwner: claim.owner,
										recoveryGeneration: claim.generation,
										recoveryLeaseUntil: { gt: writeAt },
									}
								: {
										// An explicit restart recovery owns the row until its
										// lease expires. Fence the original process too: it may
										// have resumed after the operator started recovery, and
										// eventSeq alone would then let the two alternate writes.
										OR: [
											{ recoveryLeaseUntil: null },
											{ recoveryLeaseUntil: { lte: writeAt } },
										],
									}),
					},
					data: {
						...scalars,
						eventSeq: { increment: 1 },
						...(dispatchLease
							? {
									recoveryOwner: dispatchLease.owner,
									recoveryLeaseUntil: dispatchLeaseUntil,
									recoveryGeneration: { increment: 1 },
								}
							: {}),
						...(providerIds !== undefined
							? { providerIds: uniqueSorted(providerIds) }
							: {}),
						...(possiblyCreatedKeys !== undefined
							? { possiblyCreatedKeys: uniqueSorted(possiblyCreatedKeys) }
							: {}),
						...(cleanedResourceKeys !== undefined
							? { cleanedResourceKeys: uniqueSorted(cleanedResourceKeys) }
							: {}),
						...(candidates !== undefined
							? { candidates: json(candidates) }
							: {}),
						...(readback !== undefined ? { readback: json(readback) } : {}),
						...(data.state === "TERMINAL" || releaseLease
							? { recoveryOwner: null, recoveryLeaseUntil: null }
							: {}),
					},
				});
				if (updated.count !== 1) {
					throw new Error(
						`intent ${id} changed concurrently; retry from authority`,
					);
				}
				await tx.verificationResourceIntentEvent.create({
					data: {
						verificationResourceIntentId: id,
						sequence: nextSequence,
						eventType,
						fromState: current.state,
						toState: data.state ?? current.state,
						cleanupState: data.cleanupState,
						details: eventDetails(data),
					},
				});
				return {
					id,
					eventSeq: nextSequence,
					...(dispatchLease &&
					dispatchLeaseUntil &&
					dispatchGeneration !== undefined
						? {
								claim: {
									owner: dispatchLease.owner,
									generation: dispatchGeneration,
									leaseUntil: dispatchLeaseUntil,
								},
							}
						: {}),
				};
			});
		},
		listForRun: async (verificationRunId) =>
			(
				await prisma.verificationResourceIntent.findMany({
					where: { verificationRunId },
					orderBy: [{ createdAt: "asc" }, { id: "asc" }],
					select: {
						id: true,
						scenario: true,
						kind: true,
						verificationKey: true,
						requestSha256: true,
						resourceName: true,
						state: true,
						localId: true,
						providerId: true,
						providerIds: true,
						candidates: true,
						cleanupState: true,
						readback: true,
						possiblyCreatedKeys: true,
						cleanedResourceKeys: true,
						closureDigest: true,
						error: true,
						recoveryOwner: true,
						recoveryLeaseUntil: true,
						recoveryGeneration: true,
						events: {
							orderBy: { sequence: "asc" },
							select: {
								sequence: true,
								eventType: true,
								fromState: true,
								toState: true,
								cleanupState: true,
								details: true,
								createdAt: true,
							},
						},
					},
				})
			).map((row) => ({
				...row,
				candidates: Array.isArray(row.candidates)
					? (row.candidates as LocalCandidate[])
					: null,
				kind: row.kind as VerificationIntentKind,
				state: row.state as VerificationIntentState,
				cleanupState: row.cleanupState as VerificationIntentCleanupState,
			})),
		findLocal: async (kind, marker) => {
			if (kind === "VOD_JOB") {
				const select = {
					id: true,
					status: true,
					bitmovinEncodingId: true,
					verificationKey: true,
					verificationRequestSha256: true,
					labels: true,
					name: true,
				} as const;
				const weakMarkers = [
					...(marker.label ? [{ labels: { has: marker.label } }] : []),
					...(marker.name ? [{ name: marker.name }] : []),
				];
				const [exact, weakRows] = await Promise.all([
					prisma.encodingJob.findUnique({
						where: { verificationKey: marker.verificationKey },
						select,
					}),
					weakMarkers.length > 0
						? prisma.encodingJob.findMany({
								where: { OR: weakMarkers },
								select,
								take: 10,
							})
						: Promise.resolve([]),
				]);
				const rows = [...(exact ? [exact] : []), ...weakRows];
				return rows.map((row) => ({
					localId: row.id,
					matchedBy: [
						...(row.verificationKey === marker.verificationKey
							? (["key"] as const)
							: []),
						...(marker.label && row.labels.includes(marker.label)
							? (["label"] as const)
							: []),
						...(marker.name && row.name === marker.name
							? (["name"] as const)
							: []),
					],
					status: String(row.status),
					providerId: row.bitmovinEncodingId,
					requestSha256: row.verificationRequestSha256,
				}));
			}
			const select = {
				id: true,
				status: true,
				bitmovinEncodingId: true,
				verificationKey: true,
				verificationRequestSha256: true,
				name: true,
			} as const;
			const [exact, weakRows] = await Promise.all([
				prisma.liveChannel.findUnique({
					where: { verificationKey: marker.verificationKey },
					select,
				}),
				marker.name
					? prisma.liveChannel.findMany({
							where: { name: marker.name },
							select,
							take: 10,
						})
					: Promise.resolve([]),
			]);
			const rows = [...(exact ? [exact] : []), ...weakRows];
			return rows.map((row) => ({
				localId: row.id,
				matchedBy: [
					...(row.verificationKey === marker.verificationKey
						? (["key"] as const)
						: []),
					...(marker.name && row.name === marker.name
						? (["name"] as const)
						: []),
				],
				status: String(row.status),
				providerId: row.bitmovinEncodingId,
				requestSha256: row.verificationRequestSha256,
			}));
		},
	};
}
