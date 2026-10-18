import { NextResponse } from "next/server";
import {
	accountQuerySchema,
	sanitizePrewarmedPool,
} from "@/lib/infrastructure/schemas";
import {
	auditedBitmovinCall,
	bitmovinClientForAccount,
	bitmovinProxyError,
} from "@/lib/server/bitmovin";
import { getServerContext } from "@/lib/server/context";
import {
	invalidIdResponse,
	jsonError,
	routeError,
	validationError,
} from "@/lib/server/http";

type RouteParams = { params: Promise<{ poolId: string }> };

/** GET — pool details (status: STARTED | STOPPED). */
export async function GET(req: Request, { params }: RouteParams) {
	const { poolId } = await params;
	const invalid = invalidIdResponse(poolId);
	if (invalid) {
		return invalid;
	}
	const url = new URL(req.url);
	const query = accountQuerySchema.safeParse({
		bitmovinAccountId: url.searchParams.get("bitmovinAccountId") ?? undefined,
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
			const pool =
				await api.encoding.infrastructure.prewarmedEncoderPools.get(poolId);
			return NextResponse.json(sanitizePrewarmedPool(pool));
		} catch (apiErr) {
			return bitmovinProxyError(apiErr);
		}
	} catch (err) {
		return routeError(err);
	}
}

/** DELETE — remove the pool (no update API: delete + re-create). */
export async function DELETE(req: Request, { params }: RouteParams) {
	const { poolId } = await params;
	const invalid = invalidIdResponse(poolId);
	if (invalid) {
		return invalid;
	}
	const url = new URL(req.url);
	const query = accountQuerySchema.safeParse({
		bitmovinAccountId: url.searchParams.get("bitmovinAccountId") ?? undefined,
	});
	if (!query.success) {
		return validationError(query.error);
	}
	const { bitmovinAccountId } = query.data;
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
			method: "DELETE",
			path: `/encoding/infrastructure/prewarmed-encoder-pools/${poolId}`,
			call: () =>
				api.encoding.infrastructure.prewarmedEncoderPools.delete(poolId),
		});
		if (!outcome.ok) {
			return outcome.response;
		}
		return NextResponse.json({ id: poolId });
	} catch (err) {
		return routeError(err);
	}
}
