import { NextResponse } from "next/server";
import { accountQuerySchema } from "@/lib/infrastructure/schemas";
import {
	auditedBitmovinCall,
	bitmovinClientForAccount,
} from "@/lib/server/bitmovin";
import { getServerContext } from "@/lib/server/context";
import {
	invalidIdResponse,
	jsonError,
	routeError,
	validationError,
} from "@/lib/server/http";

type RouteParams = { params: Promise<{ poolId: string; id: string }> };

/**
 * DELETE — drop one standby encoding from the pool. The pool refills toward
 * `targetPoolSize`, so this is how you recycle a single sick instance without
 * touching the pool definition.
 */
export async function DELETE(req: Request, { params }: RouteParams) {
	const { poolId, id } = await params;
	for (const routeId of [poolId, id]) {
		const invalid = invalidIdResponse(routeId);
		if (invalid) {
			return invalid;
		}
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
			path: `/encoding/live/standby-pools/${poolId}/encodings/${id}`,
			call: () => api.encoding.live.standbyPools.encodings.delete(poolId, id),
		});
		if (!outcome.ok) {
			return outcome.response;
		}
		return NextResponse.json({ id });
	} catch (err) {
		return routeError(err);
	}
}
