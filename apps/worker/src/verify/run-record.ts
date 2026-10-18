import { createHash } from "node:crypto";
import {
	hashApiTokenSecret,
	LIVE_EVIDENCE_VERSION,
	type LiveEvidenceLeg,
	type LiveEvidenceSummary,
	liveEvidenceSupportsPass,
	REDACTED,
	redactSecrets,
	summarizeLiveEvidence,
	verificationRunKind,
} from "@bitovp/core";
import type { AppPrismaClient, Prisma } from "@bitovp/db";
import { evidenceValuesEqual, validateReportEnvelope } from "./resume-evidence";

type RecoveryIntentEvidence = {
	recoveryOwner: string | null;
	events?: Array<{ eventType: string; details: unknown }>;
};

/** Use one projection for both the portable report and the seal-time DB read. */
export function redactIntentDossier<T extends RecoveryIntentEvidence>(
	rows: readonly T[],
): T[] {
	return rows.map((row) => ({
		...row,
		recoveryOwner: row.recoveryOwner === null ? null : REDACTED,
		...(row.events
			? {
					events: row.events.map((event) => {
						if (
							event.eventType !== "RECOVERY_CLAIMED" ||
							event.details === null ||
							typeof event.details !== "object" ||
							Array.isArray(event.details) ||
							typeof (event.details as { owner?: unknown }).owner !== "string"
						) {
							return event;
						}
						return {
							...event,
							details: {
								...(event.details as Record<string, unknown>),
								owner: REDACTED,
							},
						};
					}),
				}
			: {}),
	})) as T[];
}

/**
 * The durable half of a verification run (re-audit 2026-08-29 HIGH-7, GO 11).
 *
 * `runVerification` already produced every fact a release decision needs — the
 * commit and schema it ran against, the bytes of the source it read, the
 * provider account it billed, a verdict and a plan digest per scenario, the
 * provider's own word on every abandoned encoding, and a sealed report. All of
 * it lived in `verify-runs/<runId>/` on one operator's disk. The audit's
 * exact-id readbacks therefore could not be re-run from the Dashboard once the
 * session ended, which is what "release evidence cannot be durably
 * reconstructed" means. This module writes the same facts to a row.
 *
 * It is a separate module, behind a two-method store, for one reason:
 * `runVerification` needs a database, credentials, a product and a bucket, so
 * no test invokes it (harness-rails.test.ts records the same gap for the rules
 * it pins). The BEHAVIOUR — what is written, when, and what a duplicate run id
 * does — is therefore unit-tested here against a fake store, and the runner's
 * five call sites are pinned by shape next door.
 */

/** A ScenarioOutcome as the report carries it; kept structural so this module
 *  imposes no import cycle on `runner.ts`, which owns the real type. */
export type RecordedOutcome = {
	scenario: string;
	verdict: string;
	sourceObject?: string | undefined;
	sourceIdentity?: string | undefined;
	[key: string]: unknown;
};

/** What `ensureTerminal` returned about one job the run abandoned. */
export type CleanupInput = {
	scenario: string;
	jobId: string;
	status: string;
	cancelHttp: number;
	terminal: boolean;
	localTerminal: boolean;
	providerTerminal: boolean | "unread";
	/** Absent when the provider was never read (`providerTerminal: "unread"`). */
	provider?: readonly { encodingId: string; status: string }[];
};

/**
 * The stored shape. The provider STATUSES move to `providerReadback`, keyed by
 * encoding id, and only the join keys stay here — one status value in one
 * place, so the two columns can never disagree about what the provider said.
 */
export type CleanupEntry = Omit<CleanupInput, "provider"> & {
	encodingIds: string[];
};

export type RunRecordCreate = {
	runId: string;
	startedAt: Date;
	reportPath: string;
	baseUrlOrigin?: string;
	actor?: string;
	sourceObject?: string;
};

export type RunRecordUpdate = {
	kind?: string | null;
	resumedFromId?: string;
	resumeDecision?: Record<string, unknown>;
	status?: string;
	finishedAt?: Date;
	commit?: string;
	checkoutLatestMigration?: string;
	dbLatestMigration?: string;
	drift?: boolean;
	bitmovinAccountId?: string | null;
	sourceIdentity?: string;
	outcomes?: readonly RecordedOutcome[];
	counts?: Record<string, number>;
	providerReadback?: Record<string, string>;
	cleanup?: readonly CleanupEntry[];
	reportJson?: string;
	reportMarkdown?: string;
	reportSha256?: string;
	seal?: string;
	sealAlgorithm?: string;
	sealKeyId?: string | null;
	evidenceVersion?: number;
	evidenceManifest?: Record<string, unknown>;
	retentionUntil?: Date;
	sealedAt?: Date;
	error?: string;
};

/**
 * The two writes this feature needs, plus the actor lookup — narrow on
 * purpose, so the tests drive real behaviour rather than a Prisma mock.
 */
/** One VerificationLiveEvidence row, as the store writes it (EV-02). */
export type LiveEvidenceRow = {
	verificationRunId: string;
	scenario: string;
	liveChannelRunId: string;
	outputLeg: string;
	version: number;
	complete: boolean;
	missing: string[];
	tuple: LiveEvidenceLeg;
};

export type RunRecordStore = {
	create: (
		data: RunRecordCreate,
	) => Promise<{ id: string; recoveryGeneration: number }>;
	update: (id: string, data: RunRecordUpdate) => Promise<unknown>;
	/** Final generation/status CAS. False means restart recovery owns the run. */
	seal: (
		id: string,
		expectedRecoveryGeneration: number,
		data: RunRecordUpdate,
		expectedResourceIntents: readonly unknown[],
	) => Promise<boolean>;
	/** Failure demotion CAS; false means SEALED/recovery authority already won. */
	fail: (
		id: string,
		expectedRecoveryGeneration: number,
		data: RunRecordUpdate,
	) => Promise<boolean>;
	/** `token:<id>` for the runner's own API token, or null. */
	actorForToken?: (secret: string) => Promise<string | null>;
	/**
	 * The Live/MSL evidence tuples, one child row per output leg, upserted on
	 * (run, scenario, airing, leg).
	 */
	upsertLiveEvidence?: (rows: readonly LiveEvidenceRow[]) => Promise<unknown>;
};

export type RunSealInput = {
	reportJson: string;
	reportMarkdown: string;
	seal: string;
	sealAlgorithm: "SHA256" | "HMAC_SHA256";
	sealKeyId: string | null;
	/** Runtime-only key material used to verify HMAC before the SEALED CAS. */
	sealKey?: string;
	evidenceVersion: number;
	evidenceManifest: Record<string, unknown>;
	retentionUntil: string;
	outcomes: readonly RecordedOutcome[];
	counts: Record<string, number>;
	resourceIntents: readonly unknown[];
	finishedAt: string;
};

/** Prisma's unique-violation code — the reservation's refusal. */
const UNIQUE_VIOLATION = "P2002";

/** The outcome's own evidence summary, when it carries one of the right shape. */
function isLiveEvidenceSummary(value: unknown): value is LiveEvidenceSummary {
	return (
		typeof value === "object" &&
		value !== null &&
		"version" in value &&
		"legs" in value &&
		Array.isArray((value as { legs?: unknown }).legs)
	);
}

function isUniqueViolation(err: unknown): boolean {
	return (err as { code?: unknown })?.code === UNIQUE_VIOLATION;
}

export type RunRecorder = {
	/**
	 * Claim the run id, before anything is spent. Throws on a duplicate: the
	 * run-directory check is one host's disk, this is every host that shares
	 * the database.
	 */
	reserve: (input: {
		runId: string;
		startedAt: string;
		reportPath: string;
		baseUrl?: string;
		apiToken?: string;
		sourceObject?: string;
	}) => Promise<void>;
	/** What the run turned out to be, once preflight and the fingerprint say. */
	context: (input: {
		/** Exact selected scenario identities; names make LIVE classification durable. */
		scenarios: readonly { name: string; kind: string }[];
		fingerprint: {
			commit: string;
			checkoutLatestMigration: string;
			dbLatestMigration: string;
			drift: boolean;
		};
		bitmovinAccountId?: string | null;
	}) => Promise<void>;
	/** Persist the pre-spend resume decision; an accepted decision is a hard write. */
	resumeDecision: (input: {
		decision: "ACCEPTED" | "REFUSED";
		reason: string;
		priorRowId?: string;
		[key: string]: unknown;
	}) => Promise<void>;
	/** One finished scenario. Partial evidence beats none when a run crashes. */
	outcome: (outcome: RecordedOutcome) => Promise<void>;
	/** One abandoned job driven terminal, with the provider's word on it. */
	cleanup: (entry: CleanupInput) => Promise<void>;
	/**
	 * One live scenario's evidence legs, as it completes (EV-02). Written as
	 * child rows; the seal later refuses SEALED for any green live outcome
	 * whose legs are not all complete.
	 */
	liveEvidence: (input: {
		scenario: string;
		legs: readonly LiveEvidenceLeg[];
	}) => Promise<void>;
	/** Read-only seal gate. It validates durable tuple invariants without writing SEALED. */
	preseal: (input: RunSealInput) => Promise<void>;
	/** Final atomic DB commit for the exact report bytes before local exports. */
	sealed: (input: RunSealInput) => Promise<void>;
	/** The run threw before it sealed anything. */
	failed: (err: unknown) => Promise<void>;
	/** The row's id once reserved — null before, and after a refused reservation. */
	rowId: () => string | null;
	/** Exact parent generation paid-intent producers must fence on. */
	producerFence: () => {
		verificationRunId: string;
		recoveryGeneration: number;
	} | null;
};

/**
 * Origin ONLY. `baseUrlPolicy` has already refused a URL that would carry the
 * credential in the clear, but a base URL can still hold a path or a query, and
 * an evidence row is the last place to start keeping strings nobody audited.
 */
export function originOf(baseUrl: string | undefined): string | undefined {
	if (!baseUrl) {
		return undefined;
	}
	try {
		return new URL(baseUrl).origin;
	} catch {
		return undefined;
	}
}

/**
 * A presented Bearer credential, and a bare `bo_` API-token secret.
 *
 * `redactSecrets` is a KEY-aware walker: over a bare STRING it can only strip
 * URL userinfo, because there is no key to recognise. The runner's own errors
 * are strings — a failed `fetch` can carry the request it attempted, and the
 * runner sends its token as `Authorization: Bearer <secret>` — so an
 * INCOMPLETE row is one unlucky error message away from storing a live
 * credential. Scrubbed HERE rather than in core: this is a fact about how the
 * harness authenticates, not about JSON payloads generally, and widening the
 * shared redactor to match token-shaped substrings everywhere would mangle
 * legitimate data for the same reason its header-tuple rule is narrow.
 *
 * Both spellings, because the secret can appear with or without its scheme.
 * The `bo_` shape is `TOKEN_SHAPE`'s alphabet in the web auth layer: 43
 * base64url characters. A wider pattern is not worth it — a value this does
 * not match is not a token, and over-matching would redact scenario names.
 */
const BEARER_CREDENTIAL = /(bearer\s+)[\w.~+/=-]+/gi;
const BARE_API_TOKEN = /\bbo_[A-Za-z0-9_-]{43}\b/g;

/** Redacted and bounded — an error string can embed a request URL or a token. */
export function recordableError(err: unknown): string {
	const raw = err instanceof Error ? err.message : String(err);
	return redactSecrets(raw)
		.replace(BEARER_CREDENTIAL, `$1${REDACTED}`)
		.replace(BARE_API_TOKEN, REDACTED)
		.slice(0, 500);
}

/**
 * How many times the SEAL write is attempted before it gives up, and how long
 * it waits between attempts.
 *
 * Only the seal retries. Every other write happens while the encoder is still
 * spending, so its failure is survivable and losing it costs a progress
 * update. The seal is different in kind: by the time it runs, the exact
 * report bytes are staged and NOTHING is being spent any more, so a single
 * transient failure would leave the row RUNNING forever over a run
 * that finished perfectly — the HIGH-7 gap in miniature, on the one write that
 * closes it (review of PR #345). Short and bounded: three attempts is enough
 * for a dropped connection or a lock timeout, and a run must never hang on its
 * bookkeeping.
 */
export const SEAL_WRITE_ATTEMPTS = 3;
export const SEAL_WRITE_BACKOFF_MS = [250, 1000] as const;

export function createRunRecorder(
	store: RunRecordStore,
	options: {
		log?: (line: string) => void;
		/** Injected so the retry can be tested without waiting for it. */
		sleep?: (ms: number) => Promise<void>;
	} = {},
): RunRecorder {
	const log = options.log ?? (() => {});
	const sleep =
		options.sleep ??
		((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
	let id: string | null = null;
	let reservedRunId: string | null = null;
	let recoveryGeneration: number | null = null;
	/**
	 * Every write is a whole-column rewrite of an accumulator, and scenarios
	 * finish CONCURRENTLY (`pooled(runnable, config.concurrency, …)`). Two
	 * updates in flight would each carry the array as it looked when they
	 * started, so the later one would silently drop the earlier one's outcome.
	 * One chain, therefore — the writes are tiny and off the spend path.
	 */
	let queue: Promise<unknown> = Promise.resolve();
	const outcomes: RecordedOutcome[] = [];
	const cleanups: CleanupEntry[] = [];
	const providerReadback: Record<string, string> = {};
	/** Per scenario, the evidence summary the recorder itself wrote (EV-02). */
	const liveEvidenceByScenario = new Map<string, LiveEvidenceSummary>();
	/**
	 * Names selected as LIVE before spend. Outcome shape is not an identity:
	 * an early harness failure can lose both `liveCleanup` and `liveEvidence`,
	 * and must still never be mistaken for VOD at the parent seal.
	 */
	const liveScenarioNames = new Set<string>();
	let sourceObject: string | undefined;
	let sourceIdentity: string | undefined;
	/**
	 * True ONLY once the SEALED row write has DURABLY landed — never before the
	 * write, never on a swallowed failure. It is the
	 * short-circuit both a re-seal and a post-seal `failed` read: once the
	 * evidence really says SEALED, a later throw is not this row's story.
	 */
	let sealedAlready = false;

	/**
	 * Runs one row write through the serialized queue, retrying up to
	 * `attempts` times, and RESOLVES to whether it DURABLY LANDED — `true`
	 * only when a `write` actually succeeded. It never rejects: a write
	 * failure is a value the caller decides on, not an exception that could
	 * poison the queue for the next write.
	 *
	 * Most callers ignore the result. Past the reservation the encoder is
	 * already spending, so a lost progress update is LOUD and survivable: the
	 * row stays RUNNING, and this model documents a stale RUNNING row as
	 * exactly that — a run that never sealed. The SEAL is the one write whose
	 * all-retries failure is NOT survivable, and `sealed` reads this boolean to
	 * refuse to claim SEALED without a durable write
: before this returned that fact, the seal write was swallowed
	 * like any other, so an all-fail write left the row RUNNING while the CLI
	 * finished "successfully" — a release gate got different answers from the
	 * exit code and the Dashboard row.
	 *
	 * `attempts` is how many times ONE write may be retried before that
	 * reading is allowed to stand. It is 1 for every write except the seal —
	 * see SEAL_WRITE_ATTEMPTS for why the last write is the one that earns a
	 * retry.
	 */
	const soft = (
		what: string,
		write: () => Promise<unknown>,
		attempts = 1,
	): Promise<boolean> => {
		const run = queue.then(async (): Promise<boolean> => {
			if (!id) {
				return false;
			}
			for (let attempt = 1; attempt <= attempts; attempt += 1) {
				try {
					await write();
					return true;
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					if (attempt === attempts) {
						log(
							`[verify] could not record ${what} on the verification run row: ${message}`,
						);
						return false;
					}
					log(
						`[verify] could not record ${what} on the verification run row (attempt ${attempt} of ${attempts}): ${message}`,
					);
					await sleep(
						SEAL_WRITE_BACKOFF_MS[attempt - 1] ??
							(SEAL_WRITE_BACKOFF_MS.at(-1) as number),
					);
				}
			}
			return false;
		});
		// The next write chains on this one; both the caller and the queue read
		// the SAME settled promise, which only ever resolves (to a boolean).
		queue = run;
		return run;
	};

	const counted = (
		rows: readonly RecordedOutcome[],
	): Record<string, number> => {
		const counts: Record<string, number> = {};
		for (const row of rows) {
			counts[row.verdict] = (counts[row.verdict] ?? 0) + 1;
		}
		return counts;
	};

	/**
	 * Pure/read-only half of the seal transition. The same validation runs both
	 * before filesystem publication and immediately before the final DB write.
	 * `liveEvidenceByScenario` is populated only after the child-row upsert has
	 * durably completed, so it is a receipt for the tuples, not an optimistic
	 * in-memory projection.
	 */
	const validateSealInput = (input: RunSealInput): void => {
		if (!id) {
			throw new Error("cannot seal a verification run before reserving it");
		}
		const envelope = validateReportEnvelope({
			reportJson: input.reportJson,
			reportMarkdown: input.reportMarkdown,
			seal: input.seal,
			sealAlgorithm: input.sealAlgorithm,
			sealKeyId: input.sealKeyId,
			...(input.sealKey ? { sealKey: input.sealKey } : {}),
			evidenceVersion: input.evidenceVersion,
			evidenceManifest: input.evidenceManifest,
			retentionUntil: input.retentionUntil,
			outcomes: input.outcomes,
			counts: input.counts,
			resourceIntents: input.resourceIntents,
			...(reservedRunId ? { expectedRunId: reservedRunId } : {}),
			expectedFinishedAt: input.finishedAt,
		});
		if (!envelope.ok) {
			throw new Error(
				`refusing to seal the verification run (${envelope.code}): ${envelope.reason}`,
			);
		}
		for (const outcome of input.outcomes) {
			const own = outcome.liveEvidence;
			const ownSummary = isLiveEvidenceSummary(own) ? own : undefined;
			const summary = liveEvidenceByScenario.get(outcome.scenario);
			const isLive =
				liveScenarioNames.has(outcome.scenario) ||
				summary !== undefined ||
				outcome.liveCleanup !== undefined ||
				ownSummary !== undefined;
			if (!isLive) {
				continue;
			}
			if (!summary && ownSummary) {
				throw new Error(
					`refusing to seal the verification run: live scenario ${outcome.scenario} has no durably persisted live evidence tuple`,
				);
			}
			if (summary) {
				const gate = liveEvidenceSupportsPass(summary);
				if (!gate.ok) {
					throw new Error(
						`refusing to seal the verification run: live scenario ${outcome.scenario} has an incomplete evidence tuple — ${gate.reason}`,
					);
				}
				if (
					ownSummary &&
					JSON.stringify(ownSummary) !== JSON.stringify(summary)
				) {
					throw new Error(
						`refusing to seal the verification run: live scenario ${outcome.scenario} outcome summary does not match its durably persisted tuple`,
					);
				}
			}
			if (
				!summary &&
				(outcome.verdict === "PASS" || outcome.verdict === "WARN")
			) {
				throw new Error(
					`refusing to seal the verification run: live scenario ${outcome.scenario} is ${outcome.verdict} with no durably persisted live evidence tuple`,
				);
			}
		}
	};

	return {
		rowId: () => id,
		producerFence: () =>
			id !== null && recoveryGeneration !== null
				? { verificationRunId: id, recoveryGeneration }
				: null,

		reserve: async (input) => {
			sourceObject = input.sourceObject;
			let actor: string | undefined;
			if (input.apiToken && store.actorForToken) {
				try {
					actor = (await store.actorForToken(input.apiToken)) ?? undefined;
				} catch {
					// An unattributable run is still a run; the token never
					// reaches a log or a column either way.
				}
			}
			const origin = originOf(input.baseUrl);
			try {
				const row = await store.create({
					runId: input.runId,
					startedAt: new Date(input.startedAt),
					reportPath: input.reportPath,
					...(origin ? { baseUrlOrigin: origin } : {}),
					...(actor ? { actor } : {}),
					...(input.sourceObject ? { sourceObject: input.sourceObject } : {}),
				});
				id = row.id;
				reservedRunId = input.runId;
				recoveryGeneration = row.recoveryGeneration;
			} catch (err) {
				if (isUniqueViolation(err)) {
					throw new Error(
						`run id ${input.runId} is already reserved in the database — another host is running it, or it already ran; pick a fresh --run-id (use --resume-from <prior report.json> to honour prior PASSes)`,
					);
				}
				throw err;
			}
		},

		context: async (input) => {
			liveScenarioNames.clear();
			for (const scenario of input.scenarios) {
				if (scenario.kind === "LIVE") {
					liveScenarioNames.add(scenario.name);
				}
			}
			await soft("the run's fingerprint", () =>
				store.update(id as string, {
					kind: verificationRunKind(input.scenarios.map((s) => s.kind)),
					commit: input.fingerprint.commit,
					checkoutLatestMigration: input.fingerprint.checkoutLatestMigration,
					dbLatestMigration: input.fingerprint.dbLatestMigration,
					drift: input.fingerprint.drift,
					bitmovinAccountId: input.bitmovinAccountId ?? null,
				}),
			);
		},

		resumeDecision: async (input) => {
			if (!id) {
				throw new Error(
					"cannot record a resume decision before reserving the run",
				);
			}
			if (input.decision === "ACCEPTED" && !input.priorRowId) {
				throw new Error(
					"cannot accept resume evidence without a formal prior VerificationRun relation",
				);
			}
			const { priorRowId, ...decision } = input;
			const write = queue.then(() =>
				store.update(id as string, {
					resumeDecision: decision,
					...(input.decision === "ACCEPTED" && priorRowId
						? { resumedFromId: priorRowId }
						: {}),
				}),
			);
			queue = write.catch(() => undefined);
			await write;
		},

		outcome: async (outcome) => {
			outcomes.push(outcome);
			/**
			 * The run-level source identity, taken from the first scenario that
			 * actually read the run's staged mezzanine. It is not declared
			 * anywhere earlier: the HEAD happens per scenario, inside the
			 * rewrite, so this is the only place the run learns what bytes it
			 * was reading (the staged-source identity rule).
			 */
			if (
				sourceIdentity === undefined &&
				outcome.sourceIdentity !== undefined &&
				outcome.sourceObject === sourceObject
			) {
				sourceIdentity = outcome.sourceIdentity;
			}
			await soft(`scenario ${outcome.scenario}`, () =>
				store.update(id as string, {
					outcomes: [...outcomes],
					counts: counted(outcomes),
					...(sourceIdentity !== undefined ? { sourceIdentity } : {}),
				}),
			);
		},

		cleanup: async (input) => {
			const { provider, ...rest } = input;
			for (const status of provider ?? []) {
				providerReadback[status.encodingId] = status.status;
			}
			cleanups.push({
				...rest,
				encodingIds: (provider ?? []).map((p) => p.encodingId),
			});
			await soft(`cleanup for ${input.scenario}`, () =>
				store.update(id as string, {
					cleanup: [...cleanups],
					providerReadback: { ...providerReadback },
				}),
			);
		},

		liveEvidence: async (input) => {
			if (!store.upsertLiveEvidence || !id) {
				throw new Error(
					`cannot record live scenario ${input.scenario}: no durable live evidence store is available`,
				);
			}
			const runId = id;
			const rows: LiveEvidenceRow[] = input.legs.map((leg) => ({
				verificationRunId: runId,
				scenario: input.scenario,
				// The unique key needs a value; an unidentified airing is named
				// "unknown" here and as a missing element inside the tuple.
				liveChannelRunId: leg.channel.liveChannelRunId ?? "unknown",
				outputLeg: leg.outputLeg,
				version: LIVE_EVIDENCE_VERSION,
				complete: leg.complete,
				missing: leg.missing,
				tuple: leg,
			}));
			const write = store.upsertLiveEvidence;
			// Evidence rows are not a best-effort progress update: they are what the
			// parent SEALED claim rests on. Serialize them with the other writes, but
			// propagate failure and remember the summary only AFTER the DB commit.
			const durable = queue.then(async () => {
				await write(rows);
				liveEvidenceByScenario.set(
					input.scenario,
					summarizeLiveEvidence(input.legs),
				);
			});
			queue = durable.catch(() => undefined);
			await durable;
		},

		preseal: async (input) => {
			if (sealedAlready) return;
			// Drain the serialized record queue without changing the row, then gate
			// the exact bytes/tuple population that the final write will receive.
			await queue;
			validateSealInput(input);
		},

		sealed: async (input) => {
			if (sealedAlready) {
				// A genuine re-seal of an already-durably-sealed run is a no-op
				// success: never a second write, never a hard failure.
				return;
			}
			await queue;
			validateSealInput(input);
			const durable = await soft(
				"the sealed report",
				async () => {
					if (recoveryGeneration === null) {
						throw new Error(
							"verification run has no reserved recovery generation",
						);
					}
					const landed = await store.seal(
						id as string,
						recoveryGeneration,
						{
							status: "SEALED",
							// The REPORT's outcomes, not the accumulator's: the report
							// also covers the scenarios preflight blocked, and the row
							// must say exactly what the sealed bytes say.
							outcomes: input.outcomes,
							counts: input.counts,
							// Exact authoritative bytes, committed atomically with SEALED.
							// Local report files are exports which can be rebuilt from these.
							reportJson: input.reportJson,
							reportMarkdown: input.reportMarkdown,
							reportSha256: createHash("sha256")
								.update(input.reportJson)
								.digest("hex"),
							seal: input.seal.trim(),
							sealAlgorithm: input.sealAlgorithm,
							sealKeyId: input.sealKeyId,
							evidenceVersion: input.evidenceVersion,
							evidenceManifest: input.evidenceManifest,
							retentionUntil: new Date(input.retentionUntil),
							sealedAt: new Date(),
							finishedAt: new Date(input.finishedAt),
							...(sourceIdentity !== undefined ? { sourceIdentity } : {}),
						},
						input.resourceIntents,
					);
					if (!landed) {
						throw new Error(
							"verification run recovery generation changed; restart recovery fenced this producer",
						);
					}
				},
				SEAL_WRITE_ATTEMPTS,
			);
			if (!durable) {
				// Every retry of the final seal write failed. Canonical exports have
				// not started; sealedAlready stays false so `failed` can land
				// INCOMPLETE.
				throw new Error(
					`verification run could not seal its evidence row after ${SEAL_WRITE_ATTEMPTS} attempts (database failure or recovery generation fence); no canonical report was published and the run must be marked INCOMPLETE`,
				);
			}
			// Durably sealed — only NOW is a later throw not this row's story.
			sealedAlready = true;
		},

		failed: async (err) => {
			if (sealedAlready) {
				// The report is sealed; a later throw is not this row's story.
				return;
			}
			await soft("the run's failure", async () => {
				if (recoveryGeneration === null) return;
				const landed = await store.fail(id as string, recoveryGeneration, {
					status: "INCOMPLETE",
					finishedAt: new Date(),
					error: recordableError(err),
				});
				if (!landed) {
					throw new Error(
						"verification run is no longer the reserved RUNNING generation; refusing failure demotion",
					);
				}
			});
		},
	};
}

/**
 * The Prisma adapter. Deliberately thin: everything decidable lives in
 * `createRunRecorder`, so what is untested here is a field-for-field pass
 * through to two Prisma calls.
 */
export function prismaRunRecordStore(prisma: AppPrismaClient): RunRecordStore {
	return {
		create: async (data) =>
			prisma.verificationRun.create({
				data,
				select: { id: true, recoveryGeneration: true },
			}),
		update: async (id, data) => {
			// Destructured rather than spread-and-override: a conditional spread
			// widens the JSON columns to a union of both shapes, and Prisma's
			// update input then matches neither.
			const {
				outcomes,
				counts,
				cleanup,
				providerReadback,
				resumeDecision,
				evidenceManifest,
				...scalars
			} = data;
			const json = (value: unknown) => value as Prisma.InputJsonValue;
			return prisma.verificationRun.update({
				where: { id },
				data: {
					...scalars,
					...(outcomes !== undefined ? { outcomes: json(outcomes) } : {}),
					...(counts !== undefined ? { counts: json(counts) } : {}),
					...(cleanup !== undefined ? { cleanup: json(cleanup) } : {}),
					...(providerReadback !== undefined
						? { providerReadback: json(providerReadback) }
						: {}),
					...(resumeDecision !== undefined
						? { resumeDecision: json(resumeDecision) }
						: {}),
					...(evidenceManifest !== undefined
						? { evidenceManifest: json(evidenceManifest) }
						: {}),
				},
			});
		},
		fail: async (id, expectedRecoveryGeneration, data) => {
			const {
				outcomes,
				counts,
				cleanup,
				providerReadback,
				resumeDecision,
				evidenceManifest,
				...scalars
			} = data;
			const json = (value: unknown) => value as Prisma.InputJsonValue;
			const landed = await prisma.verificationRun.updateMany({
				where: {
					id,
					status: "RUNNING",
					recoveryGeneration: expectedRecoveryGeneration,
					recoveryOwner: null,
					recoveryLeaseUntil: null,
				},
				data: {
					...scalars,
					...(outcomes !== undefined ? { outcomes: json(outcomes) } : {}),
					...(counts !== undefined ? { counts: json(counts) } : {}),
					...(cleanup !== undefined ? { cleanup: json(cleanup) } : {}),
					...(providerReadback !== undefined
						? { providerReadback: json(providerReadback) }
						: {}),
					...(resumeDecision !== undefined
						? { resumeDecision: json(resumeDecision) }
						: {}),
					...(evidenceManifest !== undefined
						? { evidenceManifest: json(evidenceManifest) }
						: {}),
				},
			});
			return landed.count === 1;
		},
		seal: async (
			id,
			expectedRecoveryGeneration,
			data,
			expectedResourceIntents,
		) => {
			const {
				outcomes,
				counts,
				cleanup,
				providerReadback,
				resumeDecision,
				evidenceManifest,
				...scalars
			} = data;
			const json = (value: unknown) => value as Prisma.InputJsonValue;
			return prisma.$transaction(async (tx) => {
				// Take the same parent-row lock used by every producer intent write
				// BEFORE reading the children. Under PostgreSQL READ COMMITTED, reading
				// the dossier first would allow this interleaving: a producer inserts an
				// uncommitted PREPARED child, the seal reads the old child population,
				// then blocks on the parent CAS until that producer commits. Locking the
				// parent first makes the producer wait; after this transaction seals, its
				// RUNNING fence re-check returns no row and it cannot create the child.
				const locked = await tx.$queryRaw<Array<{ id: string }>>`
					SELECT "id"
					FROM "VerificationRun"
					WHERE "id" = ${id}::uuid
					  AND "status" = 'RUNNING'
					  AND "recoveryGeneration" = ${expectedRecoveryGeneration}
					  AND "recoveryOwner" IS NULL
					  AND "recoveryLeaseUntil" IS NULL
					FOR UPDATE
				`;
				if (locked.length !== 1) {
					// A response can be lost after COMMIT. Only the exact generation and
					// exact digest+seal pair proves this retry is the same sealed report.
					if (
						typeof data.reportSha256 !== "string" ||
						typeof data.seal !== "string"
					) {
						return false;
					}
					const alreadySealed = await tx.verificationRun.findFirst({
						where: {
							id,
							status: "SEALED",
							recoveryGeneration: expectedRecoveryGeneration,
							recoveryOwner: null,
							recoveryLeaseUntil: null,
							reportSha256: data.reportSha256,
							seal: data.seal,
						},
						select: { id: true },
					});
					return alreadySealed !== null;
				}
				const currentIntents = await tx.verificationResourceIntent.findMany({
					where: { verificationRunId: id },
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
				});
				if (
					!evidenceValuesEqual(
						redactIntentDossier(currentIntents),
						expectedResourceIntents,
					)
				) {
					throw new Error(
						"verification run paid-resource intents changed before the SEALED CAS",
					);
				}
				const landed = await tx.verificationRun.updateMany({
					where: {
						id,
						status: "RUNNING",
						recoveryGeneration: expectedRecoveryGeneration,
						recoveryOwner: null,
						recoveryLeaseUntil: null,
					},
					data: {
						...scalars,
						...(outcomes !== undefined ? { outcomes: json(outcomes) } : {}),
						...(counts !== undefined ? { counts: json(counts) } : {}),
						...(cleanup !== undefined ? { cleanup: json(cleanup) } : {}),
						...(providerReadback !== undefined
							? { providerReadback: json(providerReadback) }
							: {}),
						...(resumeDecision !== undefined
							? { resumeDecision: json(resumeDecision) }
							: {}),
						...(evidenceManifest !== undefined
							? { evidenceManifest: json(evidenceManifest) }
							: {}),
					},
				});
				if (landed.count === 1) return true;
				// A response can be lost after COMMIT. Only the exact generation and
				// exact digest+seal pair proves this retry is the same sealed report.
				if (
					typeof data.reportSha256 !== "string" ||
					typeof data.seal !== "string"
				) {
					return false;
				}
				const alreadySealed = await tx.verificationRun.findFirst({
					where: {
						id,
						status: "SEALED",
						recoveryGeneration: expectedRecoveryGeneration,
						recoveryOwner: null,
						recoveryLeaseUntil: null,
						reportSha256: data.reportSha256,
						seal: data.seal,
					},
					select: { id: true },
				});
				return alreadySealed !== null;
			});
		},
		/**
		 * Matched on the token HASH, not on its prefix: the prefix rule
		 * (`bo_` + 8 chars) is spelled in the web app's auth layer, and a
		 * second spelling of it here is the disagreement class this harness
		 * already paid for once with two names for one source object.
		 *
		 * The hash itself comes from `@bitovp/core` for exactly that reason.
		 * The first cut inlined `createHash("sha256")` — the value the web
		 * layer stores TODAY, and a silent degradation the day that changed:
		 * the lookup would match nothing, every run would record a null actor,
		 * and no test would fail (review of PR #345). One derivation, two
		 * importers. The secret is never stored or logged.
		 */
		actorForToken: async (secret) => {
			const row = await prisma.apiToken.findFirst({
				where: { tokenHash: hashApiTokenSecret(secret) },
				select: { id: true },
			});
			return row ? `token:${row.id}` : null;
		},
		// Upserted on the (run, scenario, airing, leg) key: a scenario written
		// twice in one run replaces its leg rather than accumulating a second
		// story about the same delivery.
		upsertLiveEvidence: async (rows) => {
			const json = (value: unknown) => value as Prisma.InputJsonValue;
			const writes = rows.map((row) => {
				const body = {
					version: row.version,
					complete: row.complete,
					missing: json(row.missing),
					tuple: json(row.tuple),
				};
				return prisma.verificationLiveEvidence.upsert({
					where: {
						verificationRunId_scenario_liveChannelRunId_outputLeg: {
							verificationRunId: row.verificationRunId,
							scenario: row.scenario,
							liveChannelRunId: row.liveChannelRunId,
							outputLeg: row.outputLeg,
						},
					},
					create: {
						verificationRunId: row.verificationRunId,
						scenario: row.scenario,
						liveChannelRunId: row.liveChannelRunId,
						outputLeg: row.outputLeg,
						...body,
					},
					update: body,
				});
			});
			// One scenario's legs are one tuple. A mid-batch failure must leave zero
			// rows, never a partial population that a parent row could later seal.
			await prisma.$transaction(writes);
		},
	};
}
