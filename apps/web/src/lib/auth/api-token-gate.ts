import "server-only";
import { resolveApiTokenForAuthentication } from "@bitovp/db";
import {
	bearerToken,
	createTokenVerifier,
	type TokenVerdict,
} from "./api-token";

/**
 * Compatibility primitive for token consumers. Request authorization uses
 * tenancy.ts's uncached, organization-bound context and active issuer membership.
 */
const verifier = createTokenVerifier({
	load: (prefix) => resolveApiTokenForAuthentication(prefix),
	ttlMs: 0,
});

/** The request header carrying the verified actor (`token:<id>`). Set ONLY
 * by the proxy after verification; any client-supplied copy is stripped
 * there first . */
export const ACTOR_HEADER = "x-bitovp-actor";

export { bearerToken };

/**
 * #32 §5 (LEDGER #32's own trap): the shared human-actor rail. Before users
 * mode the only human actor was the literal "session"; the proxy now stamps
 * `user:<id>` — every rail that used `actor !== "session"` would silently
 * 403 every real human the moment the stamp changed, so the rails widen
 * through THIS helper in the same PR as the stamp (ab-B1). An ALLOWLIST of
 * kinds, never a startsWith denylist (§4/B2 — "none" and a missing header
 * must read as non-human, not fall through).
 */
export function isHumanActor(actor: string | null): boolean {
	return actor === "session" || actor?.startsWith("user:") === true;
}

export function verifyApiTokenRequest(secret: string): Promise<TokenVerdict> {
	return verifier(secret);
}
