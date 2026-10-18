import type { UserRole } from "@bitovp/db";
import type { AuthMode } from "./config";
import type { SessionDto } from "./dto";
import { parseRole, roleAtLeast, ruleMatchesPath } from "./roles";

/* One page-audience table drives desktop and mobile navigation and direct-URL permission screens. Tests compare its minimum role with the API role floor. This client-side projection supplements the authoritative server API gate; hiding navigation alone never grants or enforces authorization. */
export type Audience =
	/** The everyday operating surface: jobs, channels, feeds, quality, library. */
	| "customer"
	/** Configuration — the Settings tree. Its landing reads at the VIEWER
	 * floor; the ADMIN-only children carry their own rows below. */
	| "operator";

export type PageAccess = {
	readonly audience: Audience;
	readonly minRole: UserRole;
};

export type PageAccessRule = PageAccess & {
	/** Segment-aware prefix, matched with `ruleMatchesPath` exactly as the API
	 * table is — `/settings` does not swallow `/settingsx`. */
	readonly prefix: string;
	/** Which API floor this page's data sits behind — pinned in audience.test.ts. */
	readonly reason: string;
};

/**
 * Every signed-in role clears this floor. Named because two consumers spell
 * "privileged" as "above this" and both must move together if a role is
 * ever added below VIEWER.
 */
const LOWEST_ROLE: UserRole = "VIEWER";

const CUSTOMER_SURFACE: PageAccessRule = {
	prefix: "/",
	audience: "customer",
	minRole: LOWEST_ROLE,
	reason:
		"everything not carved out above: lists and details read at the VIEWER floor (`GET /api/*`); higher-floor actions and panels are bound to the mutation-control catalogue, hidden fail-closed for insufficient roles, and still authorized independently by the API",
};

/**
 * First match wins, most specific first; the `/` catch-all is last and
 * matches every path, so `pageAccess` always answers.
 */
export const PAGE_ACCESS_RULES: readonly PageAccessRule[] = [
	{
		prefix: "/settings/organizations",
		audience: "operator",
		minRole: "ADMIN",
		reason: "Organization membership and view-as management",
	},
	{
		prefix: "/settings/access-audit",
		audience: "operator",
		minRole: "ADMIN",
		reason: "Access history and IP policy management",
	},
	{
		prefix: "/settings/vmaf",
		audience: "operator",
		minRole: "ADMIN",
		reason: "Cloud profiles and credentials are administered by ADMIN",
	},
	{
		prefix: "/settings/users",
		audience: "operator",
		minRole: "ADMIN",
		reason: "user management: /api/users is ADMIN",
	},
	{
		prefix: "/settings/tokens",
		audience: "operator",
		minRole: "ADMIN",
		reason:
			"token inventory: the GET /api/api-tokens list the page opens with is ADMIN (a holder revoking its OWN token rides the CLI, not this page)",
	},
	{
		prefix: "/settings/reset",
		audience: "operator",
		minRole: "ADMIN",
		reason: "the wipe surface: /api/admin is ADMIN",
	},
	{
		prefix: "/vod/new",
		audience: "customer",
		minRole: "OPERATOR",
		reason:
			"the VOD wizard exists to POST /api/encoding-jobs; a VIEWER is kept on the readable job list instead of being refused only after completing the form",
	},
	{
		prefix: "/live/new",
		audience: "customer",
		minRole: "OPERATOR",
		reason:
			"the Live wizard exists to POST /api/live-channels; a VIEWER is kept on the readable channel list instead of being refused only after completing the form",
	},
	{
		prefix: "/storage",
		audience: "customer",
		minRole: "OPERATOR",
		reason:
			"storage browse decrypts and spends a stored credential through GET /api/credentials/[id]/storage/*, whose API floor is OPERATOR",
	},
	{
		prefix: "/settings",
		audience: "operator",
		minRole: LOWEST_ROLE,
		reason:
			"the landing and configuration values read at the VIEWER floor (GET /api/settings, /api/credentials, /api/bitmovin-accounts …); each higher-floor write, reveal, or audit panel is hidden through its mutation-control declaration at the same OPERATOR/ADMIN floor enforced by the API",
	},
	CUSTOMER_SURFACE,
];

/** The rule a page path falls under — never undefined (the catch-all). */
export function pageAccess(pathname: string): PageAccessRule {
	for (const rule of PAGE_ACCESS_RULES) {
		if (ruleMatchesPath(rule.prefix, pathname)) {
			return rule;
		}
	}
	return CUSTOMER_SURFACE;
}

/** Does the lowest role clear it? Such a destination is never hidden or gated. */
export function isFloor(access: PageAccess): boolean {
	return roleAtLeast(LOWEST_ROLE, access.minRole);
}

/**
 * What the client KNOWS about the caller's role — deliberately three-valued,
 * because "no role" means two different things:
 *
 *  - `single-owner`: password / none / oidc mode has no role model at all
 *    (: the role table is inert there), so every
 *    destination stays visible — today's behaviour, unchanged.
 *  - `unresolved`: users mode, but the session is still loading, failed to
 *    load, is not authenticated, or the install is misconfigured. Fail
 *    CLOSED: only floor-level destinations render until the role is known,
 *    so a VIEWER never sees the ADMIN links flash and vanish.
 *  - `role`: users mode, resolved from the DB by the session endpoint (#32
 *    §6 — the cookie carries no role claim).
 */
export type RoleView =
	| { readonly kind: "unresolved" }
	| {
			readonly kind: "single-owner";
			readonly mode: Exclude<AuthMode, "users">;
	  }
	| { readonly kind: "role"; readonly role: UserRole };

const UNRESOLVED: RoleView = { kind: "unresolved" };

export function roleViewFromSession(session: SessionDto | undefined): RoleView {
	if (!session?.configured || !session.authenticated) {
		return UNRESOLVED;
	}
	if (session.mode !== "users") {
		return { kind: "single-owner", mode: session.mode };
	}
	if (session.isImpersonating) return { kind: "role", role: "VIEWER" };
	// The DTO's `role` is typed as the enum, but it arrived over the wire:
	// parse it the way the token gate does, and an unknown value fails closed.
	const role = session.role === undefined ? null : parseRole(session.role);
	return role === null ? UNRESOLVED : { kind: "role", role };
}

/** May this view reach a destination with this access? */
export function canAccess(access: PageAccess, view: RoleView): boolean {
	switch (view.kind) {
		case "single-owner":
			return true;
		case "unresolved":
			return isFloor(access);
		case "role":
			return roleAtLeast(view.role, access.minRole);
	}
}
