import {
	type CloudRegion,
	type PrewarmedEncoderDiskSize,
	PrewarmedEncoderPool,
} from "@bitmovin/api-sdk";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
	listQuerySchema,
	prewarmedPoolCreateSchema,
	sanitizePage,
	sanitizePrewarmedPool,
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

/** GET /api/infrastructure/prewarmed-pools — list (C6 paging). */
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
			const page = await api.encoding.infrastructure.prewarmedEncoderPools.list(
				{ offset: query.data.offset, limit: query.data.limit },
			);
			return NextResponse.json(sanitizePage(page, sanitizePrewarmedPool));
		} catch (apiErr) {
			return bitmovinProxyError(apiErr);
		}
	} catch (err) {
		return routeError(err);
	}
}

/**
 * POST — create a pool. cloudRegion must be a SPECIFIC region (the zod enum
 * rejects AUTO/continent/provider aggregates before Bitmovin does); diskSize
 * wire values are "500" | "1000" | "2000" (GB).
 */
export async function POST(req: Request) {
	const bodySchema = z.strictObject({
		bitmovinAccountId: z.uuid(),
		pool: prewarmedPoolCreateSchema,
	});
	const parsed = bodySchema.safeParse(await readJson(req));
	if (!parsed.success) {
		return validationError(parsed.error);
	}
	const { bitmovinAccountId, pool } = parsed.data;
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
			path: "/encoding/infrastructure/prewarmed-encoder-pools",
			// No secret fields on pools — snapshot as-is.
			request: pool,
			call: () =>
				api.encoding.infrastructure.prewarmedEncoderPools.create(
					new PrewarmedEncoderPool({
						...pool,
						cloudRegion: pool.cloudRegion as CloudRegion,
						diskSize: pool.diskSize as PrewarmedEncoderDiskSize,
					}),
				),
		});
		if (!outcome.ok) {
			return outcome.response;
		}
		return NextResponse.json(sanitizePrewarmedPool(outcome.result), {
			status: 201,
		});
	} catch (err) {
		return routeError(err);
	}
}
