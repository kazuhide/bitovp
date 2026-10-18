import { type CloudRegion, StaticIp } from "@bitmovin/api-sdk";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
	listQuerySchema,
	sanitizePage,
	sanitizeStaticIp,
	staticIpCreateSchema,
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

/** GET /api/infrastructure/static-ips — list (C6 paging). */
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
			const page = await api.encoding.infrastructure.staticIps.list({
				offset: query.data.offset,
				limit: query.data.limit,
			});
			return NextResponse.json(sanitizePage(page, sanitizeStaticIp));
		} catch (apiErr) {
			return bitmovinProxyError(apiErr);
		}
	} catch (err) {
		return routeError(err);
	}
}

/**
 * POST — request a static IP. It is consumed at ENCODING create
 * (Encoding.staticIpId, live-only); this surface manages only the IP
 * lifecycle. ipAddress/status are read-only (Bitmovin assigns them).
 */
export async function POST(req: Request) {
	const bodySchema = z.strictObject({
		bitmovinAccountId: z.uuid(),
		staticIp: staticIpCreateSchema,
	});
	const parsed = bodySchema.safeParse(await readJson(req));
	if (!parsed.success) {
		return validationError(parsed.error);
	}
	const { bitmovinAccountId, staticIp } = parsed.data;
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
			path: "/encoding/infrastructure/static-ips",
			// No secret fields on StaticIp — snapshot as-is.
			request: staticIp,
			call: () =>
				api.encoding.infrastructure.staticIps.create(
					new StaticIp({
						region: staticIp.region as CloudRegion,
						...(staticIp.infrastructureId
							? { infrastructureId: staticIp.infrastructureId }
							: {}),
					}),
				),
		});
		if (!outcome.ok) {
			return outcome.response;
		}
		return NextResponse.json(sanitizeStaticIp(outcome.result), {
			status: 201,
		});
	} catch (err) {
		return routeError(err);
	}
}
