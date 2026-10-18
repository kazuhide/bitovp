import { NextResponse } from "next/server";
import {
	accountQuerySchema,
	sanitizePoolSchedule,
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

type RouteParams = { params: Promise<{ poolId: string; scheduleId: string }> };

/** GET — schedule details. */
export async function GET(req: Request, { params }: RouteParams) {
	const { poolId, scheduleId } = await params;
	const invalid = invalidIdResponse(poolId) ?? invalidIdResponse(scheduleId);
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
			const schedule =
				await api.encoding.infrastructure.prewarmedEncoderPools.schedules.get(
					poolId,
					scheduleId,
				);
			return NextResponse.json(sanitizePoolSchedule(schedule));
		} catch (apiErr) {
			return bitmovinProxyError(apiErr);
		}
	} catch (err) {
		return routeError(err);
	}
}

/** DELETE — remove a schedule. */
export async function DELETE(req: Request, { params }: RouteParams) {
	const { poolId, scheduleId } = await params;
	const invalid = invalidIdResponse(poolId) ?? invalidIdResponse(scheduleId);
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
			path: `/encoding/infrastructure/prewarmed-encoder-pools/${poolId}/schedules/${scheduleId}`,
			call: () =>
				api.encoding.infrastructure.prewarmedEncoderPools.schedules.delete(
					poolId,
					scheduleId,
				),
		});
		if (!outcome.ok) {
			return outcome.response;
		}
		return NextResponse.json({ id: scheduleId });
	} catch (err) {
		return routeError(err);
	}
}
