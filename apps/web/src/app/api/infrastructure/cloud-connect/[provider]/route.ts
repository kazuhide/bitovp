import { NextResponse } from "next/server";
import { z } from "zod";
import {
	auditSnapshot,
	CLOUD_ACCOUNT_CREATE_SCHEMAS,
	CLOUD_ACCOUNT_SECRET_FIELDS,
	type CloudProviderId,
	isCloudProvider,
	listQuerySchema,
	sanitizeCloudAccount,
	sanitizePage,
} from "@/lib/infrastructure/schemas";
import {
	auditedBitmovinCall,
	bitmovinClientForAccount,
	bitmovinProxyError,
} from "@/lib/server/bitmovin";
import { getServerContext } from "@/lib/server/context";
import {
	jsonError,
	readJson,
	routeError,
	validationError,
} from "@/lib/server/http";
import { cloudAccountOps } from "@/lib/server/infrastructure-sdk";

type RouteParams = { params: Promise<{ provider: string }> };

function providerOr404(provider: string): CloudProviderId | NextResponse {
	return isCloudProvider(provider)
		? provider
		: jsonError(404, `Unknown Cloud Connect provider "${provider}"`);
}

/** GET /api/infrastructure/cloud-connect/[provider] — list accounts (C6 paging). */
export async function GET(req: Request, { params }: RouteParams) {
	const provider = providerOr404((await params).provider);
	if (provider instanceof NextResponse) {
		return provider;
	}
	const url = new URL(req.url);
	const query = listQuerySchema.safeParse({
		bitmovinAccountId: url.searchParams.get("bitmovinAccountId") ?? undefined,
		offset: url.searchParams.get("offset") ?? undefined,
		limit: url.searchParams.get("limit") ?? undefined,
	});
	if (!query.success) {
		return validationError(query.error);
	}
	try {
		const ctx = await getServerContext();
		const api = await bitmovinClientForAccount(
			ctx,
			query.data.bitmovinAccountId,
		);
		if (!api) {
			return jsonError(404, "Bitmovin account not found");
		}
		try {
			const page = await cloudAccountOps(api, provider).list({
				offset: query.data.offset,
				limit: query.data.limit,
			});
			return NextResponse.json(
				sanitizePage(page, (item) => sanitizeCloudAccount(provider, item)),
			);
		} catch (apiErr) {
			return bitmovinProxyError(apiErr);
		}
	} catch (err) {
		return routeError(err);
	}
}

/**
 * POST /api/infrastructure/cloud-connect/[provider] — create an account.
 * The provider schemas are STRICT: an unexpected (secret-looking) field 400s
 * instead of being silently dropped. Secret fields pass through to Bitmovin
 * and are never persisted/logged/echoed — the audit row carries presence
 * flags, the response goes through the public-field allowlist.
 */
export async function POST(req: Request, { params }: RouteParams) {
	const provider = providerOr404((await params).provider);
	if (provider instanceof NextResponse) {
		return provider;
	}
	const bodySchema = z.strictObject({
		bitmovinAccountId: z.uuid(),
		account: CLOUD_ACCOUNT_CREATE_SCHEMAS[provider],
	});
	const parsed = bodySchema.safeParse(await readJson(req));
	if (!parsed.success) {
		return validationError(parsed.error);
	}
	const { bitmovinAccountId } = parsed.data;
	const account = parsed.data.account as Record<string, unknown>;
	try {
		const ctx = await getServerContext();
		const api = await bitmovinClientForAccount(ctx, bitmovinAccountId);
		if (!api) {
			return jsonError(404, "Bitmovin account not found");
		}
		const outcome = await auditedBitmovinCall({
			req,
			ctx,
			bitmovinAccountId,
			method: "POST",
			path: `/encoding/infrastructure/${provider}`,
			request: auditSnapshot(account, CLOUD_ACCOUNT_SECRET_FIELDS[provider]),
			call: () => cloudAccountOps(api, provider).create(account),
		});
		if (!outcome.ok) {
			return outcome.response;
		}
		return NextResponse.json(sanitizeCloudAccount(provider, outcome.result), {
			status: 201,
		});
	} catch (err) {
		return routeError(err);
	}
}
