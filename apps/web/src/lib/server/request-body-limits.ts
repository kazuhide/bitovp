export const MAX_LOGIN_BODY_BYTES = 4 * 1024;
export const MAX_SETUP_BODY_BYTES = 8 * 1024;
export const MAX_WEBHOOK_BODY_BYTES = 1_000_000;

export function declaredBodyTooLarge(
	contentLength: string | null | undefined,
	limit: number,
): boolean {
	return (
		contentLength !== null &&
		contentLength !== undefined &&
		/^\d+$/.test(contentLength) &&
		Number(contentLength) > limit
	);
}

function policyForPath(path: string) {
	if (path === "/api/auth/login") {
		return { limit: MAX_LOGIN_BODY_BYTES, error: "Request body is too large" };
	}
	if (path === "/api/auth/setup") {
		return { limit: MAX_SETUP_BODY_BYTES, error: "Request body is too large" };
	}
	if (/^\/api\/webhooks\/bitmovin\/[^/]+\/[^/]+$/.test(path)) {
		return { limit: MAX_WEBHOOK_BODY_BYTES, error: "Payload too large" };
	}
	return null;
}

/** Match the three public POST routes, including Next's decoded path lookup. */
export function publicRequestBodyPolicy(
	method: string | undefined,
	target: string | undefined,
) {
	if (method !== "POST" || !target) return null;
	let pathname: string;
	try {
		const url = /^https?:\/\//i.test(target)
			? new URL(target)
			: new URL(
					`http://request.invalid${target.startsWith("/") ? "" : "/"}${target}`,
				);
		pathname = url.pathname
			.replace(/\\/g, "/")
			.replace(/\/{2,}/g, "/")
			.replace(/\/$/, "");
	} catch {
		return null;
	}
	const direct = policyForPath(pathname);
	if (direct) return direct;
	try {
		return policyForPath(decodeURIComponent(pathname).replace(/\/$/, ""));
	} catch {
		return null;
	}
}
