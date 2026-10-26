import type { UserRole } from "@bitovp/db";

/**
 * Role enforcement table  — ONE ordered
 * table, evaluated in the proxy for BOTH actor kinds (session users and API
 * tokens). Pure and client-free on purpose so gate-coverage can enumerate
 * it from disk.
 *
 * Matching is SEGMENT-AWARE, not raw startsWith: a `[param]` segment in a
 * rule matches exactly one concrete path segment, and a literal prefix only
 * matches on a `/` boundary (`/api/live` must never swallow
 * `/api/live-channels/*` — the gate's own underPrefix lesson, §4/N8).
 */
export const USER_ROLES = ["ADMIN", "OPERATOR", "VIEWER"] as const;

/** The request header carrying the DB-RESOLVED role in users mode. Set ONLY
 * by the proxy's forward (which deletes any client-supplied copy — the
 * same forgery rail as ACTOR_HEADER); routes read this, never the cookie
 * (#32 §3: the cookie carries no role claim at all). */
export const ROLE_HEADER = "x-bitovp-role";

const ROLE_RANK: Record<UserRole, number> = {
	ADMIN: 3,
	OPERATOR: 2,
	VIEWER: 1,
};

export function roleAtLeast(actual: UserRole, min: UserRole): boolean {
	return ROLE_RANK[actual] >= ROLE_RANK[min];
}

/** Fail-closed parse for role STRINGS from outside the enum's type system
 * (ApiToken.role is a bare String column): unparseable ⇒ null ⇒ deny . */
export function parseRole(raw: string): UserRole | null {
	return (USER_ROLES as readonly string[]).includes(raw)
		? (raw as UserRole)
		: null;
}

/**
 * The floor an UNPARSEABLE stored role may still clear (#255). `ApiToken.role`
 * is a bare String column, so a row can carry a value this build does not
 * know — a downgrade, a hand-edited row, a role added in a newer build.
 *
 * Users mode has always answered a flat 403 for that, and an ADMIN is on hand
 * to repair the row. Every OTHER mode evaluated no token role at all until
 * #255, so a flat 403 there would brick working machine clients over a value
 * we merely fail to RECOGNISE — a lockout introduced by a bug fix. What must
 * not happen is an unprovable ADMIN: we cannot show the row was minted ADMIN,
 * so it never clears an ADMIN floor, and below that it keeps whatever the mode
 * already gave it.
 *
 * OPERATOR is exactly "every rule except the ADMIN rows" under ROLE_RANK. That
 * equivalence is DERIVED from ROUTE_RULES in roles.test.ts rather than trusted
 * from this literal, so a table edit that invalidates it goes red.
 */
export const UNKNOWN_ROLE_CEILING = "OPERATOR" satisfies UserRole;

export type Method = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";

export type RouteRule = {
	readonly prefix: string;
	/** Omitted = every method. */
	readonly methods?: readonly Method[];
	readonly minRole: UserRole;
	/** Why this row exists — rendered nowhere, read by reviewers. */
	readonly reason: string;
};

const WRITE_METHODS = ["POST", "PUT", "PATCH", "DELETE"] as const;

/**
 * First-match wins, most-specific first. The REVEAL class sits ABOVE the
 * GET catch-all — load-bearing under first-match (§4/B3).
 */
export const ROUTE_RULES: readonly RouteRule[] = [
	{
		prefix: "/api/per-title-simulator/encodings/import",
		methods: ["POST"],
		minRole: "ADMIN",
		reason:
			"Organization-scoped provider import using saved or temporary credentials",
	},
	{
		prefix: "/api/access-events",
		minRole: "ADMIN",
		reason: "Organization access history",
	},
	{
		prefix: "/api/organizations/[id]",
		minRole: "ADMIN",
		reason: "Organization policy management",
	},
	{
		prefix: "/api/organizations",
		methods: ["GET", "HEAD"],
		minRole: "VIEWER",
		reason: "Own organization membership list",
	},
	{
		prefix: "/api/organizations",
		minRole: "ADMIN",
		reason: "Organization management with independent owner/member checks",
	},
	{
		prefix: "/api/platform",
		minRole: "ADMIN",
		reason: "Platform owner management; owner checked independently",
	},
	{
		prefix: "/api/account/organizations",
		methods: ["GET", "HEAD"],
		minRole: "VIEWER",
		reason: "Own organization choices",
	},
	{
		prefix: "/api/account/organization",
		methods: ["POST"],
		minRole: "VIEWER",
		reason: "Own active organization selection",
	},
	{
		prefix: "/api/account/impersonation",
		methods: ["POST", "DELETE"],
		minRole: "VIEWER",
		reason: "Owner view-as entry and exit with independent owner proof",
	},
	{
		prefix: "/api/settings/vmaf-profiles",
		minRole: "ADMIN",
		reason: "Cloud execution profile administration",
	},
	{
		prefix: "/api/settings/vmaf-credentials",
		minRole: "ADMIN",
		reason: "Cloud credential inventory and writes",
	},
	{
		prefix: "/api/live/stream-keys/[id]",
		methods: ["GET", "HEAD"],
		minRole: "OPERATOR",
		reason:
			"REVEAL class: only the [id] GET returns the ingest key VALUE — the base list withholds values and remains a VIEWER read",
	},
	{
		prefix: "/api/credentials/[id]/storage",
		methods: ["GET", "HEAD"],
		minRole: "OPERATOR",
		reason:
			"REVEAL class: browse decrypts and USES the customer storage credential for outbound listing",
	},
	{
		// ABOVE the paged log rule: ruleMatchesPath lets a path continue past a
		// rule, so the OPERATOR row below would otherwise claim /export first.
		prefix: "/api/live-channels/[id]/runs/[runId]/heartbeats/export",
		methods: ["GET", "HEAD"],
		minRole: "ADMIN",
		reason:
			"bulk pull of a whole run's provider telemetry as a file — an admin act, listed in API-USAGE",
	},
	{
		prefix: "/api/live-channels/[id]/runs/[runId]/heartbeat-receipts",
		methods: ["GET", "HEAD"],
		minRole: "OPERATOR",
		reason:
			"run-bound signed Push receipt diagnostics, same floor as the Poll log",
	},
	{
		prefix: "/api/live-channels/[id]/runs/[runId]/heartbeats",
		methods: ["GET", "HEAD"],
		minRole: "OPERATOR",
		reason:
			"the per-run heartbeat log: raw provider samples are diagnostic detail above the VIEWER read floor of the channel page",
	},
	{
		prefix: "/api/live-channels/[id]/runs/[runId]/diagnostics",
		methods: ["GET", "HEAD"],
		minRole: "OPERATOR",
		reason: "Run-bound provider statistics, events and SRT diagnostics",
	},
	{
		prefix: "/api/live-channels/[id]/runs/[runId]/final-heartbeat",
		methods: ["GET", "HEAD"],
		minRole: "ADMIN",
		reason: "Reveals a download URL for a completed run's provider telemetry",
	},
	{
		prefix: "/api/audit-logs",
		minRole: "ADMIN",
		reason: "security telemetry: full audit history",
	},
	{
		prefix: "/api/api-tokens",
		minRole: "ADMIN",
		reason:
			"token inventory (GET) and mint/revoke (writes) — durable-credential creation is an admin act (§4, above the reviewer's minimum by decision)",
	},
	{
		prefix: "/api/users",
		minRole: "ADMIN",
		reason: "user management",
	},
	{
		prefix: "/api/admin",
		minRole: "ADMIN",
		reason: "the reset surface — WIPE EVERY OPERATIONAL ROW lives here (§4/B2)",
	},
	{
		prefix: "/api/credentials",
		methods: WRITE_METHODS,
		minRole: "ADMIN",
		reason: "credential writes",
	},
	{
		prefix: "/api/bitmovin-accounts",
		methods: WRITE_METHODS,
		minRole: "ADMIN",
		reason: "Bitmovin account writes",
	},
	{
		prefix: "/api/settings",
		methods: WRITE_METHODS,
		minRole: "ADMIN",
		reason:
			"settings writes — explicitly including the billable POST /api/settings/startup-probes/run (§4/N7)",
	},
	{
		// The dead-rule test caught the first draft of these two pointing at
		// /api/prewarmed-pools — a path that does not exist (the pools live
		// under /api/infrastructure/…). Exactly the typo'd-protection class
		// the §4 coverage extension exists for, demonstrated on its author.
		prefix: "/api/infrastructure/prewarmed-pools",
		methods: WRITE_METHODS,
		minRole: "ADMIN",
		reason: "billable pool start/stop and capacity writes",
	},
	{
		// Second dead-rule catch, same session: standby pools live under
		// /api/live/standby-pools, not /api/infrastructure/… and not the
		// design table's bare /api/standby-pools.
		prefix: "/api/live/standby-pools",
		methods: WRITE_METHODS,
		minRole: "ADMIN",
		reason: "billable pool start/stop and capacity writes",
	},
	{
		prefix: "/api/account/password",
		// review-32 m6: scoped to the methods that exist — a future route
		// under /api/account does not silently inherit the VIEWER floor.
		methods: ["GET", "HEAD", "POST"],
		minRole: "VIEWER",
		reason:
			"self-service account surface (password rotate) — every signed-in role acts on ITSELF here; the OPERATOR write catch-all below would lock a VIEWER out of their own forced rotate",
	},
	{
		prefix: "/api",
		methods: ["GET", "HEAD"],
		minRole: "VIEWER",
		reason: "reads (lists, details, exports) — everything NOT carved out above",
	},
	{
		prefix: "/api",
		minRole: "OPERATOR",
		reason:
			"operational writes: job/channel/feeder/VMAF create-cancel-rerun, live actions, DELETEs, and the destructive POSTs that escape the verb (bulk-delete/bulk-cancel/unassign/insertable-content-stop)",
	},
] as const;

/**
 * THE ONE SUBJECT-SCOPED EXCEPTION to the table above (#255, review-189 I5).
 *
 * `/api/api-tokens` sits at an ADMIN floor for two good reasons: the inventory
 * `GET` lists every credential in the install, and revoking SOMEONE ELSE'S
 * token is an admin act (the leaked-token chain review-189 I5 cut). Neither
 * reason covers a holder DELETEing its OWN token — that is the documented CI
 * kill-switch for a leaked credential, and it is strictly de-privileging: the
 * worst a caller can do with it is lock itself out.
 *
 * So the exception is scoped by SUBJECT, not by route: `DELETE
 * /api/api-tokens/<id>` clears the floor only when `<id>` IS the caller's own
 * verified token id. It does not widen the GET, it does not widen any other
 * id, and it grants no role — the handler's own self-only rail still decides
 * the outcome (`[id]/route.ts`: 204 self, 403 other, 404 unknown). This only
 * stops the proxy refusing before that rail can run.
 *
 * An UNPARSEABLE role keeps it too. A holder who cannot prove a role can still
 * kill their own token — the safe direction, since the alternative is a leaked
 * credential nobody but an admin can revoke.
 *
 * Named and exported so it is reviewable beside ROUTE_RULES rather than hidden
 * as an `if` in the proxy; `isSelfTokenRevocation` derives its matching from
 * these fields, so the two cannot drift.
 */
export const SELF_REVOCATION_EXCEPTION: {
	readonly prefix: string;
	readonly method: Method;
	readonly reason: string;
} = {
	prefix: "/api/api-tokens/[id]",
	method: "DELETE",
	reason:
		"a token may always revoke ITSELF — the CI kill-switch for a leaked credential (review-189 I5); the inventory GET and every OTHER id stay ADMIN",
};

/**
 * Does this request spend SELF_REVOCATION_EXCEPTION? The `[id]` segment must
 * equal the caller's verified token id EXACTLY, and the path may not continue
 * past it — a sub-resource under a token id is not this exception.
 */
export function isSelfTokenRevocation(
	tokenId: string,
	path: string,
	method: string,
): boolean {
	if (
		tokenId === "" ||
		method.toUpperCase() !== SELF_REVOCATION_EXCEPTION.method
	) {
		return false;
	}
	const ruleSegments = splitStrict(SELF_REVOCATION_EXCEPTION.prefix);
	const pathSegments = splitStrict(normalize(path));
	// Two gates, and the ORDER is load-bearing.
	//
	// Exact length, because ruleMatchesPath lets a path continue PAST the rule
	// — right for a floor, wrong for an exception.
	//
	// And it runs on STRICTLY split segments (rev363 S3): splitStrict keeps
	// interior and trailing empties, so `/api/api-tokens//<id>` is FOUR
	// segments and dies here. ruleMatchesPath filters them away, which is
	// right for a FLOOR (a client's odd spelling must not duck a role check)
	// and wrong for an EXCEPTION, which should match exactly one shape and
	// nothing else. So this gate is what makes the exception strict; do not
	// reorder it below the ruleMatchesPath call.
	if (pathSegments.length !== ruleSegments.length) {
		return false;
	}
	if (!ruleMatchesPath(SELF_REVOCATION_EXCEPTION.prefix, path)) {
		return false;
	}
	const subject = ruleSegments.findIndex(
		(segment) => segment.startsWith("[") && segment.endsWith("]"),
	);
	return subject >= 0 && pathSegments[subject] === tokenId;
}

/**
 * Path → segments WITHOUT collapsing empty ones (rev363 S3). A leading `/`
 * always produces one empty head, which is an artefact of the separator and
 * not a segment; every OTHER empty is a real `//` the client typed, and it has
 * to survive so one resource cannot be spelled two ways past an exception.
 */
function splitStrict(path: string): string[] {
	const segments = path.split("/");
	return segments[0] === "" ? segments.slice(1) : segments;
}

/** One trailing slash normalized away, mirroring gate.ts. */
function normalize(pathname: string): string {
	if (pathname.length > 1 && pathname.endsWith("/")) {
		return pathname.slice(0, -1);
	}
	return pathname === "" ? "/" : pathname;
}

/**
 * Segment-aware boundary match: every rule segment must equal the path
 * segment, `[param]` matching any ONE segment; the path may continue past
 * the rule only across a `/` boundary (which segment splitting gives us for
 * free). `/api/live` vs `/api/live-channels` is the pinned regression.
 */
export function ruleMatchesPath(rulePrefix: string, path: string): boolean {
	const ruleSegments = rulePrefix.split("/").filter((s) => s !== "");
	const pathSegments = normalize(path)
		.split("/")
		.filter((s) => s !== "");
	if (pathSegments.length < ruleSegments.length) {
		return false;
	}
	for (let i = 0; i < ruleSegments.length; i += 1) {
		const rule = ruleSegments[i] as string;
		if (rule.startsWith("[") && rule.endsWith("]")) {
			continue;
		}
		if (rule !== pathSegments[i]) {
			return false;
		}
	}
	return true;
}

export type RoleDecision = {
	readonly allowed: boolean;
	readonly minRole: UserRole;
	/** Null = the ADMIN fallback fired (no rule matched — §4/B2). */
	readonly rule: RouteRule | null;
};

/**
 * The §4 decision. UNMATCHED route×method ⇒ ADMIN (fail closed — nothing
 * silently opens when a new route lands before its rule; §10 mutation 2
 * pins this fallback's existence).
 */
export function evaluateRole(
	role: UserRole,
	path: string,
	method: string,
): RoleDecision {
	const upper = method.toUpperCase();
	for (const rule of ROUTE_RULES) {
		if (rule.methods && !(rule.methods as readonly string[]).includes(upper)) {
			continue;
		}
		if (ruleMatchesPath(rule.prefix, path)) {
			return {
				allowed: roleAtLeast(role, rule.minRole),
				minRole: rule.minRole,
				rule,
			};
		}
	}
	return { allowed: roleAtLeast(role, "ADMIN"), minRole: "ADMIN", rule: null };
}
