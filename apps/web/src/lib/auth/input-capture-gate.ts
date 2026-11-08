import { verifyInputCaptureAuthorization } from "@bitovp/core";

const UUID = "[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}";
const PATH = new RegExp(`^/api/encoding-input-captures/(${UUID})/content$`);
/** No prefix exemption: suffixes, slashes and all write methods remain guarded. */
export function inputCaptureReadId(
	path: string,
	method: string,
): string | null {
	return method === "GET" || method === "HEAD"
		? (PATH.exec(path)?.[1] ?? null)
		: null;
}

/** This capability authenticates before any tenant context or DB read. */
export function authorizeInputCaptureRequest(
	req: Request,
): { receiptId: string; organizationId: string; expiresAt: number } | null {
	const url = new URL(req.url);
	const receiptId = inputCaptureReadId(url.pathname, req.method);
	const base = process.env.BITOVP_CAPTURE_INPUT_BASE_URL;
	const secret = process.env.BITOVP_CAPTURE_INPUT_SECRET;
	if (!receiptId || url.search || !base || !secret || secret.length < 32)
		return null;
	let configured: URL;
	try {
		configured = new URL(base);
	} catch {
		return null;
	}
	if (
		configured.protocol !== "https:" ||
		configured.username ||
		configured.password ||
		configured.pathname !== "/" ||
		configured.search ||
		configured.hash
	)
		return null;
	const host = req.headers.get("host");
	if (
		!host ||
		!/^(?:\[[a-fA-F0-9:.]+\]|[a-zA-Z0-9.-]+)(?::\d{1,5})?$/.test(host)
	)
		return null;
	try {
		if (
			new URL(`https://${host}`).host.toLowerCase() !==
			configured.host.toLowerCase()
		)
			return null;
	} catch {
		return null;
	}
	const fetchSite = req.headers.get("sec-fetch-site");
	if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none")
		return null;
	const auth = verifyInputCaptureAuthorization({
		secret,
		receiptId,
		authorization: req.headers.get("authorization"),
	});
	return auth ? { receiptId, ...auth } : null;
}

export function inputCaptureUnauthorized(): Response {
	return Response.json(
		{ error: "Input capture authentication required" },
		{
			status: 401,
			headers: {
				"Cache-Control": "private, no-store",
				"X-Content-Type-Options": "nosniff",
				"WWW-Authenticate": 'Basic realm="encoding-input"',
			},
		},
	);
}
