import { hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Per-registration webhook keys (WP-G G-1).
 *
 * Every registration this app makes with Bitmovin carries a signature key,
 * and every receiver URL carries a token that names it:
 *
 *     /api/webhooks/bitmovin/<scope>/<token>
 *
 * The key is never stored: it is DERIVED from one master secret and the
 * token, HKDF-SHA256 with `info = "bitmovin-webhook:" + token`. So the
 * receiver, given only the token from the URL, recomputes the key and
 * verifies the delivery; a registration row (G-2) needs to remember the
 * token (hashed), never the key. Two tokens give two unrelated keys — a
 * key leaked from one registration says nothing about another — and the
 * master never leaves this process.
 *
 * Scopes:
 * - `j`    per-job / per-run registrations (G-2): a random token each.
 * - `hb`   the account-level live heartbeat hook (G-3).
 * - `acct` the account-level standard set, kept as the legacy shape.
 *
 * `hb` and `acct` are ONE registration per install, so their token is
 * derived from the master too (`bitmovin-webhook-token:<scope>`) — stable
 * across restarts without a row to remember it in, and rotating the master
 * rotates the URL, which is the right consequence.
 */

export const WEBHOOK_SCOPES = ["j", "hb", "acct"] as const;
export type WebhookScope = (typeof WEBHOOK_SCOPES)[number];

export function isWebhookScope(raw: string): raw is WebhookScope {
	return (WEBHOOK_SCOPES as readonly string[]).includes(raw);
}

/** Scopes whose one token is derived from the master rather than random. */
export const DERIVED_TOKEN_SCOPES = ["hb", "acct"] as const;
export type DerivedTokenScope = (typeof DERIVED_TOKEN_SCOPES)[number];

/** 128 bits of token: base64url, no padding ⇒ exactly 22 characters. */
export const WEBHOOK_TOKEN_BYTES = 16;
export const WEBHOOK_TOKEN_PATTERN = /^[A-Za-z0-9_-]{22}$/;

/** Derived-key length. Bitmovin takes the key as a string; we hand it hex. */
const WEBHOOK_KEY_BYTES = 32;

/** Domain-separation salt — fixed on purpose; the master is the entropy. */
const HKDF_SALT = "bitovp-webhook";
const KEY_INFO_PREFIX = "bitmovin-webhook:";
const TOKEN_INFO_PREFIX = "bitmovin-webhook-token:";

export function isWebhookToken(raw: string): boolean {
	return WEBHOOK_TOKEN_PATTERN.test(raw);
}

/** A fresh random token for a per-job registration (scope `j`). */
export function newWebhookToken(): string {
	return randomBytes(WEBHOOK_TOKEN_BYTES).toString("base64url");
}

/**
 * HKDF-SHA256(master, info = "bitmovin-webhook:" + token) → 32 bytes, hex.
 * The result is what `signature.key` carries in the registration AND what
 * the receiver verifies against — the same function on both ends.
 */
export function deriveWebhookKey(
	masterSecret: string | Buffer,
	token: string,
): string {
	if (!isWebhookToken(token)) {
		throw new Error("deriveWebhookKey: malformed token");
	}
	return Buffer.from(
		hkdfSync(
			"sha256",
			toBuffer(masterSecret),
			HKDF_SALT,
			`${KEY_INFO_PREFIX}${token}`,
			WEBHOOK_KEY_BYTES,
		),
	).toString("hex");
}

/**
 * The one token of an account-level scope, derived from the master. Same
 * master ⇒ same token forever (idempotent re-registration by URL); a
 * different master ⇒ a different URL.
 */
export function deriveScopedToken(
	masterSecret: string | Buffer,
	scope: DerivedTokenScope,
): string {
	return Buffer.from(
		hkdfSync(
			"sha256",
			toBuffer(masterSecret),
			HKDF_SALT,
			`${TOKEN_INFO_PREFIX}${scope}`,
			WEBHOOK_TOKEN_BYTES,
		),
	).toString("base64url");
}

/** Constant-time token equality (both sides are 22 ASCII chars when well-formed). */
export function webhookTokenEquals(a: string, b: string): boolean {
	const left = Buffer.from(a, "utf8");
	const right = Buffer.from(b, "utf8");
	return left.length === right.length && timingSafeEqual(left, right);
}

/** The receiver path for a scope + token, relative to the ingress base URL. */
export function webhookReceiverPath(
	scope: WebhookScope,
	token: string,
): string {
	if (!isWebhookToken(token)) {
		throw new Error("webhookReceiverPath: malformed token");
	}
	return `/api/webhooks/bitmovin/${scope}/${token}`;
}

/** The pre-G-1 receiver, kept until G-2 migrates the hooks registered at it. */
export const LEGACY_WEBHOOK_RECEIVER_PATH = "/api/webhooks/bitmovin";

function toBuffer(secret: string | Buffer): Buffer {
	const buffer =
		typeof secret === "string" ? Buffer.from(secret, "utf8") : secret;
	if (buffer.length === 0) {
		throw new Error("webhook master secret must not be empty");
	}
	return buffer;
}
