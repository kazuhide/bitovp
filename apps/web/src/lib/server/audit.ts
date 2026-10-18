import "server-only";
import { type AuditEntry, writeAuditLog as write } from "@bitovp/db";
import { ACTOR_HEADER } from "@/lib/auth/api-token-gate";
import type { getServerContext } from "./context";

export type { AuditEntry };

/**
 * Web-side wrapper around the shared db audit writer — and the ONE place the
 * verified actor is attached.
 *
 *  measured 2026-08-15: the QC-override route's audit row landed
 * with an EMPTY `actor` although the call carried a Bearer token, and the
 * route's own comment claimed the opposite ("actor rides the shared audit
 * pipeline"). It did not: this wrapper forwarded the entry untouched and
 * nothing else read `ACTOR_HEADER`, which the proxy sets on every
 * authenticated request AFTER stripping any client-supplied copy. Attribution
 * was a comment, not a mechanism.
 *
 * Pass the request and the actor rides. An explicit `entry.actor` still wins,
 * for the routes that resolve a more specific identity themselves.
 *
 * `req` is REQUIRED, and that is the mechanism rather than a style choice.
 * The first cut made it optional and threaded it into the six routes that
 * call this directly; security-review-212 then measured 34 further route
 * files writing audit rows through `auditedBitmovinCall` and
 * `delete*JobLocally`, all still persisting `actor = NULL` under a ledger row
 * that had just been closed as "every route that audits passes it". An
 * optional parameter cannot enumerate its own omissions. A required one makes
 * `tsc` do it, across file boundaries, which a source-shape grep provably
 * could not — the guard it replaces matched the identifier `req` rather than
 * the handler's request, so it certified all 34 of those files as clean.
 */
/**
 * The entry a ROUTE hands this wrapper. `actor` is optional here — that is
 * the wrapper's whole job, filling it from the request — while the db-level
 * writer requires it, so a NEW consumer of the exported writer cannot default
 * to NULL and compile clean .
 */
export type RouteAuditEntry = Omit<AuditEntry, "actor"> & {
	actor?: string | null;
};

export async function writeAuditLog(
	ctx: Awaited<ReturnType<typeof getServerContext>>,
	entry: RouteAuditEntry,
	req: Request,
): Promise<void> {
	// `req.`, not `req?.` — the parameter is required, and optional-chaining a
	// required parameter degrades to a NULL actor instead of failing loudly if
	// it ever becomes reachable (security-review-212, LOW).
	const actor = entry.actor ?? req.headers.get(ACTOR_HEADER) ?? null;
	await write(ctx.prisma, { ...entry, actor });
}

/**
 * The proxy-verified actor on a request, or null when there is none.
 *
 * The one reader of ACTOR_HEADER outside the wrapper, for the audit writers
 * that take an identity rather than a Request (the shared egress recorder,
 * which the worker also calls). Reaching for the string literal instead —
 * as `rate-limit.ts` still does — means renaming the constant silently
 * degrades attribution with nothing going red.
 */
export function actorFrom(req: Request): string | null {
	return req.headers.get(ACTOR_HEADER);
}
