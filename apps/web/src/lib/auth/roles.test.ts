import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyPath } from "./gate";
import {
	evaluateRole,
	isSelfTokenRevocation,
	parseRole,
	ROUTE_RULES,
	ruleMatchesPath,
	SELF_REVOCATION_EXCEPTION,
	UNKNOWN_ROLE_CEILING,
	USER_ROLES,
} from "./roles";

/**
 *  §4/§10 — the role table's contracts, including the three
 * review-blocker mutations' unit halves (the proxy wiring halves live in
 * proxy-roles.test.ts):
 *  - the REVEAL class sits ABOVE the GET catch-all (first-match-wins);
 *  - an UNMATCHED route×method requires ADMIN (delete the fallback ⇒ red);
 *  - /api/live must never swallow /api/live-channels (segment boundary);
 *  - every on-disk api-guarded route×method matches a rule — from disk,
 *    the gate-coverage idiom extended to authorization.
 */

describe("parseRole (fail-closed for the bare ApiToken.role column)", () => {
	it("accepts exactly the three roles and denies everything else", () => {
		expect(parseRole("ADMIN")).toBe("ADMIN");
		expect(parseRole("OPERATOR")).toBe("OPERATOR");
		expect(parseRole("VIEWER")).toBe("VIEWER");
		expect(parseRole("admin")).toBeNull();
		expect(parseRole("OWNER")).toBeNull();
		expect(parseRole("")).toBeNull();
	});
});

describe("UNKNOWN_ROLE_CEILING (#255)", () => {
	it("clears exactly the rows that are NOT ADMIN — derived from ROUTE_RULES, not read off the literal", () => {
		// The claim the constant makes is a property of the TABLE: "refuse the
		// ADMIN floors, allow everything below". Written as a literal it would
		// rot the moment a rule's floor moved, so it is re-derived here from
		// every rule in the table. Each rule is probed with a method it
		// actually declares (or DELETE, which no method-list row admits, so a
		// method-less row is reached as itself).
		const floorsSeen = new Set<string>();
		for (const rule of ROUTE_RULES) {
			const method = rule.methods?.[0] ?? "DELETE";
			const path = rule.prefix.replace(/\[[^\]]+\]/g, "sample");
			const decision = evaluateRole(UNKNOWN_ROLE_CEILING, path, method);
			floorsSeen.add(decision.minRole);
			expect(
				decision.allowed,
				`${method} ${path} → floor ${decision.minRole}`,
			).toBe(decision.minRole !== "ADMIN");
		}
		// Not vacuous in EITHER direction: raising the ceiling to ADMIN and
		// lowering it to VIEWER each go red only because all three floors are
		// exercised above.
		expect([...floorsSeen].sort()).toEqual(["ADMIN", "OPERATOR", "VIEWER"]);
		// And the UNMATCHED fallback is ADMIN, so an unrecognised role never
		// rides a route that landed before its rule.
		expect(
			evaluateRole(UNKNOWN_ROLE_CEILING, "/not-api/anything", "POST").allowed,
		).toBe(false);
	});
});

describe("SELF_REVOCATION_EXCEPTION (#255 / review-189 I5)", () => {
	const OWN = "00000000-0000-4000-8000-0000000000a1";
	const OTHER = "00000000-0000-4000-8000-0000000000b2";

	it("matches a DELETE of the caller's OWN id, and nothing else", () => {
		expect(isSelfTokenRevocation(OWN, `/api/api-tokens/${OWN}`, "DELETE")).toBe(
			true,
		);
		// Case-insensitive method, the way evaluateRole reads it.
		expect(isSelfTokenRevocation(OWN, `/api/api-tokens/${OWN}`, "delete")).toBe(
			true,
		);
		// A trailing slash is the same request.
		expect(
			isSelfTokenRevocation(OWN, `/api/api-tokens/${OWN}/`, "DELETE"),
		).toBe(true);
		// Someone ELSE'S token stays an admin act.
		expect(
			isSelfTokenRevocation(OWN, `/api/api-tokens/${OTHER}`, "DELETE"),
		).toBe(false);
		// The exception is a DELETE, not a licence to read the row or the list.
		expect(isSelfTokenRevocation(OWN, `/api/api-tokens/${OWN}`, "GET")).toBe(
			false,
		);
		expect(isSelfTokenRevocation(OWN, "/api/api-tokens", "DELETE")).toBe(false);
		// It does not extend PAST the id — a sub-resource is a different route.
		expect(
			isSelfTokenRevocation(OWN, `/api/api-tokens/${OWN}/secret`, "DELETE"),
		).toBe(false);
		// Nor to a lookalike prefix (`ruleMatchesPath`'s boundary lesson).
		expect(
			isSelfTokenRevocation(OWN, `/api/api-tokens-archive/${OWN}`, "DELETE"),
		).toBe(false);
		// An empty verified id must never match an empty-ish path.
		expect(isSelfTokenRevocation("", "/api/api-tokens/", "DELETE")).toBe(false);
		// EMPTY INTERIOR SEGMENTS are refused (rev363 S3). These were accepted:
		// segments were filtered before the count, so `//` collapsed and the
		// path matched. Never a widening — the subject was still the caller's
		// own id — but an exception that accepts several spellings of one
		// request is one whose shape nobody can state, so it takes exactly one.
		expect(
			isSelfTokenRevocation(OWN, `/api/api-tokens//${OWN}`, "DELETE"),
		).toBe(false);
		expect(
			isSelfTokenRevocation(OWN, `/api/api-tokens/${OWN}//`, "DELETE"),
		).toBe(false);
		expect(
			isSelfTokenRevocation(OWN, `//api/api-tokens/${OWN}`, "DELETE"),
		).toBe(false);
		// The ONE trailing slash normalize strips is still the same request —
		// the strictness must not eat the shape the arm above pins.
		expect(
			isSelfTokenRevocation(OWN, `/api/api-tokens/${OWN}/`, "DELETE"),
		).toBe(true);
	});

	it("lifts a floor that is really there — otherwise it is decoration", () => {
		// If the route table ever stopped putting /api/api-tokens at ADMIN, this
		// exception would be granting nothing and its docblock would be lying
		// about why it exists. (Its prefix is checked against the routes ON DISK
		// by the dead-rule test below, which now counts it in its population.)
		expect(
			evaluateRole("OPERATOR", "/api/api-tokens/abc", "DELETE").minRole,
		).toBe("ADMIN");
		expect(SELF_REVOCATION_EXCEPTION.reason.length).toBeGreaterThan(20);
	});
});

describe("segment-aware prefix matching", () => {
	it("/api/live does NOT swallow /api/live-channels — the pinned regression", () => {
		expect(ruleMatchesPath("/api/live", "/api/live/stream-keys/abc")).toBe(
			true,
		);
		expect(ruleMatchesPath("/api/live", "/api/live-channels/abc")).toBe(false);
		expect(ruleMatchesPath("/api/live", "/api/live-channels/abc/actions")).toBe(
			false,
		);
	});

	it("[param] segments match exactly one concrete segment", () => {
		expect(
			ruleMatchesPath(
				"/api/credentials/[id]/storage",
				"/api/credentials/123e4567/storage/buckets",
			),
		).toBe(true);
		expect(
			ruleMatchesPath("/api/credentials/[id]/storage", "/api/credentials"),
		).toBe(false);
		// The param cannot span segments.
		expect(
			ruleMatchesPath(
				"/api/credentials/[id]/storage",
				"/api/credentials/a/b/storage",
			),
		).toBe(false);
	});
});

describe("the §4 decisions", () => {
	it("provider Per-Title imports require ADMIN", () => {
		for (const role of USER_ROLES) {
			expect(
				evaluateRole(role, "/api/per-title-simulator/encodings/import", "POST"),
			).toMatchObject({
				minRole: "ADMIN",
				allowed: role === "ADMIN",
			});
		}
		expect(
			evaluateRole(
				"OPERATOR",
				"/api/per-title-simulator/encodings/import-archive",
				"POST",
			).minRole,
		).toBe("OPERATOR");
	});
	it("read-only Live inventory counts use the existing VIEWER floor", () => {
		expect(
			evaluateRole("VIEWER", "/api/live/orphan-inventory", "GET"),
		).toMatchObject({ allowed: true, minRole: "VIEWER" });
	});
	it.each([
		["/api/library", "GET", "VIEWER"],
		["/api/library/content-1", "GET", "VIEWER"],
		["/api/library/sources/source-1", "GET", "VIEWER"],
		["/api/library/scenes/options", "GET", "VIEWER"],
		["/api/encoding-jobs/job-1/analysis", "GET", "VIEWER"],
		["/api/library", "POST", "OPERATOR"],
		["/api/library/content-1", "PATCH", "OPERATOR"],
		["/api/library/sources/source-1/retry", "POST", "OPERATOR"],
		["/api/encoding-jobs/job-1/analysis", "POST", "OPERATOR"],
	] as const)("Library %s %s has the %s floor", (path, method, minRole) => {
		expect(evaluateRole("VIEWER", path, method)).toMatchObject({
			minRole,
			allowed: minRole === "VIEWER",
		});
		expect(evaluateRole("OPERATOR", path, method).allowed).toBe(true);
	});
	it("REVEAL class: a VIEWER GET on the stream-key value is refused (§10 mutation 3, unit half)", () => {
		const decision = evaluateRole("VIEWER", "/api/live/stream-keys/abc", "GET");
		expect(decision.allowed).toBe(false);
		expect(decision.minRole).toBe("OPERATOR");
		// The same request as OPERATOR passes — the row is a floor, not a wall.
		expect(
			evaluateRole("OPERATOR", "/api/live/stream-keys/abc", "GET").allowed,
		).toBe(true);
		// The collection projection contains metadata only. A broad prefix here
		// made Settings → Live itself unreadable to VIEWER even though only the
		// per-key reveal needs elevation.
		expect(evaluateRole("VIEWER", "/api/live/stream-keys", "GET").allowed).toBe(
			true,
		);
	});

	it("the per-run heartbeat log is OPERATOR and its export is ADMIN — export first, or the log row would claim it", () => {
		const log =
			"/api/live-channels/0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a/runs/1b1b1b1b-1b1b-4b1b-8b1b-1b1b1b1b1b1b/heartbeats";
		expect(evaluateRole("VIEWER", log, "GET")).toMatchObject({
			allowed: false,
			minRole: "OPERATOR",
		});
		expect(evaluateRole("OPERATOR", log, "GET").allowed).toBe(true);
		const exportPath = `${log}/export`;
		expect(evaluateRole("OPERATOR", exportPath, "GET")).toMatchObject({
			allowed: false,
			minRole: "ADMIN",
		});
		expect(evaluateRole("ADMIN", exportPath, "GET").allowed).toBe(true);
		// The sibling run routes keep the VIEWER read floor — the floor is on
		// the heartbeat log, not on every run resource.
		expect(
			evaluateRole("VIEWER", `${log.replace(/heartbeats$/, "health")}`, "GET")
				.allowed,
		).toBe(true);
	});

	it("run diagnostics are OPERATOR and final telemetry download is ADMIN", () => {
		const run = "/api/live-channels/channel/runs/run";
		for (const method of ["GET", "HEAD"]) {
			expect(evaluateRole("VIEWER", `${run}/diagnostics`, method).allowed).toBe(
				false,
			);
			expect(
				evaluateRole("OPERATOR", `${run}/diagnostics`, method).allowed,
			).toBe(true);
			expect(
				evaluateRole("OPERATOR", `${run}/final-heartbeat`, method).allowed,
			).toBe(false);
			expect(
				evaluateRole("ADMIN", `${run}/final-heartbeat`, method).allowed,
			).toBe(true);
		}
	});

	it("REVEAL class: storage browse is credential USE, not a read", () => {
		expect(
			evaluateRole("VIEWER", "/api/credentials/abc/storage/objects", "GET")
				.allowed,
		).toBe(false);
		// Plain credential list stays VIEWER-readable (labels, not values).
		expect(evaluateRole("VIEWER", "/api/credentials", "GET").allowed).toBe(
			true,
		);
	});

	it("security telemetry and admin surfaces require ADMIN", () => {
		for (const path of [
			"/api/audit-logs",
			"/api/api-tokens",
			"/api/users",
			"/api/admin/reset",
		]) {
			expect(evaluateRole("OPERATOR", path, "GET").allowed).toBe(false);
			expect(evaluateRole("ADMIN", path, "GET").allowed).toBe(true);
		}
	});

	it("settings writes — including the billable probe run POST — are ADMIN; settings reads are VIEWER", () => {
		expect(
			evaluateRole("OPERATOR", "/api/settings/startup-probes/run", "POST")
				.allowed,
		).toBe(false);
		expect(
			evaluateRole("ADMIN", "/api/settings/startup-probes/run", "POST").allowed,
		).toBe(true);
		expect(
			evaluateRole("VIEWER", "/api/settings/features", "GET").allowed,
		).toBe(true);
	});

	it("the retired SDK-census path reaches its universal 404 handler for every signed-in role", () => {
		for (const role of USER_ROLES) {
			expect(
				evaluateRole(role, "/api/settings/api-coverage", "GET"),
				role,
			).toMatchObject({ allowed: true, minRole: "VIEWER" });
		}
		expect(
			evaluateRole("VIEWER", "/api/settings/features", "GET").allowed,
		).toBe(true);
		expect(evaluateRole("VIEWER", "/api/settings", "GET").allowed).toBe(true);
	});

	it("operational writes are OPERATOR; reads are VIEWER", () => {
		expect(evaluateRole("VIEWER", "/api/encoding-jobs", "POST").allowed).toBe(
			false,
		);
		expect(evaluateRole("OPERATOR", "/api/encoding-jobs", "POST").allowed).toBe(
			true,
		);
		expect(evaluateRole("VIEWER", "/api/encoding-jobs", "GET").allowed).toBe(
			true,
		);
		// The destructive POSTs that escape the verb ride the same OPERATOR row.
		expect(
			evaluateRole("VIEWER", "/api/encoding-jobs/bulk-delete", "POST").allowed,
		).toBe(false);
	});

	it("self-service account surface stays reachable for every role — a VIEWER's forced rotate must not dead-lock", () => {
		expect(
			evaluateRole("VIEWER", "/api/account/password", "POST").allowed,
		).toBe(true);
	});

	it("an UNMATCHED route×method requires ADMIN — §10 mutation 2: deleting the fallback goes red here", () => {
		// TRACE matches no rule's methods and no catch-all (GET/HEAD row and
		// the method-less OPERATOR row... the OPERATOR row is method-less, so
		// use a method-bearing miss: the GET rows skip TRACE, the method-less
		// rows match — hence the REAL unmatched case needs a path outside
		// /api. evaluateRole is only called for api-guarded paths in
		// production; the fallback exists for a table edit that narrows the
		// catch-alls, and THIS assertion is what turns that edit red.
		const decision = evaluateRole("OPERATOR", "/not-api/anything", "POST");
		expect(decision.rule).toBeNull();
		expect(decision.minRole).toBe("ADMIN");
		expect(decision.allowed).toBe(false);
		expect(evaluateRole("ADMIN", "/not-api/anything", "POST").allowed).toBe(
			true,
		);
	});
});

/**
 * The from-disk half : every api-guarded route×method on disk matches a
 * rule — never the fallback. A new route landing before its rule fails HERE
 * (the fallback would silently ADMIN it, which is fail-closed but must be a
 * DECISION, not an accident).
 */
describe("every on-disk route×method is matched by a rule (from disk)", () => {
	function findAppDir(): string {
		for (const base of ["src/app", "apps/web/src/app"]) {
			try {
				readdirSync(resolve(base));
				return resolve(base);
			} catch {
				// keep looking
			}
		}
		throw new Error("apps/web/src/app not found");
	}

	const API_DIR = join(findAppDir(), "api");

	function walk(dir: string): string[] {
		const found: string[] = [];
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				found.push(...walk(full));
			} else if (entry.name === "route.ts") {
				found.push(full);
			}
		}
		return found;
	}

	function exportedMethods(file: string): string[] {
		const src = readFileSync(file, "utf8");
		return ["GET", "POST", "PUT", "PATCH", "DELETE"].filter((method) =>
			new RegExp(
				`export (async )?(function ${method}\\b|const ${method}\\s*=)`,
			).test(src),
		);
	}

	it("every rule prefix points at a REAL route subtree — a dead rule is a typo'd protection", () => {
		// The naive inverse ("every route matches a rule") is a TAUTOLOGY here:
		// the /api catch-alls match everything, so that assertion could never
		// fail. What CAN fail from disk: a specific rule whose prefix matches
		// no real route file — /api/user vs /api/users, a renamed surface, a
		// deleted route — which would leave the intended protection matching
		// nothing while the catch-all silently took over at a LOWER floor.
		const routePaths: string[] = walk(API_DIR).map(
			(file) => `/api${file.slice(API_DIR.length).replace(/\/route\.ts$/, "")}`,
		);
		// SELF_REVOCATION_EXCEPTION joins the population (#255): a dead
		// EXCEPTION is worse than a dead rule — it grants nothing and silently
		// retires the documented kill-switch, with no 403 to notice.
		const prefixes = [
			...ROUTE_RULES.map((rule) => rule.prefix),
			SELF_REVOCATION_EXCEPTION.prefix,
		];
		const dead = prefixes.filter(
			(prefix) =>
				prefix !== "/api" &&
				!routePaths.some((path) => ruleMatchesPath(prefix, path)),
		);
		expect(dead).toEqual([]);
	});

	it("the guarded route population is the one the census claims (drift alarm)", () => {
		// The §4 table was authored against 108 files / 160 handlers. This
		// count moving is fine — routes get added — but it must move WITH a
		// glance at the table (does the new surface belong to an ADMIN row?),
		// so the number is pinned the way every census in this repo is.
		const files = walk(API_DIR);
		const guarded = files.filter(
			(file) =>
				classifyPath(
					`/api${file
						.slice(API_DIR.length)
						.replace(/\/route\.ts$/, "")
						.replace(/\[[^\]]+\]/g, "x")}`,
				) === "api-guarded",
		);
		const methods = guarded.flatMap((file) => exportedMethods(file));
		// 106 files / 159 handlers, measured: the census's "108 files / 160
		// handlers" counts EVERY route file; five of those are exempt
		// (health, webhooks, login, logout, session) and carry 4 of the
		// handlers... the arithmetic that matters here is the MEASURED
		// guarded population after #32's three new guarded routes (users,
		// users/[id], account/password; auth/setup is exempt) — derived with
		// find+grep before pinning, not computed from the census.
		// +1 on 2026-08-23: /api/live-channels/[id]/runs/[runId]/health (the
		// stream-health run timeline, GET) joins the guarded set.
		// +3 on 2026-08-29 added the release-evidence route files. The two
		// verification handlers now return 404 universally; keeping them in the
		// guarded census ensures anonymous callers still cannot bypass auth.
		// +1 file / +1 handler (C36, WP-A2): /api/live-channels/[id]/
		// insertable-content/preflight (POST) — an OPERATOR write by the
		// catch-all rule, like the registration it precedes; no ADMIN row.
		// +2 on 2026-09-02: the per-run heartbeat log (OPERATOR) and its export
		// (ADMIN) under /api/live-channels/[id]/runs/[runId]/heartbeats, one GET
		// each — both carry their own ROUTE_RULES row above the GET catch-all.
		// merge of origin/main into this branch (2026-09-03): both deltas above landed
		// together; the numbers are the instrument's received values on the merged tree.
		// +2 files / +1 handler (WP-G G-2): /api/webhook-registrations (GET, the
		// per-encoding list) and /api/webhook-registrations/reconcile (POST)
		// join the guarded set; the account-level /api/webhook-registration
		// lost its POST (−1), so the handler count nets +1. The removed
		// unsigned receiver was exempt and never counted here. Measured by
		// running this test, not summed.
		// merge of the G-2a tip into G-2b (2026-09-05): both
		// deltas landed together; the numbers are the instrument's received values.
		// merge of origin/main into this branch (2026-09-05): both deltas above landed
		// together; the numbers are the instrument's received values on the merged tree.
		// +1 file / +3 handlers (Settings → Live heartbeat cadence, C37):
		// /api/settings/live-heartbeat (GET, PUT, DELETE) joins the guarded set
		// under the /api/settings ADMIN write rule. Received values, not sums.
		// +1 file / +1 handler : /api/admin/reset/reconcile (POST) joins
		// the guarded set under the /api/admin ADMIN rule. Received values.
		// : +1 file / +1 handler — `live-channels/[id]/insertable-content/
		// normalizations` (GET), VIEWER by the /api GET catch-all like the content
		// list; 118→119 guarded, 172→173 route×methods. Received values.
		// Content Library adds five guarded route files; measured by this census.
		// #48 adds one read-only, account-scoped Live inventory route.
		// Cloud profiles and measurement cancellation add two guarded routes.
		// Library MP4 adds one authenticated read route.
		// Live P1: run diagnostics and final Heartbeat add two guarded GET routes.
		// Label statistics adds one account-bound guarded GET route, measured here.
		// Library scene keyword search adds one VIEWER GET route.
		// Registered scene-language options adds one VIEWER GET route.
		// Branding adds one route and two methods.
		// Live automatic stop adds one guarded route with VIEWER GET and
		// OPERATOR POST handlers. Both populations were measured from disk.
		// Historical imports replace the old insights GET with GET + POST.
		// Local simulator presets add one ADMIN GET route and handler.
		expect(guarded.length).toBe(152);
		expect(methods.length).toBe(217);
	});
});
