// Safe here because the SDK is in `serverExternalPackages` (next.config.ts,
// ) — node resolves it, Next does not bundle it. The note this replaces
// claimed the opposite.
import BitmovinApi from "@bitmovin/api-sdk";
import type { TestConnectionResult } from "@bitovp/core";
import { NextResponse } from "next/server";
import { writeAuditLog } from "@/lib/server/audit";
import { bitmovinErrorMessage } from "@/lib/server/bitmovin";
import { getServerContext } from "@/lib/server/context";
import { invalidIdResponse, jsonError, routeError } from "@/lib/server/http";

type RouteParams = { params: Promise<{ id: string }> };

const TEST_TIMEOUT_MS = 10_000;

/**
 * Never pass raw SDK error messages to the client: the SDK formatter embeds
 * request method/url/body — harmless for this GET, but a leak the moment the
 * pattern is copied onto a body-bearing call. The two test-specific cases
 * (auth guidance, our own timeout) are curated here; everything else goes
 * through the shared bitmovinErrorMessage helper (safe fields only).
 */
function safeFailureMessage(err: unknown): string {
	const e = err as { httpStatusCode?: number };
	if (e.httpStatusCode === 401 || e.httpStatusCode === 403) {
		return `Authentication failed (${e.httpStatusCode}) — check API key and org id`;
	}
	if (err instanceof Error && err.message === "TEST_CONNECTION_TIMEOUT") {
		return `No response within ${TEST_TIMEOUT_MS / 1000}s`;
	}
	return bitmovinErrorMessage(err);
}

/**
 * Verifies the stored API key against GET /account/information. The key is
 * decrypted server-side and handed to the SDK only — never returned. A
 * failed Bitmovin call is a *result* (ok: false), not a server error.
 */
export async function POST(req: Request, { params }: RouteParams) {
	const { id } = await params;
	const invalid = invalidIdResponse(id);
	if (invalid) {
		return invalid;
	}
	try {
		const ctx = await getServerContext();
		const account = await ctx.bitmovinAccounts.get(id);
		if (!account) {
			return jsonError(404, "Not found");
		}
		const apiKey = await ctx.bitmovinAccounts.revealApiKey(id);
		const api = new BitmovinApi({
			apiKey,
			...(account.tenantOrgId ? { tenantOrgId: account.tenantOrgId } : {}),
		});
		const startedAt = Date.now();
		try {
			const info = await Promise.race([
				api.account.information.get(),
				new Promise<never>((_, reject) =>
					setTimeout(
						() => reject(new Error("TEST_CONNECTION_TIMEOUT")),
						TEST_TIMEOUT_MS,
					),
				),
			]);
			const result: TestConnectionResult = {
				ok: true,
				latencyMs: Date.now() - startedAt,
				accountEmail: info.email,
			};
			await writeAuditLog(
				ctx,
				{
					method: "GET",
					path: "/account/information",
					statusCode: 200,
					durationMs: result.latencyMs,
					bitmovinAccountId: id,
					response: { email: info.email },
				},
				req,
			);
			return NextResponse.json(result);
		} catch (apiErr) {
			const result: TestConnectionResult = {
				ok: false,
				latencyMs: Date.now() - startedAt,
				message: safeFailureMessage(apiErr),
			};
			await writeAuditLog(
				ctx,
				{
					method: "GET",
					path: "/account/information",
					statusCode: (apiErr as { httpStatusCode?: number }).httpStatusCode,
					durationMs: result.latencyMs,
					bitmovinAccountId: id,
					error: result.message,
				},
				req,
			);
			return NextResponse.json(result);
		}
	} catch (err) {
		return routeError(err);
	}
}
