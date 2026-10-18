import { describe, expect, it } from "vitest";
import { SESSION_COOKIE_NAMES } from "@/lib/auth/session";
import { POST } from "./route";

/**
 * There was no test here at all, and that is how the bug shipped: sign-out
 * returned `{ok:true}` over https while the cookie it claimed to clear survived
 * for its full absolute lifetime — 7 days by default. RFC 6265bis §4.1.3.2 tells
 * the UA to ignore any `Set-Cookie` whose name carries the `__Host-` prefix and
 * lacks `Secure`, deletions included, and Next does not add it for us.
 *
 * It matters more here than in most apps: the PR states there is no server-side
 * session store, so logout is the ONLY per-user revocation lever. The
 * alternative is rotating AUTH_SESSION_SECRET, which signs out everyone.
 */
describe("POST /api/auth/logout", () => {
	function setCookieHeaders(res: Response): string[] {
		return res.headers.getSetCookie();
	}

	it("clears both cookie names", () => {
		const headers = setCookieHeaders(POST());
		for (const name of SESSION_COOKIE_NAMES) {
			expect(headers.some((h) => h.startsWith(`${name}=`))).toBe(true);
		}
	});

	it("marks the __Host- deletion Secure and the bare one NOT", () => {
		/**
		 * PER NAME, because the two names have opposite requirements and asserting
		 * the shape instead of the requirement is how the previous version pinned a
		 * defect: `__Host-` without `Secure` is ignored (RFC 6265bis §4.1.3.2), but
		 * a Secure `Set-Cookie` from a non-trustworthy origin is ALSO ignored
		 *  — and the bare name is exactly the cookie a plain-http install
		 * holds. Requiring `Secure` on both moved the sign-out no-op from https to
		 * http rather than fixing it, and localhost hides that because localhost is
		 * trustworthy (review catch, demonstrated in Chrome on a LAN-IP origin).
		 */
		for (const header of setCookieHeaders(POST())) {
			const name = header.split("=")[0] as string;
			if (name.startsWith("__Host-")) {
				expect(header, header).toMatch(/;\s*Secure/i);
			} else {
				expect(header, header).not.toMatch(/;\s*Secure/i);
			}
		}
	});

	it("covers both names, so neither branch above can pass vacuously", () => {
		const names = setCookieHeaders(POST()).map((h) => h.split("=")[0]);
		expect(names.some((n) => n?.startsWith("__Host-"))).toBe(true);
		expect(names.some((n) => !n?.startsWith("__Host-"))).toBe(true);
	});

	it("expires them immediately and keeps them HttpOnly and host-wide", () => {
		for (const header of setCookieHeaders(POST())) {
			expect(header, header).toMatch(/Max-Age=0/);
			expect(header, header).toMatch(/HttpOnly/i);
			expect(header, header).toMatch(/Path=\//);
		}
	});

	it("sends no session value back", () => {
		for (const header of setCookieHeaders(POST())) {
			expect(header.split(";")[0]).toMatch(/=$/);
		}
	});
});
