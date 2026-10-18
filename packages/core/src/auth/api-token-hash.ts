import { createHash } from "node:crypto";

/**
 * How an API token secret becomes the value stored in `ApiToken.tokenHash`.
 *
 * ONE derivation, in core, because two consumers need the same answer and they
 * live in different apps: the web auth layer verifies a presented Bearer
 * against the column, and the verification harness looks a run's own token UP
 * by it to record `actor`. The worker hand-rolled its own `createHash("sha256")`
 * — correct on the day it was written, and silently wrong the moment the web
 * side changed: the lookup would simply match nothing, `actor` would degrade to
 * null on every run, and no test anywhere would fail (review of PR #345). A
 * duplicated CONSTANT is a stale comment; a duplicated FUNCTION is a defect
 * with a delay.
 *
 * SHA-256 hex, not a KDF: the secret is 32 random bytes, so stretching it adds
 * per-request latency without adding security. That reasoning belongs to
 * `ApiToken` in the schema and is repeated there.
 */
export function hashApiTokenSecret(secret: string): string {
	return createHash("sha256").update(secret).digest("hex");
}
