import { NextResponse } from "next/server";
import { z } from "zod";
import { POOL_ACTIONS } from "@/lib/infrastructure/schemas";
import {
	auditedBitmovinCall,
	bitmovinClientForAccount,
} from "@/lib/server/bitmovin";
import { getServerContext } from "@/lib/server/context";
import {
	invalidIdResponse,
	jsonError,
	readJson,
	routeError,
	validationError,
} from "@/lib/server/http";

type RouteParams = { params: Promise<{ poolId: string }> };

const actionBodySchema = z.strictObject({
	bitmovinAccountId: z.uuid(),
	action: z.enum(POOL_ACTIONS),
});

/**
 * POST /api/infrastructure/prewarmed-pools/[poolId]/actions — start/stop.
 * Maps to POST /encoding/infrastructure/prewarmed-encoder-pools/{poolId}/{action};
 * both are audited like every other mutation.
 */
export async function POST(req: Request, { params }: RouteParams) {
	const { poolId } = await params;
	const invalid = invalidIdResponse(poolId);
	if (invalid) {
		return invalid;
	}
	const parsed = actionBodySchema.safeParse(await readJson(req));
	if (!parsed.success) {
		return validationError(parsed.error);
	}
	const { bitmovinAccountId, action } = parsed.data;
	try {
		const ctx = await getServerContext();
		const api = await bitmovinClientForAccount(ctx, bitmovinAccountId);
		if (!api) {
			return jsonError(404, "Bitmovin account not found");
		}
		const pools = api.encoding.infrastructure.prewarmedEncoderPools;
		const outcome = await auditedBitmovinCall({
			req,
			ctx,
			bitmovinAccountId,
			method: "POST",
			path: `/encoding/infrastructure/prewarmed-encoder-pools/${poolId}/${action}`,
			request: { action },
			call: () =>
				action === "start" ? pools.start(poolId) : pools.stop(poolId),
		});
		if (!outcome.ok) {
			return outcome.response;
		}
		return NextResponse.json({ id: poolId, action });
	} catch (err) {
		return routeError(err);
	}
}
