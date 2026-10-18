import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetNoneModeWarning } from "@/lib/auth/config";
import {
	issueSession,
	SECURE_SESSION_COOKIE,
	SESSION_COOKIE,
	signSession,
} from "@/lib/auth/session";

/**
 * WP-G G-1: the persisted public-ingress hostname joins the allowlist, read
 * only on a miss. Mocked here so no test reaches a database — and so the
 * tunnel arms below can name a hostname the env never mentions.
 */
let ingressHost: string | null = null;
const ingressHostname = vi.fn(async (_candidate: string) => ingressHost);
vi.mock("@/lib/auth/ingress-allowlist", () => ({
	ingressHostname: (candidate: string) => ingressHostname(candidate),
}));

vi.mock("@bitovp/db", () => ({
	getIdentityPrisma: () => ({
		organization: {
			findUnique: async () => ({
				name: "Main",
				active: true,
				allowedIpCidrs: [],
			}),
		},
	}),
}));
vi.mock("@/lib/server/access-audit", () => ({
	recordAccessNonAdmin: async () => {},
}));

import { proxy } from "./proxy";

/**
 * Well-formed but arbitrary: the gate never verifies a password, only the
 * session cookie, so a real scrypt run would just cost 50ms per test file.
 * The lengths are NOT arbitrary: 16-byte salt and 32-byte digest are the
 * floors parsePasswordHash enforces, because a shorter digest makes the
 * comparison brute-forceable (a 1-byte one matches ~1 password in 256).
 */
const HASH =
	"scrypt$16384$8$1$c2FsdHNhbHRzYWx0c2FsdA==$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g=";
const SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef";
const IDLE_MS = 720 * 60_000;
const MAX_MS = 168 * 3_600_000;

function request(
	headers: Record<string, string>,
	url = "http://localhost:3100/api/credentials",
	method = "POST",
): NextRequest {
	return new NextRequest(url, {
		method,
		headers: {
			"x-bitovp-expected-org": "00000000-0000-4000-8000-000000000001",
			...headers,
		},
	});
}

function passwordMode(): void {
	vi.stubEnv("AUTH_MODE", "password");
	vi.stubEnv("AUTH_PASSWORD_HASH", HASH);
	vi.stubEnv("AUTH_SESSION_SECRET", SECRET);
}

function validCookie(now = Date.now(), name = SESSION_COOKIE): string {
	const token = signSession(
		issueSession({ mode: "password", now, idleMs: IDLE_MS, maxMs: MAX_MS }),
		SECRET,
	);
	return `${name}=${token}`;
}

function setCookies(res: Response): string[] {
	return res.headers.getSetCookie();
}

afterEach(() => {
	vi.unstubAllEnvs();
	vi.useRealTimers();
	resetNoneModeWarning();
	ingressHost = null;
	ingressHostname.mockClear();
});

describe("api proxy guard (cross-site layer)", () => {
	// AUTH_MODE=none isolates this layer: these assertions are about
	// Origin/Host, and they held before auth existed.
	beforeEach(() => {
		vi.stubEnv("AUTH_MODE", "none");
	});

	it("allows same-origin browser requests", async () => {
		const res = await proxy(
			request({
				"sec-fetch-site": "same-origin",
				origin: "http://localhost:3100",
				host: "localhost:3100",
			}),
		);
		expect(res.status).toBe(200);
	});

	it("allows non-browser clients without fetch metadata", async () => {
		const res = await proxy(request({ host: "localhost:3100" }));
		expect(res.status).toBe(200);
	});

	it("rejects cross-site fetches (no-preflight CSRF vector)", async () => {
		const res = await proxy(
			request({
				"sec-fetch-site": "cross-site",
				origin: "http://evil.example",
				host: "localhost:3100",
			}),
		);
		expect(res.status).toBe(403);
	});

	it("rejects a non-allowlisted origin even without fetch metadata", async () => {
		const res = await proxy(
			request({ origin: "http://evil.example", host: "localhost:3100" }),
		);
		expect(res.status).toBe(403);
	});

	it("still guards the gate-exempt api routes", async () => {
		const res = await proxy(
			request(
				{ "sec-fetch-site": "cross-site", host: "localhost:3100" },
				"http://localhost:3100/api/webhooks/bitmovin",
			),
		);
		expect(res.status).toBe(403);
	});

	it("does NOT apply to page navigation (an inbound link is legitimately cross-site)", async () => {
		// Sec-Fetch-Site: cross-site on a top-level navigation just means the
		// user followed a link; 403'ing that would break every inbound link.
		// The Host is the allowlisted one: since #310 a page on a NON-allowlisted
		// DNS name is a webhook door (403), which is a different rule from the
		// cross-site one this arm pins.
		const res = await proxy(
			request(
				{ "sec-fetch-site": "cross-site", host: "localhost:3100" },
				"http://localhost:3100/vod/jobs",
				"GET",
			),
		);
		expect(res.status).toBe(200);
	});

	describe("host allowlist (DNS-rebinding defense)", () => {
		it("rejects a non-allowlisted Host even when Origin reflects it", async () => {
			// DNS rebinding: the browser believes it is same-origin, so Origin
			// and Host both carry the rebound name — reflection would pass it.
			const res = await proxy(
				request({
					"sec-fetch-site": "same-origin",
					origin: "http://rebound.attacker.example:3100",
					host: "rebound.attacker.example:3100",
				}),
			);
			expect(res.status).toBe(403);
		});

		it("allows 127.0.0.1 on any port by default", async () => {
			const res = await proxy(
				request({
					origin: "http://127.0.0.1:9999",
					host: "127.0.0.1:9999",
				}),
			);
			expect(res.status).toBe(200);
		});

		it("rejects a request without a Host header", async () => {
			const res = await proxy(request({}));
			expect(res.status).toBe(403);
		});

		it("honors the ALLOWED_ORIGIN_HOSTS override for both Host and Origin", async () => {
			vi.stubEnv("ALLOWED_ORIGIN_HOSTS", "app.internal, ovp.example");
			const allowed = await proxy(
				request({
					origin: "https://ovp.example",
					host: "app.internal:3100",
				}),
			);
			expect(allowed.status).toBe(200);

			// The override REPLACES the default list — localhost is now rejected.
			const localhost = await proxy(request({ host: "localhost:3100" }));
			expect(localhost.status).toBe(403);
		});

		describe("the persisted public-ingress hostname (WP-G G-1)", () => {
			it("accepts the tunnel hostname as Host AND Origin without any env change", async () => {
				ingressHost = "abc-def.trycloudflare.com";
				const res = await proxy(
					request(
						{
							origin: "https://abc-def.trycloudflare.com",
							host: "abc-def.trycloudflare.com",
						},
						"https://abc-def.trycloudflare.com/api/webhooks/bitmovin",
					),
				);
				expect(res.status).toBe(200);
			});

			it("is consulted ONLY on a miss — a static hit never asks", async () => {
				ingressHost = "abc-def.trycloudflare.com";
				await proxy(request({ host: "localhost:3100" }));
				expect(ingressHostname).not.toHaveBeenCalled();
			});

			it("does not weaken the rule: a different unknown Host is still rejected while a tunnel exists", async () => {
				ingressHost = "abc-def.trycloudflare.com";
				const res = await proxy(
					request({ host: "rebound.attacker.example:3100" }),
				);
				expect(res.status).toBe(403);
				// #310: an unknown DNS-named Host is a door before the allowlist
				// is even consulted, so it never costs a database read either.
				expect(ingressHostname).not.toHaveBeenCalled();
			});

			it("with no ingress persisted, an unknown Host is rejected exactly as before", async () => {
				ingressHost = null;
				const res = await proxy(request({ host: "abc-def.trycloudflare.com" }));
				expect(res.status).toBe(403);
			});

			describe("is a webhook door, not a second origin (WP-G G-1b, row #310)", () => {
				const TUNNEL = "abc-def.trycloudflare.com";
				const ingressOnly = {
					error: "This host serves only the webhook receiver",
				};

				it("refuses an API path other than the receiver with 403 before any gate", async () => {
					ingressHost = TUNNEL;
					const res = await proxy(
						request({ host: TUNNEL }, `https://${TUNNEL}/api/credentials`),
					);
					expect(res.status).toBe(403);
					expect(await res.json()).toEqual(ingressOnly);
				});

				it("refuses a PAGE too — the cross-site guard is API-only, this one is not", async () => {
					ingressHost = TUNNEL;
					const res = await proxy(
						request({ host: TUNNEL }, `https://${TUNNEL}/login`, "GET"),
					);
					expect(res.status).toBe(403);
					expect(await res.json()).toEqual(ingressOnly);
				});

				it("stays closed when the persisted row does not name the Host (worker down, sidecar restarted, DB fault) — no read is consulted", async () => {
					ingressHost = null;
					vi.stubEnv("AUTH_MODE", "none");
					const page = await proxy(
						request({ host: TUNNEL }, `https://${TUNNEL}/vod/jobs`, "GET"),
					);
					expect(page.status).toBe(403);
					expect(await page.json()).toEqual(ingressOnly);
					expect(ingressHostname).not.toHaveBeenCalled();
				});

				it("a trailing-dot Host is the same name, not an escape — and an allowlisted name keeps its allowance with the dot", async () => {
					ingressHost = TUNNEL;
					const page = await proxy(
						request({ host: `${TUNNEL}.` }, `https://${TUNNEL}./login`, "GET"),
					);
					expect(page.status).toBe(403);
					expect(await page.json()).toEqual(ingressOnly);
					vi.stubEnv("ALLOWED_ORIGIN_HOSTS", "ovp.example");
					const listed = await proxy(
						request(
							{ host: "ovp.example." },
							"https://ovp.example./vod/jobs",
							"GET",
						),
					);
					expect(listed.status).not.toBe(403);
				});

				it("lets the receiver and the health probe through", async () => {
					ingressHost = TUNNEL;
					const receiver = await proxy(
						request(
							{ host: TUNNEL },
							`https://${TUNNEL}/api/webhooks/bitmovin/hb/tok`,
						),
					);
					expect(receiver.status).toBe(200);
					const health = await proxy(
						request({ host: TUNNEL }, `https://${TUNNEL}/api/health`, "GET"),
					);
					expect(health.status).toBe(200);
				});

				it("does not restrict a hostname the operator put on the static allowlist, even when it is also the ingress", async () => {
					vi.stubEnv("ALLOWED_ORIGIN_HOSTS", TUNNEL);
					ingressHost = TUNNEL;
					const res = await proxy(
						request({ host: TUNNEL }, `https://${TUNNEL}/api/credentials`),
					);
					// past the door: whatever the auth gate answers, never the ingress 403
					expect(res.status).not.toBe(403);
					expect(ingressHostname).not.toHaveBeenCalled();
				});

				it("leaves an IP-literal Host (a LAN address) to the other layers without any database read", async () => {
					ingressHost = TUNNEL;
					const page = await proxy(
						request(
							{ host: "192.168.1.5:3100" },
							"http://192.168.1.5:3100/vod/jobs",
							"GET",
						),
					);
					expect(page.status).not.toBe(403);
					expect(ingressHostname).not.toHaveBeenCalled();
				});

				it("userinfo in the Host is not a host: `tunnel@localhost` takes the door for pages AND the API (security-review A)", async () => {
					const forged = `${TUNNEL}@localhost`;
					const page = await proxy(
						request({ host: forged }, "http://localhost:3100/vod/jobs", "GET"),
					);
					expect(page.status).toBe(403);
					expect(await page.json()).toEqual(ingressOnly);
					const api = await proxy(
						request(
							{ host: `${TUNNEL}@127.0.0.1` },
							"http://localhost:3100/api/credentials",
						),
					);
					expect(api.status).toBe(403);
				});

				it("an unparsable or absent Host takes the door too (security-review B)", async () => {
					for (const host of [
						`${TUNNEL}:99999`,
						`${TUNNEL}:abc`,
						"[::1",
						"1.2.3.4.5",
						"999.1.1.1",
					]) {
						const page = await proxy(
							request({ host }, "http://localhost:3100/vod/jobs", "GET"),
						);
						expect(page.status, host).toBe(403);
					}
					// an absent Host (HTTP/1.0 only) takes the door as well
					const absent = await proxy(
						request({}, "http://localhost:3100/vod/jobs", "GET"),
					);
					expect(absent.status).toBe(403);
				});

				it("a digit-leading NAME is not an IP literal, and an allowlist match is exact, not a suffix (security-review C)", async () => {
					const digitName = await proxy(
						request(
							{ host: "1abc.example" },
							"http://localhost:3100/vod/jobs",
							"GET",
						),
					);
					expect(digitName.status).toBe(403);
					const suffix = await proxy(
						request(
							{ host: "notlocalhost" },
							"http://localhost:3100/vod/jobs",
							"GET",
						),
					);
					expect(suffix.status).toBe(403);
				});

				it("treats a LAN NAME that is not allowlisted as a door too — mDNS and internal names go on ALLOWED_ORIGIN_HOSTS", async () => {
					const page = await proxy(
						request(
							{ host: "studio-mac.local:3100" },
							"http://studio-mac.local:3100/vod/jobs",
							"GET",
						),
					);
					expect(page.status).toBe(403);
					vi.stubEnv("ALLOWED_ORIGIN_HOSTS", "studio-mac.local");
					const listed = await proxy(
						request(
							{ host: "studio-mac.local:3100" },
							"http://studio-mac.local:3100/vod/jobs",
							"GET",
						),
					);
					expect(listed.status).not.toBe(403);
				});
			});
		});
	});
});

describe("auth gate — misconfiguration fails closed", () => {
	it("503s /api/* with nothing configured (an unconfigured install is NOT open)", async () => {
		const res = await proxy(request({ host: "localhost:3100" }));
		expect(res.status).toBe(503);
		const body = (await res.json()) as {
			error: string;
			details: { code: string };
		};
		expect(body.error).toBe("Authentication is not configured");
		expect(body.details).toEqual({ code: "AUTH_NOT_CONFIGURED" });
		expect(JSON.stringify(body)).not.toContain("AUTH_PASSWORD_HASH");
		expect(JSON.stringify(body)).not.toContain("AUTH_SESSION_SECRET");
		expect(JSON.stringify(body)).not.toContain("AUTH_MODE");
	});

	it("redirects page requests to localized login without raw config prose", async () => {
		const res = await proxy(
			request(
				{ host: "localhost:3100" },
				"http://localhost:3100/vod/jobs",
				"GET",
			),
		);
		expect(res.status).toBe(307);
		expect(res.headers.get("location")).toBe("http://localhost:3100/login");
		expect(await res.text()).not.toContain("AUTH_");
	});

	const partial: [name: string, env: Record<string, string>][] = [
		["only AUTH_PASSWORD_HASH", { AUTH_PASSWORD_HASH: HASH }],
		["only AUTH_SESSION_SECRET", { AUTH_SESSION_SECRET: SECRET }],
		[
			"a too-short session secret",
			{ AUTH_PASSWORD_HASH: HASH, AUTH_SESSION_SECRET: "short" },
		],
		[
			"a plaintext password where the hash belongs",
			{ AUTH_PASSWORD_HASH: "hunter2", AUTH_SESSION_SECRET: SECRET },
		],
		["an unknown AUTH_MODE", { AUTH_MODE: "basic" }],
	];

	for (const [name, env] of partial) {
		it(`503s with ${name}`, async () => {
			for (const [key, value] of Object.entries(env)) {
				vi.stubEnv(key, value);
			}
			expect((await proxy(request({ host: "localhost:3100" }))).status).toBe(
				503,
			);
		});
	}

	it("503s AUTH_MODE=oidc — the seam must not authenticate anyone", async () => {
		vi.stubEnv("AUTH_MODE", "oidc");
		const res = await proxy(request({ host: "localhost:3100" }));
		expect(res.status).toBe(503);
		const body = (await res.json()) as {
			error: string;
			details: { code: string };
		};
		expect(body.error).toBe("Authentication is not configured");
		expect(body.details).toEqual({ code: "AUTH_NOT_CONFIGURED" });
		expect(JSON.stringify(body)).not.toContain("OIDC provider");
	});
});

describe("auth gate — AUTH_MODE=none", () => {
	it("lets guarded api and page requests through", async () => {
		vi.stubEnv("AUTH_MODE", "none");
		expect((await proxy(request({ host: "localhost:3100" }))).status).toBe(200);
		expect(
			(
				await proxy(
					request(
						{ host: "localhost:3100" },
						"http://localhost:3100/settings/credentials",
						"GET",
					),
				)
			).status,
		).toBe(200);
	});
});

describe("auth gate — exempt paths without a cookie", () => {
	beforeEach(passwordMode);

	const exempt: [path: string, method: string][] = [
		["/api/health", "GET"],
		["/api/webhooks/bitmovin", "POST"],
		["/api/auth/login", "POST"],
		["/api/auth/logout", "POST"],
		["/api/auth/session", "GET"],
		["/login", "GET"],
		["/login?next=%2Fvod%2Fjobs", "GET"],
		["/_next/static/chunks/main.js", "GET"],
		["/favicon.ico", "GET"],
	];

	for (const [path, method] of exempt) {
		it(`${path} is reachable`, async () => {
			const res = await proxy(
				request(
					{ host: "localhost:3100" },
					`http://localhost:3100${path}`,
					method,
				),
			);
			expect(res.status).toBe(200);
		});
	}
});

describe("auth gate — guarded api paths without a valid cookie", () => {
	beforeEach(passwordMode);

	const guarded = [
		"/api/credentials",
		"/api/credentials/3f1f0e8e-2c5b-4a4e-9a64-0f6f4d2c9b11",
		"/api/live/stream-keys",
		"/api/live/stream-keys/3f1f0e8e-2c5b-4a4e-9a64-0f6f4d2c9b11",
		"/api/infrastructure/prewarmed-pools/abc/actions",
		"/api/live-channels/abc/esam-media-point",
		"/api/encoding-jobs",
		"/api/webhook-events",
		// Near-misses on the exempt prefixes.
		"/api/healthz",
		"/api/authenticate",
		"/api/webhooksomething",
	];

	for (const path of guarded) {
		it(`${path} → 401 JSON, never a redirect`, async () => {
			const res = await proxy(
				request({ host: "localhost:3100" }, `http://localhost:3100${path}`),
			);
			expect(res.status).toBe(401);
			expect(res.headers.get("location")).toBeNull();
			expect(await res.json()).toEqual({ error: "Authentication required" });
		});
	}

	const rejectedCookies: [name: string, cookie: string][] = [
		["a tampered signature", `${SESSION_COOKIE}=${tampered()}`],
		["a foreign-secret signature", `${SESSION_COOKIE}=${foreignSigned()}`],
		["an unsigned garbage value", `${SESSION_COOKIE}=not-a-token`],
		["an expired session", `${SESSION_COOKIE}=${expired()}`],
		["a cookie minted under AUTH_MODE=none", `${SESSION_COOKIE}=${noneMode()}`],
	];

	for (const [name, cookie] of rejectedCookies) {
		it(`401s ${name} and clears the stale cookie`, async () => {
			const res = await proxy(request({ host: "localhost:3100", cookie }));
			expect(res.status).toBe(401);
			const cleared = setCookies(res);
			expect(
				cleared.some((value) => value.includes(`${SESSION_COOKIE}=;`)),
			).toBe(true);
			expect(
				cleared.some((value) => value.includes(`${SECURE_SESSION_COOKIE}=;`)),
			).toBe(true);
		});
	}

	it("does not emit a clearing Set-Cookie when no cookie was sent", async () => {
		const res = await proxy(request({ host: "localhost:3100" }));
		expect(setCookies(res)).toEqual([]);
	});

	/**
	 * The clearing above was asserted to HAPPEN but never to be ACCEPTED by a
	 * browser, and that gap is the whole bug class: `__Host-` without `Secure` is
	 * ignored (RFC 6265bis §4.1.3.2), a Secure `Set-Cookie` from a non-trustworthy
	 * origin is ignored , so a deletion can 401 and look completely clean
	 * while the session cookie stays live. The logout route was fixed and pinned
	 * for exactly this; this copy of the same rule kept the defect, and a mutation
	 * setting `secure: true` on both names here left all 1,376 tests green — in
	 * BOTH defect directions, which is what makes it worth a test rather than a
	 * comment.
	 */
	it("marks the __Host- clearing Secure and the bare one NOT", async () => {
		const res = await proxy(
			request({ host: "localhost:3100", cookie: `${SESSION_COOKIE}=garbage` }),
		);
		const cleared = setCookies(res);
		const secureHeader = cleared.find((value) =>
			value.startsWith(`${SECURE_SESSION_COOKIE}=`),
		);
		const bareHeader = cleared.find((value) =>
			value.startsWith(`${SESSION_COOKIE}=`),
		);
		// Both found, so neither assertion below can pass by being skipped.
		expect(secureHeader, cleared.join(" | ")).toBeDefined();
		expect(bareHeader, cleared.join(" | ")).toBeDefined();
		expect(secureHeader as string).toMatch(/;\s*Secure/i);
		expect(bareHeader as string).not.toMatch(/;\s*Secure/i);
	});
});

describe("auth gate — guarded api paths with a valid cookie", () => {
	beforeEach(passwordMode);

	it("passes through", async () => {
		const res = await proxy(
			request({ host: "localhost:3100", cookie: validCookie() }),
		);
		expect(res.status).toBe(200);
	});

	it("accepts the __Host- cookie name as well", async () => {
		const res = await proxy(
			request({
				host: "localhost:3100",
				cookie: validCookie(Date.now(), SECURE_SESSION_COOKIE),
			}),
		);
		expect(res.status).toBe(200);
	});

	it("does not touch Set-Cookie while the session is fresh", async () => {
		const res = await proxy(
			request({ host: "localhost:3100", cookie: validCookie() }),
		);
		expect(setCookies(res)).toEqual([]);
	});

	it("slides the session once past the halfway mark", async () => {
		const issuedAt = 1_760_000_000_000;
		vi.useFakeTimers();
		vi.setSystemTime(issuedAt);
		const cookie = validCookie(issuedAt);
		vi.setSystemTime(issuedAt + IDLE_MS * 0.75);
		const res = await proxy(request({ host: "localhost:3100", cookie }));
		expect(res.status).toBe(200);
		const [renewed] = setCookies(res);
		expect(renewed).toContain(`${SESSION_COOKIE}=v1.`);
		expect(renewed).toContain("HttpOnly");
		expect(renewed).toContain("SameSite=lax");
		expect(renewed).toContain("Path=/");
		expect(renewed).not.toContain("Secure");
	});

	it("uses __Host- + Secure when the request is https", async () => {
		const issuedAt = 1_760_000_000_000;
		vi.useFakeTimers();
		vi.setSystemTime(issuedAt);
		const cookie = validCookie(issuedAt);
		vi.setSystemTime(issuedAt + IDLE_MS * 0.75);
		const res = await proxy(
			request(
				{ host: "localhost:3100", cookie },
				"https://localhost:3100/api/credentials",
			),
		);
		const [renewed] = setCookies(res);
		expect(renewed).toContain(`${SECURE_SESSION_COOKIE}=v1.`);
		expect(renewed).toContain("Secure");
	});

	it("uses __Host- + Secure behind a TLS-terminating proxy", async () => {
		const issuedAt = 1_760_000_000_000;
		vi.useFakeTimers();
		vi.setSystemTime(issuedAt);
		const cookie = validCookie(issuedAt);
		vi.setSystemTime(issuedAt + IDLE_MS * 0.75);
		const res = await proxy(
			request({
				host: "localhost:3100",
				cookie,
				"x-forwarded-proto": "https",
			}),
		);
		const [renewed] = setCookies(res);
		expect(renewed).toContain(`${SECURE_SESSION_COOKIE}=v1.`);
		expect(renewed).toContain("Secure");
	});
});

describe("auth gate — page requests redirect to /login", () => {
	beforeEach(passwordMode);

	// #310: a page without a parseable Host takes the door; these arms pin the
	// auth gate, so the helper carries the allowlisted Host.
	function pageRequest(path: string): NextRequest {
		return request(
			{ host: "localhost:3100" },
			`http://localhost:3100${path}`,
			"GET",
		);
	}

	it("redirects an unauthenticated page request, preserving the target", async () => {
		const res = await proxy(pageRequest("/vod/jobs?status=RUNNING"));
		expect(res.status).toBe(307);
		const location = new URL(res.headers.get("location") as string);
		expect(location.origin).toBe("http://localhost:3100");
		expect(location.pathname).toBe("/login");
		expect(location.searchParams.get("next")).toBe("/vod/jobs?status=RUNNING");
	});

	it("omits next= for the dashboard", async () => {
		const location = new URL(
			(await proxy(pageRequest("/"))).headers.get("location") as string,
		);
		expect(location.pathname).toBe("/login");
		expect(location.search).toBe("");
	});

	it("never redirects /login onto itself", async () => {
		expect((await proxy(pageRequest("/login"))).status).toBe(200);
		expect((await proxy(pageRequest("/login?next=%2Fvod"))).status).toBe(200);
	});

	it("keeps the Location on our own origin (open-redirect)", async () => {
		// The target comes from nextUrl.pathname, so it cannot be an absolute
		// URL — this pins that the redirect is built from a path, not from
		// anything a caller supplies.
		for (const path of ["/vod/jobs", "//evil.example", "/settings"]) {
			const res = await proxy(pageRequest(path));
			if (res.status === 307) {
				expect(new URL(res.headers.get("location") as string).origin).toBe(
					"http://localhost:3100",
				);
			}
		}
	});

	it("lets an authenticated page request through", async () => {
		const res = new NextRequest("http://localhost:3100/vod/jobs", {
			method: "GET",
			headers: { cookie: validCookie(), host: "localhost:3100" },
		});
		expect((await proxy(res)).status).toBe(200);
	});
});

function tampered(): string {
	const token = signSession(
		issueSession({
			mode: "password",
			now: Date.now(),
			idleMs: IDLE_MS,
			maxMs: MAX_MS,
		}),
		SECRET,
	);
	const last = token.slice(-1);
	return `${token.slice(0, -1)}${last === "A" ? "B" : "A"}`;
}

function foreignSigned(): string {
	return signSession(
		issueSession({
			mode: "password",
			now: Date.now(),
			idleMs: IDLE_MS,
			maxMs: MAX_MS,
		}),
		`${SECRET}-attacker`,
	);
}

function expired(): string {
	const now = Date.now() - IDLE_MS - 1_000;
	return signSession(
		issueSession({ mode: "password", now, idleMs: IDLE_MS, maxMs: MAX_MS }),
		SECRET,
	);
}

function noneMode(): string {
	return signSession(
		issueSession({
			mode: "none",
			now: Date.now(),
			idleMs: IDLE_MS,
			maxMs: MAX_MS,
		}),
		SECRET,
	);
}
