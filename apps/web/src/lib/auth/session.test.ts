import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	cookieMaxAgeSeconds,
	issueSession,
	readSessionCookie,
	renewSession,
	requestIsHttps,
	SECURE_SESSION_COOKIE,
	SESSION_COOKIE,
	SESSION_COOKIE_NAMES,
	sessionCookieClearOptions,
	sessionCookieName,
	sessionCookieOptions,
	signSession,
	verifySession,
} from "./session";

const SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef";
const NOW = 1_760_000_000_000;
const IDLE = 60 * 60_000;
const MAX = 7 * 24 * 3_600_000;

function fresh(now = NOW) {
	return issueSession({ mode: "password", now, idleMs: IDLE, maxMs: MAX });
}

describe("issueSession", () => {
	it("requires paired target, expiry and return organization for a view-as grant", () => {
		const base = {
			mode: "users" as const,
			now: NOW,
			idleMs: IDLE,
			maxMs: MAX,
			sub: "11111111-2222-4333-8444-555555555555",
			sessionGeneration: 1,
		};
		for (const extra of [
			{ targetUserId: base.sub },
			{ impersonationExpiresAt: NOW + 1000 },
			{ returnOrganizationId: base.sub },
		])
			expect(() => issueSession({ ...base, ...extra })).toThrow();
		expect(() =>
			issueSession({
				...base,
				targetUserId: base.sub,
				returnOrganizationId: base.sub,
				impersonationExpiresAt: NOW + MAX + 1,
			}),
		).toThrow();
	});
	it("sets an idle expiry and an absolute ceiling", () => {
		const payload = fresh();
		expect(payload.iat).toBe(NOW);
		expect(payload.exp).toBe(NOW + IDLE);
		expect(payload.abs).toBe(NOW + MAX);
	});

	it("never issues an idle expiry beyond the absolute ceiling", () => {
		const payload = issueSession({
			mode: "password",
			now: NOW,
			idleMs: MAX * 2,
			maxMs: MAX,
		});
		expect(payload.exp).toBe(NOW + MAX);
	});
});

describe("verifySession", () => {
	it("confines a pre-tenancy users cookie to the migrated main organization", () => {
		const token = signRaw(
			Buffer.from(
				JSON.stringify({
					mode: "users",
					iat: NOW,
					exp: NOW + IDLE,
					abs: NOW + MAX,
					sub: "11111111-2222-4333-8444-555555555555",
					sessionGeneration: 1,
				}),
			).toString("base64url"),
		);
		const verdict = verifySession(token, SECRET, NOW + 1, "users");
		expect(verdict.ok).toBe(true);
		if (verdict.ok && verdict.payload.mode === "users")
			expect(verdict.payload.organizationId).toBe(
				"00000000-0000-4000-8000-000000000001",
			);
	});
	const token = signSession(fresh(), SECRET);

	const cases: [
		name: string,
		build: () => string | undefined,
		reason: string | "ok",
	][] = [
		["a freshly signed token", () => token, "ok"],
		["no cookie at all", () => undefined, "absent"],
		["an empty cookie", () => "", "absent"],
		[
			"a token with a flipped signature byte",
			() => flipLast(token),
			"bad-signature",
		],
		[
			"a token signed with a different secret",
			() => signSession(fresh(), `${SECRET}-other`),
			"bad-signature",
		],
		[
			"a payload edited without re-signing",
			() => {
				const parts = token.split(".");
				const forged = Buffer.from(
					JSON.stringify({ ...fresh(), abs: NOW + MAX * 10 }),
					"utf8",
				).toString("base64url");
				return `${parts[0]}.${forged}.${parts[2]}`;
			},
			"bad-signature",
		],
		["a bare random string", () => "not-a-token", "malformed"],
		[
			"only two segments",
			() => token.split(".").slice(0, 2).join("."),
			"malformed",
		],
		[
			"an unknown version prefix",
			() => `v2.${token.split(".").slice(1).join(".")}`,
			"malformed",
		],
		[
			"a validly signed non-JSON body",
			() => signRaw(Buffer.from("not json", "utf8").toString("base64url")),
			"malformed",
		],
		[
			"a validly signed payload missing fields",
			() =>
				signRaw(
					Buffer.from(JSON.stringify({ iat: NOW }), "utf8").toString(
						"base64url",
					),
				),
			"malformed",
		],
	];

	for (const [name, build, reason] of cases) {
		it(`${reason === "ok" ? "accepts" : `rejects (${reason})`} ${name}`, () => {
			const verdict = verifySession(build(), SECRET, NOW, "password");
			if (reason === "ok") {
				expect(verdict.ok).toBe(true);
			} else {
				expect(verdict).toEqual({ ok: false, reason });
			}
		});
	}

	it("rejects a session past its idle expiry", () => {
		const verdict = verifySession(token, SECRET, NOW + IDLE, "password");
		expect(verdict).toEqual({ ok: false, reason: "expired" });
	});

	it("rejects a session past its absolute deadline even with a live idle window", () => {
		// abs already reached; exp was refreshed by a renewal a moment ago.
		const payload = { ...fresh(), abs: NOW + 1_000, exp: NOW + IDLE };
		const verdict = verifySession(
			signSession(payload, SECRET),
			SECRET,
			NOW + 2_000,
			"password",
		);
		expect(verdict).toEqual({ ok: false, reason: "expired" });
	});

	it("rejects a cookie minted under a different AUTH_MODE", () => {
		const noneToken = signSession(
			issueSession({ mode: "none", now: NOW, idleMs: IDLE, maxMs: MAX }),
			SECRET,
		);
		expect(verifySession(noneToken, SECRET, NOW, "password")).toEqual({
			ok: false,
			reason: "stale-mode",
		});
	});
});

describe("renewSession", () => {
	it("does not renew while more than half the idle window remains", () => {
		expect(renewSession(fresh(), NOW + IDLE / 4, IDLE)).toBeNull();
	});

	it("slides the idle expiry once past the halfway mark", () => {
		const now = NOW + IDLE * 0.75;
		const renewed = renewSession(fresh(), now, IDLE);
		expect(renewed?.exp).toBe(now + IDLE);
		expect(renewed?.abs).toBe(NOW + MAX);
	});

	it("clamps renewal to the absolute deadline and then stops renewing", () => {
		const payload = { ...fresh(), abs: NOW + IDLE + 1_000 };
		const now = NOW + IDLE * 0.9;
		const renewed = renewSession(payload, now, IDLE);
		expect(renewed?.exp).toBe(payload.abs);
		expect(renewSession(renewed as typeof payload, now, IDLE)).toBeNull();
	});
});

describe("cookie attributes", () => {
	it("uses the __Host- prefixed name only under https", () => {
		expect(sessionCookieName(true)).toBe(SECURE_SESSION_COOKIE);
		expect(sessionCookieName(false)).toBe(SESSION_COOKIE);
		expect(SECURE_SESSION_COOKIE.startsWith("__Host-")).toBe(true);
	});

	it("is HttpOnly + SameSite=Lax + Path=/ in both schemes", () => {
		for (const secure of [true, false]) {
			expect(sessionCookieOptions(secure, 60)).toEqual({
				httpOnly: true,
				sameSite: "lax",
				path: "/",
				secure,
				maxAge: 60,
			});
		}
	});

	it("expires the cookie at the absolute deadline", () => {
		expect(cookieMaxAgeSeconds(fresh(), NOW)).toBe(MAX / 1000);
		expect(cookieMaxAgeSeconds(fresh(), NOW + MAX)).toBe(1);
	});
});

describe("requestIsHttps", () => {
	const cases: [
		name: string,
		headers: HeadersInit,
		url: string,
		expected: boolean,
	][] = [
		["an https URL", {}, "https://ovp.example/api/x", true],
		["an http URL", {}, "http://localhost:3100/api/x", false],
		[
			"a TLS-terminating proxy",
			{ "x-forwarded-proto": "https" },
			"http://localhost:3100/api/x",
			true,
		],
		[
			"the first hop of a proxy chain",
			{ "x-forwarded-proto": "https, http" },
			"http://localhost:3100/api/x",
			true,
		],
		[
			"a plain-http proxy header overriding an https URL",
			{ "x-forwarded-proto": "http" },
			"https://ovp.example/api/x",
			false,
		],
		["an unparsable URL", {}, "::::", false],
	];

	for (const [name, headers, url, expected] of cases) {
		it(`${expected ? "detects" : "does not detect"} https for ${name}`, () => {
			expect(requestIsHttps(new Headers(headers), url)).toBe(expected);
		});
	}
});

describe("readSessionCookie", () => {
	it("prefers the __Host- cookie when both are present", () => {
		const jar = new Map([
			[SECURE_SESSION_COOKIE, { value: "secure" }],
			[SESSION_COOKIE, { value: "plain" }],
		]);
		expect(readSessionCookie({ get: (n) => jar.get(n) })).toBe("secure");
	});

	it("falls back to the bare cookie name", () => {
		const jar = new Map([[SESSION_COOKIE, { value: "plain" }]]);
		expect(readSessionCookie({ get: (n) => jar.get(n) })).toBe("plain");
	});

	it("returns undefined with no session cookie", () => {
		expect(readSessionCookie({ get: () => undefined })).toBeUndefined();
	});
});

/**
 * The rule its two call sites (`logout/route.ts`, `proxy.ts`) used to each carry
 * a copy of. Tested here as well as at both call sites deliberately: the call
 * sites prove the wiring, this proves the rule, and the copies drifted precisely
 * because there was nowhere the rule itself was stated once.
 */
describe("sessionCookieClearOptions", () => {
	it("requires Secure for __Host- and forbids it for the bare name", () => {
		expect(sessionCookieClearOptions(SECURE_SESSION_COOKIE).secure).toBe(true);
		expect(sessionCookieClearOptions(SESSION_COOKIE).secure).toBe(false);
	});

	it("covers every shipped cookie name, so neither branch is hypothetical", () => {
		const flags = SESSION_COOKIE_NAMES.map(
			(name) => sessionCookieClearOptions(name).secure,
		);
		expect(flags).toContain(true);
		expect(flags).toContain(false);
	});

	it("expires immediately and stays HttpOnly, Lax and host-wide", () => {
		for (const name of SESSION_COOKIE_NAMES) {
			expect(sessionCookieClearOptions(name)).toMatchObject({
				httpOnly: true,
				sameSite: "lax",
				path: "/",
				maxAge: 0,
			});
		}
	});
});

describe("payload union (#32 §3 — the zod-strip trap closed)", () => {
	const NOW = 1_700_000_000_000;
	const SUB = "11111111-2222-4333-8444-555555555555";

	it("issuing users WITHOUT sub throws at mint — never a cookie with undefined identity", () => {
		expect(() =>
			issueSession({
				mode: "users",
				now: NOW,
				idleMs: 1000,
				maxMs: 2000,
				sessionGeneration: 0,
			}),
		).toThrow();
	});

	it("a users cookie round-trips its sub through sign/verify", () => {
		const token = signSession(
			issueSession({
				mode: "users",
				now: NOW,
				idleMs: 60_000,
				maxMs: 120_000,
				sub: SUB,
				sessionGeneration: 7,
			}),
			SECRET,
		);
		const verdict = verifySession(token, SECRET, NOW + 1, "users");
		expect(verdict.ok).toBe(true);
		if (verdict.ok && verdict.payload.mode === "users") {
			expect(verdict.payload.sub).toBe(SUB);
			expect(verdict.payload.sessionGeneration).toBe(7);
		}
	});

	it("issuing users WITHOUT a session generation throws — identity proof is version-bound", () => {
		expect(() =>
			issueSession({
				mode: "users",
				now: NOW,
				idleMs: 1_000,
				maxMs: 2_000,
				sub: SUB,
			}),
		).toThrow();
	});

	it("a PASSWORD-mode payload smuggling sub is MALFORMED — strictObject forbids, never strips", () => {
		// Signed raw so the shape check is what rejects it, not the signature.
		const body = Buffer.from(
			JSON.stringify({
				iat: NOW,
				exp: NOW + 60_000,
				abs: NOW + 120_000,
				mode: "password",
				sub: SUB,
			}),
			"utf8",
		).toString("base64url");
		const verdict = verifySession(signRaw(body), SECRET, NOW + 1, "password");
		expect(verdict).toEqual({ ok: false, reason: "malformed" });
	});

	it("a users-mode payload MISSING sub is malformed — absent identity fails closed", () => {
		const body = Buffer.from(
			JSON.stringify({
				iat: NOW,
				exp: NOW + 60_000,
				abs: NOW + 120_000,
				mode: "users",
				sessionGeneration: 0,
			}),
			"utf8",
		).toString("base64url");
		const verdict = verifySession(signRaw(body), SECRET, NOW + 1, "users");
		expect(verdict).toEqual({ ok: false, reason: "malformed" });
	});

	it("a field joining the TYPE without joining the SCHEMA cannot ship — the round-trip pin", () => {
		// The old z.object payload silently STRIPPED unknown keys and cast.
		// strictObject rejects instead: an extra key is malformed, so the
		// compile-clean-but-runtime-undefined shape is structurally gone.
		const body = Buffer.from(
			JSON.stringify({
				iat: NOW,
				exp: NOW + 60_000,
				abs: NOW + 120_000,
				mode: "users",
				sub: SUB,
				sessionGeneration: 0,
				role: "ADMIN",
			}),
			"utf8",
		).toString("base64url");
		const verdict = verifySession(signRaw(body), SECRET, NOW + 1, "users");
		expect(verdict).toEqual({ ok: false, reason: "malformed" });
	});
});

function flipLast(token: string): string {
	const last = token.slice(-1);
	return `${token.slice(0, -1)}${last === "A" ? "B" : "A"}`;
}

/**
 * Signs an arbitrary body so payload-shape rejection is reached with a VALID
 * signature — otherwise the signature check would mask it.
 */
function signRaw(body: string): string {
	const versioned = `v1.${body}`;
	const sig = createHmac("sha256", SECRET)
		.update(versioned)
		.digest("base64url");
	return `${versioned}.${sig}`;
}
