import {
	MOQ_ARCHIVE_MAX_BYTES,
	MOQ_OBSERVATION_MAX_BODY_BYTES,
} from "../../../config/moq-policy";

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

type BodyPolicy = {
	limit: number;
	error: string;
	moqUpload?: "archive" | "observation";
};

function policyForPath(path: string, method: string): BodyPolicy | null {
	if (method === "PUT") {
		const upload =
			/^\/api\/live-channels\/[^/]+\/runs\/[^/]+\/moq-observations\/[^/]+(\/archive)?$/.exec(
				path,
			);
		if (!upload) return null;
		return upload[1]
			? {
					limit: MOQ_ARCHIVE_MAX_BYTES,
					error: "MoQ archive is too large",
					moqUpload: "archive",
				}
			: {
					limit: MOQ_OBSERVATION_MAX_BODY_BYTES,
					error: "MoQ observation body is too large",
					moqUpload: "observation",
				};
	}
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

/** Match bounded POST routes and MoQ PUTs through Next's path lookup. */
export function publicRequestBodyPolicy(
	method: string | undefined,
	target: string | undefined,
) {
	if ((method !== "POST" && method !== "PUT") || !target) return null;
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
	// Next unwraps data URLs before its decoded filesystem lookup. Apply the
	// same size policy to stale build IDs too, without rewriting the request.
	const dataPath = /^\/_next\/data\/[^/]+(\/.*)\.json$/.exec(pathname)?.[1];
	if (dataPath) {
		pathname = dataPath;
		// Conservatively cover indexed aliases without copying Next's dynamic
		// and interception-route parsing. The policy below still names only
		// the limited endpoints, and the forwarded URL stays untouched.
		if (pathname.startsWith("/index/")) {
			pathname = pathname.slice(6);
		}
	}
	const direct = policyForPath(pathname, method);
	if (direct) return direct;
	try {
		return policyForPath(
			decodeURIComponent(pathname).replace(/\/$/, ""),
			method,
		);
	} catch {
		return null;
	}
}
