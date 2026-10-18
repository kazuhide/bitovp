import { describe, expect, it } from "vitest";
import type { PathClass } from "./gate";
import { classifyPath, isApiPath, loginPath, safeNextPath } from "./gate";

describe("classifyPath", () => {
	const cases: [path: string, expected: PathClass][] = [
		// Exempt API paths — every one has a stated reason in gate.ts.
		["/api/health", "api-exempt"],
		["/api/health/", "api-exempt"],
		["/api/webhooks/bitmovin", "api-exempt"],
		["/api/auth/login", "api-exempt"],
		["/api/auth/logout", "api-exempt"],
		["/api/auth/session", "api-exempt"],
		// Guarded API paths, including near-misses on the exempt prefixes.
		["/api", "api-guarded"],
		["/api/healthz", "api-guarded"],
		["/api/health-check", "api-guarded"],
		["/api/healthy/secrets", "api-guarded"],
		["/api/webhooksomething", "api-guarded"],
		["/api/authenticate", "api-guarded"],
		["/api/credentials", "api-guarded"],
		["/api/credentials/abc", "api-guarded"],
		["/api/live/stream-keys/abc", "api-guarded"],
		["/api/infrastructure/prewarmed-pools/abc/actions", "api-guarded"],
		["/api/webhook-events", "api-guarded"],
		// Encoded traversal must not buy an exemption (URL parsing resolves
		// real ".." before the gate ever sees the path).
		["/api/health%2f../credentials", "api-guarded"],
		["/api/webhooks%2Fx/../../credentials", "api-guarded"],
		// Pages.
		["/login", "page-exempt"],
		["/_next/static/chunks/main.js", "page-exempt"],
		["/favicon.ico", "page-exempt"],
		["/", "page-guarded"],
		["/vod/jobs", "page-guarded"],
		["/settings/credentials", "page-guarded"],
		["/loginish", "page-guarded"],
		["/_nextdoor", "page-guarded"],
	];

	for (const [path, expected] of cases) {
		it(`${path} → ${expected}`, () => {
			expect(classifyPath(path)).toBe(expected);
		});
	}
});

describe("isApiPath", () => {
	it("separates /api from lookalikes", () => {
		expect(isApiPath("/api")).toBe(true);
		expect(isApiPath("/api/anything")).toBe(true);
		expect(isApiPath("/apidocs")).toBe(false);
		expect(isApiPath("/vod/api")).toBe(false);
	});
});

describe("safeNextPath (open-redirect guard)", () => {
	const rejected: [name: string, raw: string | null | undefined][] = [
		["null", null],
		["undefined", undefined],
		["an empty string", ""],
		["a protocol-relative host", "//evil.example"],
		["a protocol-relative host with a path", "//evil.example/vod"],
		["an http URL", "http://evil.example"],
		["an https URL", "https://evil.example/settings"],
		["a scheme-less absolute URL", "https:evil.example"],
		["a backslash host (browser-normalized to //)", "/\\evil.example"],
		["a javascript: URL", "javascript:alert(1)"],
		["a data: URL", "data:text/html,<script>"],
		["a bare relative path", "vod/jobs"],
		["a CRLF header-smuggling attempt", "/vod\r\nSet-Cookie: x=y"],
		["a tab-separated host", "/\tevil.example"],
		["the login page itself (redirect loop)", "/login"],
		["the login page with a nested next", "/login?next=/vod"],
		["a Next asset path", "/_next/static/x.js"],
		["an API path (would land the browser on JSON)", "/api/credentials"],
		["an over-long path", `/${"a".repeat(600)}`],
	];

	for (const [name, raw] of rejected) {
		it(`rejects ${name}`, () => {
			expect(safeNextPath(raw)).toBeNull();
		});
	}

	const accepted: [raw: string, expected: string][] = [
		["/", "/"],
		["/vod/jobs", "/vod/jobs"],
		["/vod/jobs?status=RUNNING", "/vod/jobs?status=RUNNING"],
		["/settings/credentials#secrets", "/settings/credentials"],
		[
			"/live/3f1f0e8e-2c5b-4a4e-9a64-0f6f4d2c9b11",
			"/live/3f1f0e8e-2c5b-4a4e-9a64-0f6f4d2c9b11",
		],
		// Traversal is resolved by URL parsing, then re-classified.
		["/vod/../settings", "/settings"],
	];

	for (const [raw, expected] of accepted) {
		it(`accepts ${raw} → ${expected}`, () => {
			expect(safeNextPath(raw)).toBe(expected);
		});
	}
});

describe("loginPath", () => {
	it("carries a safe target through, encoded", () => {
		expect(loginPath("/vod/jobs?status=RUNNING")).toBe(
			"/login?next=%2Fvod%2Fjobs%3Fstatus%3DRUNNING",
		);
	});

	it("drops an unsafe target rather than passing it on", () => {
		expect(loginPath("//evil.example")).toBe("/login");
		expect(loginPath("https://evil.example")).toBe("/login");
	});

	it("omits next= for the dashboard and for no target", () => {
		expect(loginPath("/")).toBe("/login");
		expect(loginPath(null)).toBe("/login");
	});
});

describe("safeNextPath — normalization cannot smuggle a protocol-relative path", () => {
	/**
	 * The raw-string guard rejected `//evil.com`, but `new URL` collapses `.`
	 * and `..`, and the NORMALIZED pathname was returned unchecked — so
	 * `/..//evil.com` became `//evil.com` and the login form assigned it to
	 * `window.location`. An open redirect off a trusted origin, immediately after
	 * the operator typed the one shared password (review catch).
	 */
	for (const raw of [
		"/..//evil.com",
		"/.//evil.com",
		"/a/../..//evil.com",
		"/a/b/../../..//evil.com",
		"//evil.com",
		"/\\evil.com",
	]) {
		it(`rejects ${raw}`, () => {
			expect(safeNextPath(raw)).toBeNull();
		});
	}

	it("still accepts the legitimate paths it exists to preserve", () => {
		expect(safeNextPath("/vod/jobs")).toBe("/vod/jobs");
		expect(safeNextPath("/vod/jobs?a=1")).toBe("/vod/jobs?a=1");
		expect(safeNextPath("/settings")).toBe("/settings");
		// `..` that stays same-origin and lands on a real page is fine.
		expect(safeNextPath("/vod/../settings")).toBe("/settings");
	});
});
