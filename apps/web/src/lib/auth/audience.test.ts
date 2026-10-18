import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	canAccess,
	isFloor,
	PAGE_ACCESS_RULES,
	type PageAccess,
	pageAccess,
	type RoleView,
	roleViewFromSession,
} from "./audience";
import type { SessionDto } from "./dto";
import { evaluateRole, ruleMatchesPath, USER_ROLES } from "./roles";

/**
 * The page-level half of the role model (audit 5c3d97ca MEDIUM-5 / AU-01).
 *
 * The closure criterion the audit set is "client filtering AND server
 * authorization agree", so the load-bearing block here is the last one: for
 * every role, a page's `canAccess` must equal `evaluateRole` on the API that
 * page reads. Deleting the page rule or the API rule for the SDK census goes
 * red there, in opposite directions.
 */

function usersSession(overrides: Partial<SessionDto> = {}): SessionDto {
	return {
		mode: "users",
		configured: true,
		authenticated: true,
		loginKind: "password-form",
		displayName: "Alice",
		role: "VIEWER",
		...overrides,
	};
}

const APP_DIR = join(__dirname, "../../app");

type SurfaceContract = {
	page: string;
	floor: "VIEWER" | "OPERATOR" | "ADMIN";
	api?: string;
	method?: "GET" | "POST" | "PATCH" | "DELETE";
};

/**
 * One PRIMARY contract for every App Router page behind AppShell. This is
 * intentionally written out rather than derived from PAGE_ACCESS_RULES or
 * source-text guesses: adding a page forces its author to name the API that
 * makes the screen useful and the role that API requires. Standalone auth
 * pages are excluded below because AppShell deliberately bypasses this gate.
 */
const PRIMARY_SURFACES: readonly SurfaceContract[] = [
	{
		page: "/settings/organizations",
		floor: "ADMIN",
		api: "/api/platform/organizations/org-1/members",
		method: "GET",
	},
	{
		page: "/settings/access-audit",
		floor: "ADMIN",
		api: "/api/access-events",
		method: "GET",
	},
	{
		page: "/settings/vmaf",
		floor: "ADMIN",
		api: "/api/settings/vmaf-profiles",
		method: "GET",
	},
	{ page: "/", floor: "VIEWER", api: "/api/dashboard/usage", method: "GET" },
	{ page: "/library", floor: "VIEWER", api: "/api/library", method: "GET" },
	{
		page: "/library/[id]",
		floor: "VIEWER",
		api: "/api/library/content-1",
		method: "GET",
	},
	{
		page: "/live/[id]",
		floor: "VIEWER",
		api: "/api/live-channels/channel-1",
		method: "GET",
	},
	{
		page: "/live/feeders/[id]",
		floor: "VIEWER",
		api: "/api/feeder-sessions/session-1",
		method: "GET",
	},
	{
		page: "/live/feeders",
		floor: "VIEWER",
		api: "/api/feeder-sessions",
		method: "GET",
	},
	{
		page: "/live/new",
		floor: "OPERATOR",
		api: "/api/live-channels",
		method: "POST",
	},
	{
		page: "/live",
		floor: "VIEWER",
		api: "/api/live-channels",
		method: "GET",
	},
	{
		page: "/presets",
		floor: "VIEWER",
		api: "/api/presets",
		method: "GET",
	},
	{
		page: "/qc/[id]",
		floor: "VIEWER",
		api: "/api/vmaf-jobs/job-1",
		method: "GET",
	},
	{
		page: "/qc/compare",
		floor: "VIEWER",
		api: "/api/vmaf-jobs/job-1",
		method: "GET",
	},
	{ page: "/qc", floor: "VIEWER", api: "/api/vmaf-jobs", method: "GET" },
	{
		page: "/settings/api-coverage",
		floor: "VIEWER",
	},
	{
		page: "/settings/bitmovin",
		floor: "VIEWER",
		api: "/api/bitmovin-accounts",
		method: "GET",
	},
	{
		page: "/settings/credentials",
		floor: "VIEWER",
		api: "/api/credentials",
		method: "GET",
	},
	{
		page: "/settings/features",
		floor: "VIEWER",
		api: "/api/settings/features",
		method: "GET",
	},
	{
		page: "/settings/infrastructure",
		floor: "VIEWER",
		api: "/api/bitmovin-accounts",
		method: "GET",
	},
	{
		page: "/settings/live",
		floor: "VIEWER",
		api: "/api/live/stream-keys",
		method: "GET",
	},
	{
		page: "/settings/notifications",
		floor: "VIEWER",
		api: "/api/notifications/channels",
		method: "GET",
	},
	{
		page: "/settings/branding",
		floor: "VIEWER",
		api: "/api/settings/branding",
		method: "GET",
	},
	{
		page: "/settings/player",
		floor: "VIEWER",
		api: "/api/settings/player",
		method: "GET",
	},
	{
		page: "/settings/reset",
		floor: "ADMIN",
		api: "/api/admin/reset",
		method: "GET",
	},
	{
		page: "/settings/tokens",
		floor: "ADMIN",
		api: "/api/api-tokens",
		method: "GET",
	},
	{
		page: "/settings/users",
		floor: "ADMIN",
		api: "/api/users",
		method: "GET",
	},
	{
		page: "/settings/watch-folders",
		floor: "VIEWER",
		api: "/api/watch-rules",
		method: "GET",
	},
	{
		page: "/settings/webhooks",
		floor: "VIEWER",
		api: "/api/webhook-events",
		method: "GET",
	},
	// Static directory of settings destinations; it has no primary data API.
	{ page: "/settings", floor: "VIEWER" },
	{ page: "/settings/basic", floor: "VIEWER" },
	{
		page: "/storage",
		floor: "OPERATOR",
		api: "/api/credentials/credential-1/storage/objects",
		method: "GET",
	},
	{
		page: "/templates",
		floor: "VIEWER",
		api: "/api/presets",
		method: "GET",
	},
	{
		page: "/verification/[id]",
		floor: "VIEWER",
	},
	{
		page: "/verification",
		floor: "VIEWER",
	},
	{
		page: "/vod/jobs/[id]",
		floor: "VIEWER",
		api: "/api/encoding-jobs/job-1",
		method: "GET",
	},
	{
		page: "/vod/jobs",
		floor: "VIEWER",
		api: "/api/encoding-jobs",
		method: "GET",
	},
	{
		page: "/vod/new",
		floor: "OPERATOR",
		api: "/api/encoding-jobs",
		method: "POST",
	},
] as const;

/** Higher-floor panels/actions embedded in otherwise readable pages. */
const MIXED_SURFACES: readonly SurfaceContract[] = [
	{
		page: "/live",
		floor: "OPERATOR",
		api: "/api/live-channels",
		method: "POST",
	},
	{
		page: "/live/[id]",
		floor: "OPERATOR",
		api: "/api/live-channels/channel-1/actions",
		method: "POST",
	},
	{
		page: "/live/feeders",
		floor: "OPERATOR",
		api: "/api/feeder-sessions/session-1",
		method: "DELETE",
	},
	{ page: "/presets", floor: "OPERATOR", api: "/api/presets", method: "POST" },
	{ page: "/qc", floor: "OPERATOR", api: "/api/vmaf-jobs", method: "POST" },
	{
		page: "/qc/[id]",
		floor: "OPERATOR",
		api: "/api/vmaf-jobs/job-1/cancel",
		method: "POST",
	},
	{
		page: "/settings/bitmovin",
		floor: "ADMIN",
		api: "/api/bitmovin-accounts",
		method: "POST",
	},
	{
		page: "/settings/credentials",
		floor: "ADMIN",
		api: "/api/credentials",
		method: "POST",
	},
	{
		page: "/settings/features",
		floor: "ADMIN",
		api: "/api/settings/features",
		method: "PATCH",
	},
	{
		page: "/settings/infrastructure",
		floor: "ADMIN",
		api: "/api/infrastructure/prewarmed-pools",
		method: "POST",
	},
	{
		page: "/settings/live",
		floor: "OPERATOR",
		api: "/api/live/stream-keys/key-1",
		method: "GET",
	},
	{
		page: "/settings/live",
		floor: "ADMIN",
		api: "/api/settings/startup-probes/run",
		method: "POST",
	},
	{
		page: "/settings/notifications",
		floor: "OPERATOR",
		api: "/api/notifications/channels",
		method: "POST",
	},
	{
		page: "/settings/player",
		floor: "ADMIN",
		api: "/api/settings/player",
		method: "PATCH",
	},
	{
		page: "/settings/watch-folders",
		floor: "OPERATOR",
		api: "/api/watch-rules",
		method: "POST",
	},
	{
		page: "/settings/webhooks",
		floor: "ADMIN",
		api: "/api/audit-logs",
		method: "GET",
	},
	{
		page: "/settings/webhooks",
		floor: "OPERATOR",
		api: "/api/webhook-registration",
		method: "POST",
	},
	{
		page: "/templates",
		floor: "OPERATOR",
		api: "/api/encoding-jobs",
		method: "POST",
	},
	{
		page: "/vod/jobs",
		floor: "OPERATOR",
		api: "/api/encoding-jobs/bulk-re-run",
		method: "POST",
	},
	{
		page: "/vod/jobs/[id]",
		floor: "OPERATOR",
		api: "/api/encoding-jobs/job-1/retry",
		method: "POST",
	},
] as const;

/** Every `page.tsx` under the app router, as the route path it serves. */
function pagePaths(dir: string, prefix = ""): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			if (entry === "api") {
				continue;
			}
			out.push(...pagePaths(full, `${prefix}/${entry}`));
		} else if (entry === "page.tsx") {
			out.push(prefix === "" ? "/" : prefix);
		}
	}
	return out;
}

describe("pageAccess", () => {
	// EXPECTED values written out, never derived from the table under test.
	it.each([
		["/verification", "customer", "VIEWER"],
		["/verification/run-123", "customer", "VIEWER"],
		["/settings/api-coverage", "operator", "VIEWER"],
		["/settings/users", "operator", "ADMIN"],
		["/settings/tokens", "operator", "ADMIN"],
		["/settings/reset", "operator", "ADMIN"],
		["/settings", "operator", "VIEWER"],
		["/settings/bitmovin", "operator", "VIEWER"],
		["/settings/webhooks", "operator", "VIEWER"],
		["/vod/new", "customer", "OPERATOR"],
		["/live/new", "customer", "OPERATOR"],
		["/", "customer", "VIEWER"],
		["/vod/jobs", "customer", "VIEWER"],
		["/vod/jobs/abc", "customer", "VIEWER"],
		["/live/abc", "customer", "VIEWER"],
		["/live/feeders", "customer", "VIEWER"],
		["/qc", "customer", "VIEWER"],
		["/storage", "customer", "OPERATOR"],
		// Segment boundary: a sibling that merely STARTS with a rule's prefix
		// is not under it — the same lesson the API table learned from
		// /api/live vs /api/live-channels.
		["/verifications", "customer", "VIEWER"],
		["/settingsx", "customer", "VIEWER"],
	] as const)("%s → %s / %s", (path, audience, minRole) => {
		expect(pageAccess(path)).toMatchObject({ audience, minRole });
	});

	it("normalizes a trailing slash the way the gate does", () => {
		expect(pageAccess("/verification/").minRole).toBe("VIEWER");
		expect(pageAccess("/settings/users/").minRole).toBe("ADMIN");
	});

	it("ends with the customer catch-all, so every path has an answer", () => {
		const last = PAGE_ACCESS_RULES[PAGE_ACCESS_RULES.length - 1];
		expect(last?.prefix).toBe("/");
		expect(last?.audience).toBe("customer");
		expect(last?.minRole).toBe("VIEWER");
		expect(pageAccess("/no/such/page")).toBe(last);
	});

	it("every rule prefix points at a REAL page subtree — a dead rule is a typo'd protection", () => {
		const pages = pagePaths(APP_DIR);
		// Sanity: a broken walk must not pass vacuously.
		expect(pages).toContain("/verification");
		expect(pages).toContain("/settings/api-coverage");
		const dead = PAGE_ACCESS_RULES.map((rule) => rule.prefix).filter(
			(prefix) =>
				prefix !== "/" && !pages.some((page) => ruleMatchesPath(prefix, page)),
		);
		expect(dead).toEqual([]);
	});

	it("carries a reason on every rule — rendered nowhere, read by reviewers", () => {
		for (const rule of PAGE_ACCESS_RULES) {
			expect(rule.reason.length, rule.prefix).toBeGreaterThan(20);
		}
	});
});

describe("page floors agree with the API floors the pages read — the audit's closure criterion", () => {
	// Page ↔ the API call that page cannot render without, with the method
	// it uses. For EVERY role the two answers must be the same boolean, so
	// a floor moved on one side goes red here no matter which side moved.
	it.each([
		["/settings/vmaf", "/api/settings/vmaf-profiles", "GET"],
		["/settings/vmaf", "/api/settings/vmaf-credentials", "GET"],
		["/settings/users", "/api/users", "GET"],
		["/settings/tokens", "/api/api-tokens", "GET"],
		["/settings/reset", "/api/admin/reset", "POST"],
		["/settings/features", "/api/settings/features", "GET"],
		["/settings/bitmovin", "/api/bitmovin-accounts", "GET"],
		["/vod/jobs", "/api/encoding-jobs", "GET"],
		["/live", "/api/live-channels", "GET"],
		["/qc", "/api/vmaf-jobs", "GET"],
		["/qc", "/api/vmaf-compute-profiles", "GET"],
		["/vod/new", "/api/encoding-jobs", "POST"],
		["/live/new", "/api/live-channels", "POST"],
		["/storage", "/api/credentials/credential-1/storage/objects", "GET"],
	] as const)("%s ↔ %s %s", (page, api, method) => {
		for (const role of USER_ROLES) {
			expect(
				canAccess(pageAccess(page), { kind: "role", role }),
				`${role} at ${page}`,
			).toBe(evaluateRole(role, api, method).allowed);
		}
	});
});

describe("complete page/API/action role contract", () => {
	it("names exactly one primary contract for every AppShell page on disk", () => {
		const standalone = new Set(["/change-password", "/login", "/setup"]);
		const onDisk = pagePaths(APP_DIR)
			.filter((page) => !standalone.has(page))
			.sort();
		const mapped = PRIMARY_SURFACES.map((surface) => surface.page).sort();
		expect(mapped).toEqual(onDisk);
	});

	it.each(
		PRIMARY_SURFACES,
	)("primary $page is $floor and agrees with $method $api", (surface) => {
		expect(pageAccess(surface.page).minRole).toBe(surface.floor);
		if (surface.api && surface.method) {
			expect(
				evaluateRole(surface.floor, surface.api, surface.method).minRole,
			).toBe(surface.floor);
		}
	});

	it.each(
		MIXED_SURFACES,
	)("mixed $page embeds a $floor surface at $method $api", (surface) => {
		expect(surface.api).toBeDefined();
		expect(surface.method).toBeDefined();
		expect(
			evaluateRole(
				surface.floor,
				surface.api as string,
				surface.method as string,
			).minRole,
		).toBe(surface.floor);
	});
});

describe("roleViewFromSession", () => {
	it("withholds write surfaces during owner view-as, including an ADMIN target", () => {
		expect(
			roleViewFromSession(
				usersSession({ role: "ADMIN", isImpersonating: true }),
			),
		).toEqual({ kind: "role", role: "VIEWER" });
	});
	it("is unresolved while there is no session at all (loading, or the fetch failed)", () => {
		expect(roleViewFromSession(undefined)).toEqual({ kind: "unresolved" });
	});

	it("is unresolved for a misconfigured install and for an unauthenticated caller", () => {
		expect(
			roleViewFromSession(usersSession({ configured: false, role: "ADMIN" })),
		).toEqual({ kind: "unresolved" });
		expect(
			roleViewFromSession(
				usersSession({ authenticated: false, role: "ADMIN" }),
			),
		).toEqual({ kind: "unresolved" });
	});

	it("is single-owner in password and none mode — no role model, today's behaviour", () => {
		expect(
			roleViewFromSession({
				mode: "password",
				configured: true,
				authenticated: true,
				loginKind: "password-form",
			}),
		).toEqual({ kind: "single-owner", mode: "password" });
		expect(
			roleViewFromSession({
				mode: "none",
				configured: true,
				authenticated: true,
				loginKind: "disabled",
			}),
		).toEqual({ kind: "single-owner", mode: "none" });
	});

	it("resolves the DB role in users mode", () => {
		for (const role of USER_ROLES) {
			expect(roleViewFromSession(usersSession({ role }))).toEqual({
				kind: "role",
				role,
			});
		}
	});

	it("fails closed on a users-mode session with no parseable role", () => {
		expect(roleViewFromSession(usersSession({ role: undefined }))).toEqual({
			kind: "unresolved",
		});
		// Over the wire the field is a string; a value this build does not
		// know is denied, not promoted — the token gate's rule (parseRole).
		expect(
			roleViewFromSession(
				usersSession({ role: "ROOT" as unknown as SessionDto["role"] }),
			),
		).toEqual({ kind: "unresolved" });
	});
});

describe("canAccess", () => {
	const FLOORS = ["VIEWER", "OPERATOR", "ADMIN"] as const;
	const RANK = { VIEWER: 1, OPERATOR: 2, ADMIN: 3 } as const;
	const access = (minRole: (typeof FLOORS)[number]): PageAccess => ({
		audience: "customer",
		minRole,
	});

	it("single-owner reaches everything", () => {
		const view: RoleView = { kind: "single-owner", mode: "password" };
		for (const floor of FLOORS) {
			expect(canAccess(access(floor), view), floor).toBe(true);
		}
	});

	it("unresolved reaches ONLY the floor — privileged destinations stay hidden (fail closed)", () => {
		const view: RoleView = { kind: "unresolved" };
		expect(canAccess(access("VIEWER"), view)).toBe(true);
		expect(canAccess(access("OPERATOR"), view)).toBe(false);
		expect(canAccess(access("ADMIN"), view)).toBe(false);
	});

	it.each(
		USER_ROLES.flatMap((role) => FLOORS.map((floor) => [role, floor] as const)),
	)("role %s against floor %s follows the rank order", (role, floor) => {
		expect(canAccess(access(floor), { kind: "role", role })).toBe(
			RANK[role] >= RANK[floor],
		);
	});

	it("isFloor is exactly 'the lowest role clears it'", () => {
		expect(isFloor(access("VIEWER"))).toBe(true);
		expect(isFloor(access("OPERATOR"))).toBe(false);
		expect(isFloor(access("ADMIN"))).toBe(false);
	});
});
