import { DnsMappingRequest } from "@bitmovin/api-sdk";
import { NextResponse } from "next/server";
import { z } from "zod";
import { listQuerySchema, sanitizePage } from "@/lib/infrastructure/schemas";
import {
	dnsMappingCreateSchema,
	sanitizeDnsMapping,
} from "@/lib/live-runtime/schemas";
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

/**
 * DNS ingest mappings: a stable `<subdomain>.<bitmovin zone>` hostname that
 * resolves to a live encoder's IP, so a contribution encoder can be pointed at
 * a name instead of an address that changes on every (re)start.
 *
 * SDK SHAPE (verified in @bitmovin/api-sdk 1.269.0 — deviates from a purely
 * account-level CRUD): `encoding.live.dnsMappings` exposes **list ONLY**.
 * create / get / delete / deleteAll live on the PER-ENCODING api
 * (`encoding.live.encodings.dnsMappings`) and all take an encodingId, because a
 * mapping only means something while it points at an encoding. So:
 *   GET  — account-wide list, or this-encoding list when `encodingId` is given
 *   POST — REQUIRES `encodingId` in the body
 *   DELETE (./[id]) — REQUIRES `encodingId` in the query
 */
export async function GET(req: Request) {
	const url = new URL(req.url);
	const query = listQuerySchema.safeParse({
		bitmovinAccountId: url.searchParams.get("bitmovinAccountId") ?? undefined,
		offset: url.searchParams.get("offset") ?? undefined,
		limit: url.searchParams.get("limit") ?? undefined,
	});
	if (!query.success) {
		return validationError(query.error);
	}
	const scope = z
		.object({ encodingId: z.uuid("encodingId must be a UUID").optional() })
		.safeParse({
			encodingId: url.searchParams.get("encodingId") ?? undefined,
		});
	if (!scope.success) {
		return validationError(scope.error);
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
		const paging = { offset: query.data.offset, limit: query.data.limit };
		try {
			const page = scope.data.encodingId
				? await api.encoding.live.encodings.dnsMappings.list(
						scope.data.encodingId,
						paging,
					)
				: await api.encoding.live.dnsMappings.list(paging);
			return NextResponse.json(sanitizePage(page, sanitizeDnsMapping));
		} catch (apiErr) {
			return bitmovinProxyError(apiErr);
		}
	} catch (err) {
		return routeError(err);
	}
}

const bodySchema = z.strictObject({
	bitmovinAccountId: z.uuid(),
	dnsMapping: dnsMappingCreateSchema,
});

/** POST — map a subdomain onto one encoding's ingest IP. */
export async function POST(req: Request) {
	const parsed = bodySchema.safeParse(await readJson(req));
	if (!parsed.success) {
		return validationError(parsed.error);
	}
	const { bitmovinAccountId, dnsMapping } = parsed.data;
	const { encodingId, ...request } = dnsMapping;
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
			path: `/encoding/live/encodings/${encodingId}/dns-mappings`,
			// A hostname mapping carries no secrets.
			request: dnsMapping,
			call: () =>
				api.encoding.live.encodings.dnsMappings.create(
					encodingId,
					new DnsMappingRequest(request),
				),
			responseSnapshot: (result) => sanitizeDnsMapping(result),
		});
		if (!outcome.ok) {
			return outcome.response;
		}
		return NextResponse.json(sanitizeDnsMapping(outcome.result), {
			status: 201,
		});
	} catch (err) {
		return routeError(err);
	}
}
