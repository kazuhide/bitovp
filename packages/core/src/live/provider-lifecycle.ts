/**
 *  (audit 5c3d97ca BLOCKER-1 / §14.5 LC-01) — the PROVIDER's lifecycle
 * for a run's exact encoding, as a pure classification.
 *
 * The invariant this file exists to make statable: a write that puts local
 * state into RUNNING is valid only from a FRESH provider observation returning
 * nonterminal RUNNING for the same `liveChannelRunId + bitmovinEncodingId`. A
 * LOST observation on an existing RUNNING (timeout, network or credential
 * error, a single 404, a reading older than the freshness TTL) is NOT
 * terminal — it is `UNKNOWN`, which keeps every id and refuses new effects
 * but never greens and never cleans up. A TERMINAL reading is reconciled onto
 * that exact run and is never reused by Restart or by Start's revive.
 *
 * The provider's wire words come from the SDK's `Status` enum (CREATED,
 * QUEUED, RUNNING, FINISHED, ERROR, CANCELED, TRANSFER_ERROR). Anything else
 * — a value the enum grows later, an empty string, a non-string — classifies
 * UNKNOWN: an unrecognised word must not be read as either alive or gone.
 *
 * UI-free and DB-free: the worker feeds it observations, the routes and the
 * page feed it persisted run columns.
 */

export const PROVIDER_LIFECYCLE_STATES = [
	"RUNNING",
	"TRANSITIONAL",
	"TERMINAL",
	"UNKNOWN",
] as const;
export type ProviderLifecycle = (typeof PROVIDER_LIFECYCLE_STATES)[number];

/**
 * The persisted view adds one word the live classifier has no use for:
 * `UNOBSERVED` = no exact readback has ever been recorded for this run (the
 * columns are null — the deploy-time state of every existing row, which is
 * NOT backfilled by guess). Readers must not treat it as UNKNOWN (that would
 * refuse every legacy channel until its first sweep) nor as RUNNING.
 */
export type ProviderLifecycleView = ProviderLifecycle | "UNOBSERVED";

export const PROVIDER_RUNNING_STATUSES = ["RUNNING"] as const;
export const PROVIDER_TRANSITIONAL_STATUSES = ["CREATED", "QUEUED"] as const;
export const PROVIDER_TERMINAL_STATUSES = [
	"FINISHED",
	"ERROR",
	"CANCELED",
	"TRANSFER_ERROR",
] as const;

/**
 * Freshness TTL for a persisted provider observation: 3 × the heartbeat
 * sweep's 30s cadence, the same relation `INGEST_CONNECTED_MAX_AGE_MS` keeps
 * with it (heartbeat-coupling.test.ts pins that one against the worker's real
 * interval). A RUNNING older than this is no longer a claim about now.
 */
export const PROVIDER_STATUS_TTL_MS = 90_000;

/**
 * How long a run may sit UNKNOWN before the sweep raises an alert. Ten sweep
 * ticks: long enough that a single provider blip (the audited lost-observation
 * class) never pages anyone, short enough that a dead credential is noticed
 * inside the programme it is breaking.
 */
export const PROVIDER_UNKNOWN_GRACE_MS = 5 * 60_000;

/** One readback attempt, successful or not, with the clock it was made on. */
export type ProviderObservation =
	| { ok: true; status: string; observedAt: string }
	| { ok: false; error: string; observedAt: string };

/** Classify a provider status word alone — no clock, no freshness. */
export function classifyProviderStatusWord(word: unknown): ProviderLifecycle {
	if (typeof word !== "string") {
		return "UNKNOWN";
	}
	if ((PROVIDER_RUNNING_STATUSES as readonly string[]).includes(word)) {
		return "RUNNING";
	}
	if ((PROVIDER_TRANSITIONAL_STATUSES as readonly string[]).includes(word)) {
		return "TRANSITIONAL";
	}
	if ((PROVIDER_TERMINAL_STATUSES as readonly string[]).includes(word)) {
		return "TERMINAL";
	}
	return "UNKNOWN";
}

function msOf(value: Date | string | null | undefined): number | null {
	if (value === null || value === undefined) {
		return null;
	}
	const ms = value instanceof Date ? value.getTime() : Date.parse(value);
	return Number.isFinite(ms) ? ms : null;
}

/**
 * Classify one observation against the clock. A failed readback is UNKNOWN
 * whatever the failure was — a timeout, a 5xx, a credential rejection and a
 * single 404 all mean "we could not see", never "it is gone". A successful
 * reading older than `ttlMs` is UNKNOWN too: freshness is part of the claim.
 * A reading stamped in the FUTURE (clock skew) is treated as fresh — skew is
 * not staleness, and INGEST_CONNECTED handles its own skew the same way.
 */
export function classifyProviderLifecycle(
	observation: ProviderObservation,
	nowMs: number,
	ttlMs: number = PROVIDER_STATUS_TTL_MS,
): ProviderLifecycle {
	if (!observation.ok) {
		return "UNKNOWN";
	}
	const observedMs = msOf(observation.observedAt);
	if (observedMs === null || nowMs - observedMs > ttlMs) {
		return "UNKNOWN";
	}
	return classifyProviderStatusWord(observation.status);
}

/** The persisted columns (LiveChannelRun) a reader derives the view from. */
export type PersistedProviderState = {
	providerStatus?: string | null;
	providerStatusObservedAt?: Date | string | null;
	providerUnknownSince?: Date | string | null;
	providerTerminalAt?: Date | string | null;
};

/**
 * Derive the view from a run's persisted columns. Terminal is sticky (a
 * stamped `providerTerminalAt` or a terminal word outranks everything); an
 * open UNKNOWN window is UNKNOWN even if the last successful word was
 * RUNNING; a null status is UNOBSERVED; a RUNNING/TRANSITIONAL word is judged
 * against its observation time and the TTL, exactly as a live observation is.
 */
export function deriveProviderLifecycle(
	run: PersistedProviderState | null | undefined,
	nowMs: number,
	ttlMs: number = PROVIDER_STATUS_TTL_MS,
): ProviderLifecycleView {
	if (!run) {
		return "UNOBSERVED";
	}
	if (msOf(run.providerTerminalAt) !== null) {
		return "TERMINAL";
	}
	const word = run.providerStatus ?? null;
	if (word !== null && classifyProviderStatusWord(word) === "TERMINAL") {
		return "TERMINAL";
	}
	if (msOf(run.providerUnknownSince) !== null) {
		return "UNKNOWN";
	}
	if (word === null) {
		return "UNOBSERVED";
	}
	const observedAt = run.providerStatusObservedAt;
	if (observedAt === null || observedAt === undefined) {
		// A word with no time is a claim with no freshness — not judgeable.
		return "UNKNOWN";
	}
	return classifyProviderLifecycle(
		{
			ok: true,
			status: word,
			observedAt:
				observedAt instanceof Date ? observedAt.toISOString() : observedAt,
		},
		nowMs,
		ttlMs,
	);
}

/** Has an UNKNOWN window outlived the grace period? */
export function providerUnknownPastGrace(
	unknownSince: Date | string | null | undefined,
	nowMs: number,
	graceMs: number = PROVIDER_UNKNOWN_GRACE_MS,
): boolean {
	const since = msOf(unknownSince);
	return since !== null && nowMs - since >= graceMs;
}

/**
 * The refusal a NEW provider/ingest effect (Start's revive, Restart, slate,
 * SCTE-35, timeshift, a feeder start or switch commit) gets while the provider
 * cannot be seen or has ended the encoding. Null = the effect may proceed.
 * Stop, cleanup and re-fetch are never gated by this — a channel we cannot
 * see is exactly the one that must stay stoppable (#48).
 *
 * Fail closed: only a fresh, positively observed RUNNING status permits a new
 * effect. A transitional or never-observed encoding may become RUNNING later,
 * but it is not safe to create an external side effect yet.
 */
export function providerEffectRefusal(
	view: ProviderLifecycleView,
): string | null {
	switch (view) {
		case "RUNNING":
			return null;
		case "TRANSITIONAL":
			return "the provider reports this run's encoding is not RUNNING yet — retry after the encoding reaches RUNNING";
		case "UNOBSERVED":
			return "the provider status for this run's encoding has not been observed yet — retry after a fresh RUNNING observation";
		case "UNKNOWN":
			return "the provider's status for this run's encoding cannot be confirmed right now (the read timed out or failed) — it is re-checked every 30 s; retry shortly, or stop the channel";
		case "TERMINAL":
			return "the provider reports this run's encoding has ended (FINISHED/ERROR/CANCELED) — the encoder is gone; start the channel for a fresh run";
	}
}

export type ProviderEffectIdentity = {
	expectedRunId: string | null;
	expectedEncodingId: string | null;
	currentRunId: string | null;
	currentEncodingId: string | null;
};

/**
 * Refuse a new effect unless it is bound to the exact current run and encoder.
 * Null identities fail closed: without both halves there is no attribution
 * proof for the external effect.
 */
export function providerEffectIdentityRefusal(
	identity: ProviderEffectIdentity,
): string | null {
	if (!identity.expectedRunId || !identity.expectedEncodingId) {
		return "the effect is not bound to an exact live run and encoding — refresh the channel and retry";
	}
	if (!identity.currentRunId || !identity.currentEncodingId) {
		return "the current live run and encoding cannot be identified — refresh the channel and retry";
	}
	if (identity.currentRunId !== identity.expectedRunId) {
		return "the live run changed while the effect was being prepared — retry against the current run";
	}
	if (identity.currentEncodingId !== identity.expectedEncodingId) {
		return "the live encoding changed while the effect was being prepared — retry against the current encoding";
	}
	return null;
}
