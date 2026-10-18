/**
 * Suffix-anchored so reference fields stay readable: `credentialId`,
 * `keyframes` etc. do NOT match, while `apiKey`, `streamKey`,
 * `secretAccessKey`, `accessKeyId` (via `keyid`), `srtPassphrase` do.
 * `ask` (FairPlay Application Secret Key) needs an exact match — a suffix
 * rule would swallow `task`/`mask`.
 */
const SENSITIVE_SUFFIX =
	/(key|keyid|secret|password|passphrase|token|license|credential|authorization|signature|session|cookie)s?$/i;
// `serviceAccountJson` is the GCS-service-account vault secret field; it ends in
// `json` (not a sensitive suffix), so it needs an exact rule. The wire/snapshot
// key is `serviceAccountCredentials` (caught by the `credential` suffix); masking
// the raw vault field too means a future accidental snapshot of the secret object
// is covered by the backstop, not only by the hand-built snapshots.
// `username` joins by the same argument (P5 PR-3): the POIS basic-auth pair
// is vault material whose username half matches NO suffix rule, so without
// this a future accidental snapshot of the pair would be covered only by the
// hand-written presence-flag substitution in sdk-ops, not by the backstop.
// HONEST TRADE (review catch R1): SFTP's `username` is readable CONFIG, not a
// secret (credentials/schemas.ts keeps it in `config` and the credentials UI
// renders `user@host`), so masking it here is acceptable COLLATERAL for
// covering the POIS half — not a claim that no readable `username` exists.
// `login` (P5 PR-4, Kantar) joins on the same argument and costs even
// less: it exists nowhere else in the codebase as a readable field (the
// only other hits are the vendored template JSON Schema, which never passes
// through redactSecrets, and comment prose).
// It costs nothing today: the credential routes don't call redactSecrets,
// createSftpOutput's audit snapshot deliberately omits username, and the
// template exporter emits a placeholder. If SFTP config is ever added to an
// audit snapshot, expect the username to read [REDACTED] there.
const SENSITIVE_EXACT =
	/^(ask|serviceaccountjson|username|login|publishingpoint)$/i;

/** Masks the password of URL userinfo: `scheme://user:pass@host`. */
const URL_USERINFO = /(\/\/[^/\s:@]+:)[^@/\s]+@/g;

/**
 * Header-tuple detection for the ["name", "value"] array shape. Deliberately
 * NARROWER than isSensitiveKey: the old rule redacted ANY 2-element array
 * whose first string had a sensitive suffix, which mangled legitimate data —
 * e.g. Encoding.labels ["license", "prod"] became ["license", "[REDACTED]"]
 * in step logs and cURL exports (P5 PR-2 review N2). Real header names are
 * either the exact well-known ones below or hyphenated x-*-key styles;
 * plain words like "license"/"token" as list VALUES are data, not headers.
 */
const HEADER_TUPLE_EXACT =
	/^(authorization|proxy-authorization|cookie|set-cookie)$/i;
function isHeaderTupleName(name: string): boolean {
	return (
		HEADER_TUPLE_EXACT.test(name) ||
		(name.includes("-") && isSensitiveKey(name))
	);
}

export const REDACTED = "[REDACTED]";

export function isSensitiveKey(key: string): boolean {
	return SENSITIVE_SUFFIX.test(key) || SENSITIVE_EXACT.test(key);
}

/**
 * Deep-copies a JSON-ish value, masking anything that looks secret. This is
 * THE redaction layer for persisted payloads (AuditLog, stepLog, snapshots
 * — REQUIREMENTS §6: secrets redacted in logs). It masks:
 * - values of sensitive property names (see isSensitiveKey)
 * - passwords embedded in URL userinfo inside string values
 * - header-tuple arrays (["authorization", "Bearer …"])
 */
export function redactSecrets<T>(value: T): T {
	return walk(value, new WeakSet()) as T;
}

function walk(value: unknown, ancestors: WeakSet<object>): unknown {
	if (typeof value === "string") {
		return value.replace(URL_USERINFO, `$1${REDACTED}@`);
	}
	if (value === null || typeof value !== "object") {
		return value;
	}
	if (value instanceof Date || value instanceof Uint8Array) {
		return value;
	}
	if (ancestors.has(value)) {
		return "[CIRCULAR]";
	}
	ancestors.add(value);
	let out: unknown;
	if (Array.isArray(value)) {
		if (
			value.length === 2 &&
			typeof value[0] === "string" &&
			isHeaderTupleName(value[0])
		) {
			out = [value[0], REDACTED];
		} else {
			out = value.map((item) => walk(item, ancestors));
		}
	} else {
		const obj: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value)) {
			Object.defineProperty(obj, key, {
				value: isSensitiveKey(key) ? REDACTED : walk(item, ancestors),
				enumerable: true,
				writable: true,
				configurable: true,
			});
		}
		out = obj;
	}
	// Ancestor-path tracking (not a global visited set): shared non-circular
	// references must not be reported as [CIRCULAR].
	ancestors.delete(value);
	return out;
}
