import "server-only";
// Safe here because the SDK is in `serverExternalPackages` (next.config.ts,
// ) — node resolves it, Next does not bundle it. The previous note said
// the opposite ("safe ONLY because Next bundles route handlers"), which was the
// belief that made the bundling failure hard to see: bundled, every route touching
// the SDK returned `r.call is not a function`. Do not copy this bare default import
// into tsx-executed code.
import BitmovinApi from "@bitmovin/api-sdk";
import type { NextResponse } from "next/server";
import { writeAuditLog } from "./audit";
import type { ServerContext } from "./context";
import { jsonError } from "./http";

/**
 * Resolves a stored Bitmovin account into a per-account SDK client. The API
 * key is decrypted server-side and handed to the SDK only — it never crosses
 * toward the client. Returns null when the account row does not exist.
 */
export async function bitmovinClientForAccount(
	ctx: ServerContext,
	bitmovinAccountId: string,
	signal?: AbortSignal,
	observeResponse?: (url: string, response: Response) => Promise<void>,
): Promise<BitmovinApi | null> {
	const account = await ctx.bitmovinAccounts.get(bitmovinAccountId);
	if (!account) {
		return null;
	}
	const apiKey = await ctx.bitmovinAccounts.revealApiKey(bitmovinAccountId);
	return new BitmovinApi({
		apiKey,
		...(account.tenantOrgId ? { tenantOrgId: account.tenantOrgId } : {}),
		...(signal || observeResponse
			? {
					fetch: async (url, init) => {
						const response = await fetch(url, {
							...init,
							...(signal ? { signal } : {}),
						});
						await observeResponse?.(String(url), response);
						return response;
					},
				}
			: {}),
	});
}

/**
 * Curated Bitmovin failure message. NEVER surface the raw SDK error string:
 * the SDK formatter embeds the full request (method/url/BODY — which for
 * infrastructure creates carries cloud secrets). Only httpStatusCode and
 * shortMessage (the API's own error message) are safe fields.
 */
export function bitmovinErrorMessage(err: unknown): string {
	const e = err as { httpStatusCode?: number; shortMessage?: string };
	if (typeof e.shortMessage === "string" && e.shortMessage.length > 0) {
		return `Bitmovin: ${e.shortMessage.slice(0, 300)}`;
	}
	return typeof e.httpStatusCode === "number"
		? `Bitmovin API error (${e.httpStatusCode})`
		: "Bitmovin API unreachable";
}

/**
 * Upstream statuses that carry information the CALLER can act on: the
 * resource is gone upstream (404), the operation conflicts with its current
 * state (409), or the payload was semantically rejected (422). Everything
 * else — notably 401/403/429, which are OUR credential/quota standing with
 * Bitmovin, not the browser's — maps to 502 so an upstream auth failure can
 * never masquerade as (or interfere with) this app's own auth once it lands.
 */
const PASS_THROUGH_STATUSES = new Set([404, 409, 422]);

/**
 * Upstream failure → HTTP response. An error WITHOUT httpStatusCode is not a
 * Bitmovin HTTP failure at all — it is a bug in our own call path (or a
 * pre-request SDK throw): log the real error server-side and answer a
 * generic 500 (never the misleading "Bitmovin API unreachable").
 */
export function bitmovinProxyError(err: unknown): NextResponse {
	const e = err as { httpStatusCode?: number };
	if (typeof e.httpStatusCode !== "number") {
		console.error(
			"[bitmovin] non-HTTP error calling the Bitmovin SDK:",
			err instanceof Error ? `${err.name}: ${err.message}\n${err.stack}` : err,
		);
		return jsonError(500, "Internal error calling Bitmovin");
	}
	const status = PASS_THROUGH_STATUSES.has(e.httpStatusCode)
		? e.httpStatusCode
		: 502;
	return jsonError(status, bitmovinErrorMessage(err));
}

/**
 * Runs one MUTATING Bitmovin call with the C7 audit trail: success and
 * failure both persist an entry. `request` must already be secret-free
 * (build it with auditSnapshot — presence flags instead of secret values).
 */
export async function auditedBitmovinCall<T>(options: {
	ctx: ServerContext;
	bitmovinAccountId: string;
	/** PATCH exists for the few resources Bitmovin lets you update in place. */
	method: "POST" | "PATCH" | "DELETE";
	/** Bitmovin API path, e.g. /encoding/infrastructure/aws — the audit key. */
	path: string;
	request?: unknown;
	call: () => Promise<T>;
	/** Secret-free response snapshot for the audit row (default: {id}). */
	responseSnapshot?: (result: T) => unknown;
	/**
	 * The handler's request, REQUIRED — it carries the proxy-verified actor.
	 *
	 * Required rather than optional because this helper is the single largest
	 * audit writer in the product: security-review-212 counted 29 route files
	 * reaching it, every mutating Bitmovin call among them (infrastructure
	 * create/delete, prewarmed pools, static IPs, DNS mappings, stream-key
	 * issue/rotate/unassign, standby pools, live insertable content, SCTE).
	 * All of them persisted `actor = NULL` while  claimed the
	 * opposite, because attribution was threaded into the six leaf routes that
	 * call `writeAuditLog` directly and not into the helper the other 34 use.
	 * Optional here would have meant a second silent population; required
	 * makes `tsc` the instrument that enumerates them.
	 */
	req: Request;
}): Promise<{ ok: true; result: T } | { ok: false; response: NextResponse }> {
	const { ctx, bitmovinAccountId, method, path, request, call, req } = options;
	const startedAt = Date.now();
	try {
		const result = await call();
		await writeAuditLog(
			ctx,
			{
				method,
				path,
				statusCode: method === "POST" ? 201 : 200,
				durationMs: Date.now() - startedAt,
				bitmovinAccountId,
				...(request !== undefined ? { request } : {}),
				response: options.responseSnapshot?.(result) ?? {
					id: (result as { id?: string } | null)?.id,
				},
			},
			req,
		);
		return { ok: true, result };
	} catch (err) {
		await writeAuditLog(
			ctx,
			{
				method,
				path,
				statusCode: (err as { httpStatusCode?: number }).httpStatusCode,
				durationMs: Date.now() - startedAt,
				bitmovinAccountId,
				...(request !== undefined ? { request } : {}),
				error: bitmovinErrorMessage(err),
			},
			req,
		);
		return { ok: false, response: bitmovinProxyError(err) };
	}
}
