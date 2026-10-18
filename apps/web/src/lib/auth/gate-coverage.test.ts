import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { config as proxyConfig } from "@/proxy";
import { classifyPath } from "./gate";

/**
 * ENUMERATION GATE — the test that cannot be satisfied by writing more gate
 * code. It walks apps/web/src/app on disk and asserts that EVERY route.ts and
 * page.tsx is either matched-and-guarded by the proxy, or named in the
 * allowlist below with a reason. A route added six months from now fails here
 * instead of quietly shipping unauthenticated.
 *
 * Three of this repo's P5 defects shipped with every gate green because they
 * lived on a path no test exercised ( "Review heuristic"); a
 * gate tested only against the paths its author remembered is the same shape
 * of hole.
 */
/**
 * Located by walking up from the vitest cwd (import.meta.url is not a file:
 * URL under the vite module runner), so this works whether the suite is run
 * from apps/web or from the repo root.
 */
function findAppDir(): string {
	let dir = process.cwd();
	for (let depth = 0; depth < 6; depth++) {
		for (const candidate of [
			join(dir, "src", "app"),
			join(dir, "apps", "web", "src", "app"),
		]) {
			if (existsSync(join(candidate, "api"))) {
				return candidate;
			}
		}
		const parent = dirname(dir);
		if (parent === dir) {
			break;
		}
		dir = parent;
	}
	throw new Error(`apps/web/src/app not found from ${resolve(process.cwd())}`);
}

const APP_DIR = findAppDir();
const API_DIR = join(APP_DIR, "api");

/**
 * The ONLY /api routes reachable without a session. `methods` is part of the
 * contract: adding a DELETE to an exempt route must fail this test rather than
 * inherit the exemption.
 */
const API_EXEMPTIONS: Record<string, { reason: string; methods: string[] }> = {
	"health/route.ts": {
		reason:
			"Liveness probe for docker/uptime checks. Returns a constant; reads no data.",
		methods: ["GET"],
	},
	"webhooks/bitmovin/[scope]/[token]/route.ts": {
		reason:
			"Signed receiver (WP-G G-1). Bitmovin cannot present a session cookie; " +
			"the token names the registration, the HMAC key is derived from it, " +
			"unknown token 404 / bad signature 401 with no persistence, rate-limited " +
			"and size-capped before any work.",
		methods: ["POST"],
	},
	"auth/login/route.ts": {
		reason: "Issues the session — gating it would deadlock sign-in.",
		methods: ["POST"],
	},
	"auth/logout/route.ts": {
		reason: "Clears the session cookie; safe for an unauthenticated caller.",
		methods: ["POST"],
	},
	"auth/session/route.ts": {
		reason:
			"Reports whether the caller holds a valid cookie and which AUTH_MODE " +
			"is configured; the login screen needs it before a session exists.",
		methods: ["GET"],
	},
	"auth/setup/route.ts": {
		reason:
			"First-boot admin creation (#32 §3c) — no session can exist before the " +
			"first user does. Fails closed on its own once users exist (zero-users " +
			"re-checked inside a Serializable transaction), burns a hashed one-time " +
			"setup code via CAS, and carries its own failure-charged rate budgets.",
		methods: ["POST"],
	},
};

/** Pages reachable without a session. */
const PAGE_EXEMPTIONS: Record<string, string> = {
	"login/page.tsx": "The sign-in screen itself.",
};

function walk(dir: string, filename: string): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			found.push(...walk(full, filename));
		} else if (entry.name === filename) {
			found.push(full);
		}
	}
	return found;
}

/** POSIX-style path relative to `base`, so the allowlist keys are stable. */
function key(base: string, absolute: string): string {
	return relative(base, absolute).split(sep).join("/");
}

/**
 * App-Router file path → a concrete request path. Dynamic segments get a
 * sample value; the gate classifies by prefix, so the value is irrelevant as
 * long as it is non-empty.
 */
function requestPath(prefix: string, relativeFile: string): string {
	const segments = relativeFile
		.split("/")
		.slice(0, -1)
		.filter((segment) => !(segment.startsWith("(") && segment.endsWith(")")))
		.map((segment) => {
			if (segment.startsWith("[[...") || segment.startsWith("[...")) {
				return "sample/sample";
			}
			return segment.startsWith("[") ? "sample" : segment;
		});
	return `${prefix}${segments.length > 0 ? `/${segments.join("/")}` : ""}`;
}

/**
 * Model of Next's path-to-regexp compilation for the matcher forms this repo
 * uses: literal characters, plus an inline regex group `(...)` passed through
 * verbatim (the documented negative-lookahead idiom). A `:param` matcher would
 * need real path-to-regexp, so it throws rather than pretending to match.
 */
function compileMatcher(pattern: string): RegExp {
	if (/:\w/.test(pattern)) {
		throw new Error(
			`compileMatcher models literal + "(regex)" matchers only; got ${pattern}`,
		);
	}
	let out = "";
	let depth = 0;
	for (const char of pattern) {
		if (char === "(") {
			depth += 1;
			out += char;
		} else if (char === ")") {
			depth -= 1;
			out += char;
		} else {
			out += depth > 0 ? char : char.replace(/[.*+?^${}|[\]\\]/g, "\\$&");
		}
	}
	return new RegExp(`^${out}$`);
}

const MATCHERS = proxyConfig.matcher.map(compileMatcher);

function matchedByProxy(path: string): boolean {
	return MATCHERS.some((matcher) => matcher.test(path));
}

const EXPORTED_METHOD = /export\s+(?:async\s+)?function\s+([A-Z]+)\s*\(/g;

function exportedMethods(file: string): string[] {
	const source = readFileSync(file, "utf8");
	const methods = new Set<string>();
	for (const match of source.matchAll(EXPORTED_METHOD)) {
		methods.add(match[1] as string);
	}
	return [...methods].sort();
}

const apiRoutes = walk(API_DIR, "route.ts").map((file) => ({
	file,
	key: key(API_DIR, file),
	path: requestPath("/api", key(API_DIR, file)),
}));

const pages = walk(APP_DIR, "page.tsx")
	.map((file) => ({ file, key: key(APP_DIR, file) }))
	.filter((page) => !page.key.startsWith("api/"))
	.map((page) => ({ ...page, path: requestPath("", page.key) || "/" }));

describe("every /api route is gated (enumerated from disk)", () => {
	it("finds the whole API surface — a broken walk must not pass vacuously", () => {
		expect(apiRoutes.length).toBeGreaterThanOrEqual(60);
		// Spot-pins from the three blast-radius classes named in .
		expect(apiRoutes.map((route) => route.key)).toEqual(
			expect.arrayContaining([
				"live/stream-keys/[id]/route.ts",
				"infrastructure/prewarmed-pools/[poolId]/actions/route.ts",
				"live-channels/[id]/esam-media-point/route.ts",
				"credentials/[id]/route.ts",
			]),
		);
	});

	it.each(
		apiRoutes.map((route) => [route.key, route.path] as const),
	)("%s (%s) is matched by the proxy matcher", (_key, path) => {
		expect(matchedByProxy(path)).toBe(true);
	});

	it.each(
		apiRoutes.map((route) => [route.key, route.path] as const),
	)("%s (%s) is guarded, or allowlisted with a reason", (routeKey, path) => {
		const exemption = API_EXEMPTIONS[routeKey];
		if (exemption) {
			expect(exemption.reason.length).toBeGreaterThan(20);
			expect(classifyPath(path)).toBe("api-exempt");
		} else {
			expect(classifyPath(path)).toBe("api-guarded");
		}
	});

	it.each(
		Object.keys(API_EXEMPTIONS),
	)("exempt route %s still exists and exports only its expected methods", (routeKey) => {
		const route = apiRoutes.find((candidate) => candidate.key === routeKey);
		expect(
			route,
			`${routeKey} is allowlisted but missing on disk`,
		).toBeDefined();
		expect(exportedMethods((route as { file: string }).file)).toEqual(
			(API_EXEMPTIONS[routeKey] as { methods: string[] }).methods,
		);
	});

	it("has no exempt route outside the allowlist", () => {
		const exempt = apiRoutes
			.filter((route) => classifyPath(route.path) === "api-exempt")
			.map((route) => route.key)
			.sort();
		expect(exempt).toEqual(Object.keys(API_EXEMPTIONS).sort());
	});

	it("guards every route that can delete or mutate (18 DELETE handlers, ledger #18)", () => {
		const mutating = apiRoutes.filter((route) =>
			exportedMethods(route.file).some((method) =>
				["POST", "PUT", "PATCH", "DELETE"].includes(method),
			),
		);
		const ungated = mutating
			.filter((route) => classifyPath(route.path) !== "api-guarded")
			.map((route) => route.key)
			.sort();
		// The webhook + auth handshake are the only mutating exemptions, each
		// carrying its own authentication. auth/setup joined with #32 §3c:
		// the setup-code burn + Serializable zero-users check ARE its
		// authentication, and it self-seals once users exist.
		expect(ungated).toEqual([
			"auth/login/route.ts",
			"auth/logout/route.ts",
			"auth/setup/route.ts",
			// WP-G G-2 removed the pre-G-1 receiver at webhooks/bitmovin/route.ts;
			// the signed per-token receiver is the only Bitmovin-facing door.
			"webhooks/bitmovin/[scope]/[token]/route.ts",
		]);
		expect(
			mutating.filter((route) => exportedMethods(route.file).includes("DELETE"))
				.length,
		).toBeGreaterThanOrEqual(18);
	});
});

describe("every page is gated (enumerated from disk)", () => {
	it("finds the page surface", () => {
		expect(pages.length).toBeGreaterThanOrEqual(20);
		expect(pages.map((page) => page.key)).toContain("login/page.tsx");
	});

	it.each(
		pages.map((page) => [page.key, page.path] as const),
	)("%s (%s) is matched by the proxy matcher", (_key, path) => {
		expect(matchedByProxy(path)).toBe(true);
	});

	it.each(
		pages.map((page) => [page.key, page.path] as const),
	)("%s (%s) is guarded, or allowlisted with a reason", (pageKey, path) => {
		if (PAGE_EXEMPTIONS[pageKey]) {
			expect(classifyPath(path)).toBe("page-exempt");
		} else {
			expect(classifyPath(path)).toBe("page-guarded");
		}
	});

	it("has no exempt page outside the allowlist", () => {
		const exempt = pages
			.filter((page) => classifyPath(page.path) === "page-exempt")
			.map((page) => page.key)
			.sort();
		expect(exempt).toEqual(Object.keys(PAGE_EXEMPTIONS).sort());
	});
});
