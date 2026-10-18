import { createHash } from "node:crypto";
import { isWebhookToken } from "./keys";

/**
 * Per-encoding webhook registration contract (WP-G G-2) — shared by the
 * worker's registrar (writes the table, talks to Bitmovin), the web
 * receiver (looks a token up) and the settings screen (renders the rows).
 *
 * The four kinds are the ones the SDK can create+list+delete PER ENCODING
 * (`createByEncodingId` / `listByEncodingId` /
 * `deleteByEncodingIdAndWebhookId`); `liveInputStreamChanged` is
 * create-only and `liveEncodingHeartbeat` is account-level (G-3).
 */
export const WEBHOOK_REGISTRATION_KINDS = [
	"finished",
	"error",
	"transferError",
	"liveManifestReady",
] as const;

export type WebhookRegistrationKind =
	(typeof WEBHOOK_REGISTRATION_KINDS)[number];

export function isWebhookRegistrationKind(
	raw: string,
): raw is WebhookRegistrationKind {
	return (WEBHOOK_REGISTRATION_KINDS as readonly string[]).includes(raw);
}

/** The receiver's lookup key for a `j` token — never the token itself. */
export function hashWebhookToken(token: string): string {
	return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * A short fingerprint of the master secret a key was derived from. Stored
 * on the registration row so a rotated master (env set, env removed, row
 * regenerated) makes every older registration visibly stale — the registrar
 * re-registers them instead of leaving hooks whose signatures can no longer
 * verify.
 */
export function webhookKeyId(masterSecret: string | Buffer): string {
	return createHash("sha256")
		.update("bitovp-webhook-key-id:")
		.update(masterSecret)
		.digest("hex")
		.slice(0, 16);
}

const RECEIVER_PATH = /\/api\/webhooks\/bitmovin\/j\/([A-Za-z0-9_-]{22})$/;

/** The token a `j` receiver URL carries, or null when it is not one of ours. */
export function tokenFromReceiverUrl(url: string): string | null {
	const match = RECEIVER_PATH.exec(url);
	const token = match?.[1];
	return token && isWebhookToken(token) ? token : null;
}

/** Does this registered URL sit under the given public base (origin)? */
export function webhookUrlMatchesBase(url: string, baseUrl: string): boolean {
	try {
		return new URL(url).origin === new URL(baseUrl).origin;
	} catch {
		return false;
	}
}

/** Bounded exponential backoff for FAILED rows: 30 s · 2^n, capped at 10 min. */
export const REGISTRATION_BACKOFF_BASE_MS = 30_000;
export const REGISTRATION_BACKOFF_MAX_MS = 10 * 60_000;

export function nextRegistrationAttemptAt(attempts: number, now: Date): Date {
	const exponent = Math.max(0, Math.min(attempts, 20));
	const delay = Math.min(
		REGISTRATION_BACKOFF_BASE_MS * 2 ** exponent,
		REGISTRATION_BACKOFF_MAX_MS,
	);
	return new Date(now.getTime() + delay);
}

/** DELETED rows are pruned after this — the table is a working set, not a log. */
export const REGISTRATION_TOMBSTONE_TTL_MS = 7 * 24 * 3_600_000;

/** How often the worker reconciles the table against jobs, runs and ingress. */
export const REGISTRATION_RECONCILE_INTERVAL_MS = 10_000;

/** The AppSetting key the settings screen's "re-register now" writes. */
export const WEBHOOK_RECONCILE_REQUEST_KEY = "webhook.reconcileRequestedAt";

/**
 * The account-level Live Encoding Heartbeat webhook (WP-G G-3, C37): one
 * registration per Bitmovin account (the SDK has `create` / `list` /
 * `deleteByWebhookId` only — no per-encoding form), pushed every `interval`
 * seconds for every live encoding on the account. Provider docs: interval
 * min 1, default 20. Registered while the account has a live run, retired
 * after the idle window without one.
 */
export const HEARTBEAT_WEBHOOK_KIND = "liveEncodingHeartbeat";
export const HEARTBEAT_WEBHOOK_DEFAULT_INTERVAL_S = 20;
export const HEARTBEAT_WEBHOOK_MIN_INTERVAL_S = 1;
export const HEARTBEAT_WEBHOOK_DEFAULT_IDLE_MINUTES = 60;

/** Heartbeat WebhookEvent rows outlive their run by this much (rev414 R4). */
export const HEARTBEAT_EVENT_RETENTION_MS = 7 * 24 * 60 * 60_000;
/** Rows pruned per registrar tick — bounded like every sweep. */
export const HEARTBEAT_EVENT_PRUNE_BATCH = 500;

/**
 * `HEARTBEAT_WEBHOOK_INTERVAL_S`: blank/garbage/<1 ⇒ the provider default;
 * `0` or `off` ⇒ 0, the OFF switch (no hook is registered; an existing one
 * retires as idle). rev414 O1.
 */
export function heartbeatWebhookIntervalS(raw: string | undefined): number {
	if (raw !== undefined && raw.trim().toLowerCase() === "off") {
		return 0;
	}
	const parsed = Number(raw);
	if (raw !== undefined && raw.trim() !== "" && parsed === 0) {
		return 0;
	}
	if (!Number.isFinite(parsed) || parsed < HEARTBEAT_WEBHOOK_MIN_INTERVAL_S) {
		return HEARTBEAT_WEBHOOK_DEFAULT_INTERVAL_S;
	}
	return Math.floor(parsed);
}

/** `HEARTBEAT_WEBHOOK_IDLE_MINUTES`: how long without a live run before the hook is retired. */
export function heartbeatWebhookIdleMs(raw: string | undefined): number {
	const parsed = Number(raw);
	const minutes =
		Number.isFinite(parsed) && parsed > 0
			? parsed
			: HEARTBEAT_WEBHOOK_DEFAULT_IDLE_MINUTES;
	return Math.round(minutes * 60_000);
}

/** The synthetic `encodingId` an account-level row carries (unique with its kind). */
export function heartbeatRegistrationKey(bitmovinAccountId: string): string {
	return `account:${bitmovinAccountId}`;
}
