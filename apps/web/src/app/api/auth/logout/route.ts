import { NextResponse } from "next/server";
import {
	SESSION_COOKIE_NAMES,
	sessionCookieClearOptions,
} from "@/lib/auth/session";

/**
 * Clears both cookie names (https installs carry the `__Host-` one, http the
 * bare one) so switching schemes cannot leave a live session behind. There is
 * no server-side session store to revoke — rotating AUTH_SESSION_SECRET is the
 * lever that invalidates already-issued cookies everywhere.
 *
 * Clearing a `__Host-` cookie REQUIRES `Secure`. RFC 6265bis §4.1.3.2 tells the
 * UA to ignore any `Set-Cookie` whose name carries that prefix and lacks it —
 * deletions included — and Next does not add it for us. Without this, sign-out
 * returned `{ok:true}` over https while the cookie that was actually issued
 * survived for its full absolute lifetime (7 days by default), which matters
 * more here than usual: there is no server-side session store, so logout is the
 * only per-user revocation lever (review catch, demonstrated in Chrome).
 *
 * An earlier version of this note argued `Secure` on the bare name was harmless.
 * It was refuted by measurement — see `sessionCookieClearOptions` — and is removed
 * rather than left standing, because it is precisely the argument a later round
 * would cite to put `secure: true` back on both names.
 */
export function POST() {
	const res = NextResponse.json({ ok: true });
	for (const name of SESSION_COOKIE_NAMES) {
		// The per-name `secure` rule lives in sessionCookieClearOptions, shared with
		// proxy.ts's stale-cookie clearing, because two copies of it drifted once.
		res.cookies.set(name, "", sessionCookieClearOptions(name));
	}
	return res;
}
