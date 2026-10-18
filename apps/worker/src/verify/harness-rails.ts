/**
 * The paid harness's rails — the rules that make it FAIL CLOSED (paid audit
 * 893eb66 BLOCKER-3 / BLOCKER-4 / HIGH-11, ).
 *
 * Every rule here is pure or dependency-injected, because the runner that
 * applies them needs a database, credentials, a product URL and a bucket, and
 * a rule left inline there is a rule nothing can reach (the same argument
 * `addHygieneChecks` and `vodOutcomeForReport` were extracted on). What the
 * audit measured, in order:
 *
 *  - a `--run-id` is joined into a filesystem path and an S3 prefix unchecked,
 *    and a REUSED id lets a prior run's artefacts stand as this run's evidence;
 *  - `--resume-from` honoured a prior PASS by scenario NAME alone — a different
 *    commit, schema, plan, source or account could inherit it;
 *  - numeric flags went through `Number`, so `NaN`/`Infinity` turned every
 *    cap and timeout into "no cap";
 *  - the runner's identity was "the first credential whose label starts with
 *    X" and "the oldest Bitmovin account" — ambiguity resolved silently;
 *  - a password or Bearer token was sent to whatever `VERIFY_BASE_URL` said;
 *  - a scenario that timed out was reported INVALID with no job id and no
 *    attempt to reach a terminal state, so the encoding kept billing.
 */

import { createHash, createHmac } from "node:crypto";
import type { VerificationEncodingIdentity } from "@bitovp/core";

/** `--run-id`: a single path segment, never `..`, never empty. */
export function validateRunId(raw: string): string {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(raw) || raw.includes("..")) {
		throw new Error(
			`--run-id "${raw}" is not a run id: one path segment of [A-Za-z0-9._-] (max 64), no ".." — it names a directory under VERIFY_RUN_ROOT and an S3 prefix, and both are joined verbatim`,
		);
	}
	return raw;
}

/**
 * A positive integer flag, or its default. `Number("abc")` is NaN and NaN
 * compares false against every bound, which turned `--max-submits abc` into
 * "no cap" and `--timeout-ms x` into "never times out"; `Infinity` did the
 * same with a straight face.
 */
export function positiveInt(
	name: string,
	raw: string | undefined,
	fallback: number,
): number {
	if (raw === undefined) {
		return fallback;
	}
	if (
		!/^\d+$/.test(raw) ||
		Number(raw) <= 0 ||
		!Number.isSafeInteger(Number(raw))
	) {
		throw new Error(
			`--${name} "${raw}" is not a positive integer — a cap or timeout that does not parse must refuse, not fail open`,
		);
	}
	return Number(raw);
}

/**
 * Where the runner may send its credential. Loopback over plain HTTP and any
 * HTTPS origin are fine; plaintext HTTP to a remote host is a credential leak
 * waiting for a typo in an env var, and a URL carrying userinfo or a non-HTTP
 * scheme is not a product URL at all. `allowInsecure` is the explicit,
 * logged override for a lab network.
 */
export function baseUrlPolicy(
	raw: string,
	options: {
		allowInsecure?: boolean;
		/** Origins (scheme://host[:port]) the runner may send its credential to. */
		allowedOrigins?: readonly string[];
		/** The explicit, logged override: credentials to ANY origin (lab only). */
		allowAnyOrigin?: boolean;
	} = {},
): { ok: true; url: string } | { ok: false; reason: string } {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return { ok: false, reason: `VERIFY_BASE_URL "${raw}" is not a URL` };
	}
	if (url.username || url.password) {
		return {
			ok: false,
			reason:
				"VERIFY_BASE_URL carries userinfo — the runner authenticates with VERIFY_API_TOKEN or VERIFY_PASSWORD, never with a URL",
		};
	}
	if (url.search || url.hash) {
		return {
			ok: false,
			reason: `VERIFY_BASE_URL "${raw}" carries a query or fragment — a base URL is an origin plus an optional path`,
		};
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		return {
			ok: false,
			reason: `VERIFY_BASE_URL scheme "${url.protocol}" is not http(s)`,
		};
	}
	// The path is KEPT (review-327 S1): `https://host/ovp` is a subpath
	// deployment, not `https://host`. Only the trailing slash goes, because the
	// runner appends `/api/...` to what this returns.
	const base = `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
	const host = url.hostname.replace(/^\[|\]$/g, "");
	const loopback =
		host === "localhost" || host === "127.0.0.1" || host === "::1";
	// Re-audit HIGH-6 : ANY https origin used to pass, and the
	// runner sends VERIFY_PASSWORD / VERIFY_API_TOKEN to whatever this returns
	// — a typo, a DNS takeover or a hostile VERIFY_BASE_URL was a credential
	// exfiltration. A non-loopback origin must be NAMED in
	// VERIFY_ALLOWED_ORIGINS, or the caller must say VERIFY_ALLOW_ANY_ORIGIN=1.
	const trusted =
		loopback ||
		options.allowAnyOrigin === true ||
		(options.allowedOrigins ?? []).some((entry) => {
			try {
				return new URL(entry).origin === url.origin;
			} catch {
				return false;
			}
		});
	if (!trusted) {
		return {
			ok: false,
			reason: `VERIFY_BASE_URL origin "${url.origin}" is neither loopback nor listed in VERIFY_ALLOWED_ORIGINS — name it there, or set VERIFY_ALLOW_ANY_ORIGIN=1 to send credentials to an arbitrary origin on purpose`,
		};
	}
	if (url.protocol === "https:") {
		return { ok: true, url: base };
	}
	if (loopback || options.allowInsecure) {
		return { ok: true, url: base };
	}
	return {
		ok: false,
		reason: `VERIFY_BASE_URL "${raw}" is plaintext HTTP to a non-loopback host — the runner would send VERIFY_PASSWORD / VERIFY_API_TOKEN in the clear; use https://, or set VERIFY_ALLOW_INSECURE_BASE_URL=1 to say you mean it`,
	};
}

/**
 * The ONE place the harness reads its base URL out of the environment.
 *
 * Re-audit HIGH-6 was fixed in `main` only, and `verify smoke` — which the
 * nightly runs FIRST, and which posts `VERIFY_PASSWORD` to `/api/auth/login`
 * and sends `VERIFY_API_TOKEN` as a Bearer — built its config straight from
 * `process.env.VERIFY_BASE_URL`. So the real credentials went to an unchecked
 * origin every night, before the checked path ever ran (review of this PR).
 * Every command resolves through here now, and the raw reads live nowhere
 * else: a third command cannot bypass a policy it has no way to skip.
 */
export function resolveBaseUrl(
	env: NodeJS.ProcessEnv,
): { ok: true; url: string } | { ok: false; reason: string } {
	return baseUrlPolicy(env.VERIFY_BASE_URL ?? "http://127.0.0.1:3100", {
		allowInsecure: env.VERIFY_ALLOW_INSECURE_BASE_URL === "1",
		allowedOrigins: (env.VERIFY_ALLOWED_ORIGINS ?? "")
			.split(",")
			.map((entry) => entry.trim())
			.filter((entry) => entry.length > 0),
		allowAnyOrigin: env.VERIFY_ALLOW_ANY_ORIGIN === "1",
	});
}

/** What a scenario's PASS is a PASS *of* — recorded on every outcome. */
export type OutcomeIdentity = {
	planSha256?: string;
	sourceObject?: string;
	/**
	 * The staged sources' version identity (etag / versionId / size, ledger
	 * #218) — a NAME says nothing about bytes; a re-upload under the same key
	 * must not inherit a prior PASS. Folded over EVERY ingest entry of the
	 * plan (`planSourceIdentity`), because a two-source scenario can have its
	 * SECOND object replaced. "unavailable" when any entry could not be HEADed,
	 * which refuses resume rather than assuming.
	 */
	sourceIdentity?: string;
	bitmovinAccountId?: string | null;
};

export type ReportFingerprint = {
	commit: string;
	checkoutLatestMigration: string;
	dbLatestMigration: string;
};

/**
 * May a prior report's PASS stand in for running the scenario again?
 *
 * Only when everything a PASS is conditional on is the same: the code and
 * schema the prior run fingerprinted, the exact plan the scenario would
 * submit now, the source it reads, and the Bitmovin account it would bill.
 * A prior report that did not record one of these
 * cannot be honoured — "we don't know what it passed against" is a reason to
 * spend the encode, not to skip it.
 */
export function resumeEligibility(
	prior: {
		fingerprint?: Partial<ReportFingerprint>;
		outcome?: { verdict: string } & OutcomeIdentity;
		runId?: string;
	},
	current: { fingerprint: ReportFingerprint } & Required<OutcomeIdentity>,
): { honor: true; runId: string } | { honor: false; reason: string } {
	const o = prior.outcome;
	if (o?.verdict !== "PASS") {
		return { honor: false, reason: "no prior PASS for this scenario" };
	}
	const fp = prior.fingerprint;
	// Re-audit BLOCKER-3 : a container without `.git` reported
	// "unknown", and `unknown == unknown` honoured PASSes across different
	// builds. An unknown commit cannot equal itself.
	if (fp?.commit === "unknown" || current.fingerprint.commit === "unknown") {
		return {
			honor: false,
			reason:
				"commit is unknown on at least one side — build the images with GIT_COMMIT (BITOVP_COMMIT in the container) so identity is known",
		};
	}
	for (const key of [
		"commit",
		"checkoutLatestMigration",
		"dbLatestMigration",
	] as const) {
		if (fp?.[key] === undefined) {
			return {
				honor: false,
				reason: `prior report has no fingerprint.${key} — it predates identity recording`,
			};
		}
		if (fp[key] !== current.fingerprint[key]) {
			return {
				honor: false,
				reason: `fingerprint.${key} differs (prior ${fp[key]}, now ${current.fingerprint[key]})`,
			};
		}
	}
	if (
		o.sourceIdentity === "unavailable" ||
		current.sourceIdentity === "unavailable"
	) {
		return {
			honor: false,
			reason:
				"source identity unavailable on at least one side — the staged source could not be HEADed, so its bytes are not known to be the same",
		};
	}
	for (const key of [
		"planSha256",
		"sourceObject",
		"sourceIdentity",
		"bitmovinAccountId",
	] as const) {
		if (o[key] === undefined) {
			return {
				honor: false,
				reason: `prior outcome has no ${key} — it predates identity recording`,
			};
		}
		if (o[key] !== current[key]) {
			return {
				honor: false,
				reason: `${key} differs (prior ${String(o[key])}, now ${String(current[key])})`,
			};
		}
	}
	return { honor: true, runId: prior.runId ?? "prior run" };
}

/**
 * One credential by label — exact match wins; a prefix match is accepted only
 * when it is the ONLY one. "The first whose label starts with X" picked
 * whichever the database returned first.
 */
export function pickByLabel<T extends { label: string }>(
	rows: readonly T[],
	label: string,
	what: string,
): T | undefined {
	const exact = rows.filter((r) => r.label === label);
	if (exact.length === 1) {
		return exact[0];
	}
	const prefixed = rows.filter((r) => r.label.startsWith(label));
	if (prefixed.length > 1) {
		throw new Error(
			`${what}: ${prefixed.length} credentials match "${label}" (${prefixed.map((r) => r.label).join(", ")}) — name the exact label`,
		);
	}
	return prefixed[0];
}

/**
 * Which Bitmovin account bills the run. A named one must exist; with none
 * named, exactly one account is unambiguous and two or more is a question
 * the runner must not answer by creation date.
 */
export function pickAccount<T extends { id: string }>(
	accounts: readonly T[],
	wanted: string | undefined,
): T | undefined {
	if (wanted !== undefined) {
		const hit = accounts.find((a) => a.id === wanted);
		if (!hit) {
			throw new Error(
				`VERIFY_BITMOVIN_ACCOUNT_ID ${wanted} is not a registered account (${accounts.length} registered)`,
			);
		}
		return hit;
	}
	if (accounts.length > 1) {
		throw new Error(
			`${accounts.length} Bitmovin accounts are registered and none is named — set VERIFY_BITMOVIN_ACCOUNT_ID so the run bills the account you mean`,
		);
	}
	return accounts[0];
}

/** The states in which an encoding job is still doing (billable) work. */
export const NON_TERMINAL_JOB_STATUSES: readonly string[] = [
	"QUEUED",
	"RUNNING",
	"PROVIDER_DISCOVERY_PENDING",
	"PROVIDER_IDENTITY_CONFLICT",
	"AWAITING_QC",
];

/**
 * Drive a job that the run is abandoning to a terminal state, and say what
 * happened. Cancel through the product (the route the operator would use),
 * then poll until the row leaves its non-terminal states or the budget runs
 * out. The verdict is the caller's; this only refuses to look away.
 */
/** Exact provider states that are allowed to close paid-resource cleanup. */
export const PROVIDER_TERMINAL_STATUSES: readonly string[] = [
	"FINISHED",
	"ERROR",
	"CANCELED",
	"TRANSFER_ERROR",
	// Our own sentinel, produced only from a typed provider HTTP 404.
	"NOT_FOUND",
];

/** Unknown/new/malformed/synthetic states are never terminal by default. */
export function isProviderEncodingTerminal(status: unknown): boolean {
	return (
		typeof status === "string" && PROVIDER_TERMINAL_STATUSES.includes(status)
	);
}

export type ProviderEncodingStatus = {
	encodingId: string;
	status: string;
	/** Exact key/SHA/name/label proof retained in the closure readback. */
	identity?: VerificationEncodingIdentity;
};

export async function ensureTerminal(deps: {
	cancel: () => Promise<number>;
	readStatus: () => Promise<string | undefined>;
	/**
	 * Re-audit BLOCKER-2 : the product's own row leaving its
	 * billable states proves nothing about the PROVIDER — the VOD cancel path
	 * writes CANCELED locally even when the stop call failed, so the report
	 * used to call a still-running encoding "terminal". This reads every
	 * provider encoding of the job; absent (tests only), the result says so
	 * with `providerTerminal: "unread"` and NEVER claims provider terminal.
	 */
	readProviderStatuses?: () => Promise<ProviderEncodingStatus[]>;
	sleep: () => Promise<void>;
	now: () => number;
	budgetMs: number;
}): Promise<{
	status: string;
	cancelHttp: number;
	terminal: boolean;
	localTerminal: boolean;
	providerTerminal: boolean | "unread";
	provider?: ProviderEncodingStatus[];
}> {
	const cancelHttp = await deps.cancel().catch(() => 0);
	const deadline = deps.now() + deps.budgetMs;
	const localTerminal = (status: string) =>
		!NON_TERMINAL_JOB_STATUSES.includes(status) && status !== "UNKNOWN";
	/**
	 * `undefined` (the read failed) and EMPTY (no durable provider id) are both
	 * UNKNOWN. CREATE can have reached the provider immediately before the worker
	 * or database died, so an empty local step-log projection is not proof that
	 * no billable encoding exists. Recovery must find a marker-qualified provider
	 * row or leave the intent UNRESOLVED; vacuous `[].every(...)` is a false PASS.
	 */
	const providerSettled = (provider: ProviderEncodingStatus[] | undefined) =>
		provider !== undefined &&
		provider.length > 0 &&
		provider.every((p) => isProviderEncodingTerminal(p.status));
	const read = async () => ({
		status: (await deps.readStatus().catch(() => undefined)) ?? "UNKNOWN",
		provider: deps.readProviderStatuses
			? await deps.readProviderStatuses().catch(() => undefined)
			: undefined,
	});
	let current = await read();
	while (
		(!localTerminal(current.status) ||
			(deps.readProviderStatuses !== undefined &&
				!providerSettled(current.provider))) &&
		deps.now() < deadline
	) {
		await deps.sleep();
		current = await read();
	}
	const providerTerminal: boolean | "unread" = deps.readProviderStatuses
		? providerSettled(current.provider)
		: "unread";
	return {
		status: current.status,
		cancelHttp,
		localTerminal: localTerminal(current.status),
		providerTerminal,
		terminal:
			localTerminal(current.status) &&
			(providerTerminal === "unread" || providerTerminal === true),
		...(current.provider ? { provider: current.provider } : {}),
	};
}

/**
 * Poll a status reader until it reports one of the wanted states or the
 * budget runs out. Used for a live channel's STOPPED confirmation: the stop
 * route answers 202 with STOPPING and the worker confirms later — a 2xx is
 * an acknowledgement, not a stopped channel.
 */
export async function awaitStatus(deps: {
	read: () => Promise<string | undefined>;
	wanted: readonly string[];
	sleep: () => Promise<void>;
	now: () => number;
	budgetMs: number;
}): Promise<{ status: string; reached: boolean }> {
	const deadline = deps.now() + deps.budgetMs;
	let status = (await deps.read().catch(() => undefined)) ?? "unknown";
	while (!deps.wanted.includes(status) && deps.now() < deadline) {
		await deps.sleep();
		status = (await deps.read().catch(() => undefined)) ?? "unknown";
	}
	return { status, reached: deps.wanted.includes(status) };
}

/**
 * One bucket the run's rewrite can write to. `family` is the name the refusal
 * prints (S3 / GenericS3 / GCS); the credential is the one that can list it.
 */
export type OutputFamily = {
	family: string;
	credentialId: string;
	bucket: string;
};

/** What listing `prefix` in a family's bucket found — or why it could not look. */
export type PrefixState = { holds?: boolean; first?: string; error?: string };

/**
 * The bucket half of "a run id is never reused" .
 *
 * `verify/<runId>/` must be EMPTY in EVERY bucket the rewrite can write to.
 * S3, GenericS3 (Akamai/OCI) and GCS each resolve to their own bucket, and the
 * first cut listed only the S3 one — so for every scenario that writes
 * elsewhere (akamai-*, multi-output-s3-gcs) a reused id sailed past the
 * refusal and the run spent before the verify-time foreign-object filter
 * could object (review-327 I3). A listing that fails is refused as well: a
 * prefix whose state is unknown is not known to be empty.
 *
 * A rule with a seam, so the refusal itself is exercised by a test instead
 * of pinned as source text (review-327 I1); the runner's one-line call is
 * what the shape pin guards.
 */
export async function assertFreshRun(input: {
	prefix: string;
	families: readonly OutputFamily[];
	holds: (family: OutputFamily, prefix: string) => Promise<PrefixState>;
}): Promise<void> {
	for (const family of input.families) {
		const state = await input.holds(family, input.prefix);
		if (state.error) {
			throw new Error(
				`could not verify that ${family.family} ${family.bucket}/${input.prefix} is empty (${state.error}) — refusing to run into a prefix whose state is unknown`,
			);
		}
		if (state.holds) {
			throw new Error(
				`${family.family} ${family.bucket}/${input.prefix} already holds objects (e.g. ${state.first}) — a run id is never reused; pick a fresh --run-id (use --resume-from <prior report.json> to honour prior PASSes)`,
			);
		}
	}
}

/**
 * The run-directory half of the same rule (review-327 I1): a second run under
 * the same id would overwrite the first one's report while sharing its
 * prefix. Refuses an existing directory and creates it otherwise — one rule
 * with a seam, for the same reason as `assertFreshRun`.
 */
export async function prepareRunDir(
	runDir: string,
	deps: {
		exists: (path: string) => boolean;
		mkdir: (path: string) => Promise<unknown>;
	},
): Promise<void> {
	if (deps.exists(runDir)) {
		throw new Error(
			`run directory ${runDir} already exists — a run id is never reused; pick a fresh --run-id`,
		);
	}
	await deps.mkdir(runDir);
}

/**
 * The submit-cost budget .
 *
 * Checked and charged in ONE synchronous step, at the spend site — the
 * encoding-job POST, the live channel create — never up front. Charging every
 * runnable scenario before its rewrite made a resumed (free) PASS and an
 * invalid rewrite eat real budget, which starves the very submissions the cap
 * exists to ration the moment resume works. `exhausted` is the cheap early
 * exit that spares a doomed scenario its rewrite; it reserves nothing.
 */
export function createSubmitBudget(max: number | undefined): {
	exhausted: () => boolean;
	spend: () => { ok: true } | { ok: false; reason: string };
	spent: () => number;
} {
	let spent = 0;
	const exhausted = () => max !== undefined && spent >= max;
	return {
		exhausted,
		spend: () => {
			if (exhausted()) {
				return { ok: false, reason: `max-submits cap (${max}) reached` };
			}
			spent += 1;
			return { ok: true };
		},
		spent: () => spent,
	};
}

/**
 * A report is EDITABLE JSON : a prior report
 * whose PASS lines were changed by hand would be honoured by `--resume-from`.
 * The seal is written beside `report.json` when a run finishes and verified
 * before any PASS is honoured. With VERIFY_SEAL_KEY set it is an HMAC (an
 * editor without the key cannot re-seal); without it a plain SHA-256, which
 * still catches every accidental or careless edit and says which kind it is.
 */
export function sealReport(reportJson: string, key?: string): string {
	if (key) {
		return `hmac-sha256:${createHmac("sha256", key).update(reportJson).digest("hex")}`;
	}
	return `sha256:${createHash("sha256").update(reportJson).digest("hex")}`;
}

export function verifyReportSeal(
	reportJson: string,
	seal: string,
	key?: string,
): { ok: true } | { ok: false; reason: string } {
	const trimmed = seal.trim();
	if (trimmed.startsWith("hmac-sha256:")) {
		if (!key) {
			return {
				ok: false,
				reason:
					"the prior report is HMAC-sealed and VERIFY_SEAL_KEY is not set — it cannot be verified, so it is not honoured",
			};
		}
		return sealReport(reportJson, key) === trimmed
			? { ok: true }
			: {
					ok: false,
					reason:
						"the prior report does not match its HMAC seal — it was edited, or sealed with a different key",
				};
	}
	if (trimmed.startsWith("sha256:")) {
		return sealReport(reportJson) === trimmed
			? { ok: true }
			: {
					ok: false,
					reason:
						"the prior report does not match its seal — it was edited after the run finished",
				};
	}
	return { ok: false, reason: `unrecognised seal "${trimmed.slice(0, 24)}"` };
}

/**
 * The default run id used to be the wall clock at SECOND precision, so two
 * runs started in the same second shared a directory and a prefix — the
 * reservation check is not atomic across processes (re-audit BLOCKER-3,
 * ). Milliseconds plus random hex make a collision a
 * deliberate act (`--run-id`), which `assertFreshRun` then refuses.
 */
export function defaultRunId(now: Date, randomHex: () => string): string {
	const stamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 23);
	return `${stamp}-${randomHex()}`;
}
