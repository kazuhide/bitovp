import { NextResponse } from "next/server";
import { loadAuthConfig } from "./config";
import { publicContextError } from "./public-context-error";
import {
	cookieMaxAgeSeconds,
	requestIsHttps,
	type SessionPayload,
	sessionCookieName,
	sessionCookieOptions,
	signSession,
} from "./session";
import { AuthContextError } from "./tenancy";

export function authError(err: unknown) {
	if (err instanceof SyntaxError)
		return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
	const response = publicContextError(
		err instanceof AuthContextError
			? err
			: { status: 503, message: "Authentication is unavailable" },
	);
	return NextResponse.json(
		{ error: response.error, details: { code: response.code } },
		{ status: err instanceof AuthContextError ? err.status : 503 },
	);
}
export function sessionResponse(
	req: Request,
	payload: SessionPayload,
	body: object = { ok: true },
) {
	const config = loadAuthConfig();
	if (!config.ok || config.settings.mode !== "users")
		return authError(
			new AuthContextError(503, "User authentication is unavailable"),
		);
	const secure = requestIsHttps(req.headers, req.url);
	const res = NextResponse.json(body, {
		headers: { "cache-control": "private, no-store" },
	});
	res.cookies.set(
		sessionCookieName(secure),
		signSession(payload, config.settings.sessionSecret),
		sessionCookieOptions(secure, cookieMaxAgeSeconds(payload, Date.now())),
	);
	return res;
}
