import {
	type PrewarmedEncoderPoolAction,
	PrewarmedEncoderPoolSchedule,
} from "@bitmovin/api-sdk";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
	listQuerySchema,
	poolScheduleCreateSchema,
	sanitizePage,
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
	readJson,
	routeError,
	validationError,
} from "@/lib/server/http";

type RouteParams = { params: Promise<{ poolId: string }> };

/** GET — list a pool's start/stop schedules (C6 paging). */
export async function GET(req: Request, { params }: RouteParams) {
	const { poolId } = await params;
	const invalid = invalidIdResponse(poolId);
	if (invalid) {
		return invalid;
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
			const page =
				await api.encoding.infrastructure.prewarmedEncoderPools.schedules.list(
					poolId,
					{ offset: query.data.offset, limit: query.data.limit },
				);
			return NextResponse.json(sanitizePage(page, sanitizePoolSchedule));
		} catch (apiErr) {
			return bitmovinProxyError(apiErr);
		}
	} catch (err) {
		return routeError(err);
	}
}

/**
 * POST — schedule a START or STOP. triggerDate is UTC ISO 8601; Bitmovin
 * ignores the seconds component.
 */
export async function POST(req: Request, { params }: RouteParams) {
	const { poolId } = await params;
	const invalid = invalidIdResponse(poolId);
	if (invalid) {
		return invalid;
	}
	const bodySchema = z.strictObject({
		bitmovinAccountId: z.uuid(),
		schedule: poolScheduleCreateSchema,
	});
	const parsed = bodySchema.safeParse(await readJson(req));
	if (!parsed.success) {
		return validationError(parsed.error);
	}
	const { bitmovinAccountId, schedule } = parsed.data;
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
			path: `/encoding/infrastructure/prewarmed-encoder-pools/${poolId}/schedules`,
			request: schedule,
			call: () =>
				api.encoding.infrastructure.prewarmedEncoderPools.schedules.create(
					poolId,
					new PrewarmedEncoderPoolSchedule({
						action: schedule.action as PrewarmedEncoderPoolAction,
						triggerDate: new Date(schedule.triggerDate),
					}),
				),
		});
		if (!outcome.ok) {
			return outcome.response;
		}
		return NextResponse.json(sanitizePoolSchedule(outcome.result), {
			status: 201,
		});
	} catch (err) {
		return routeError(err);
	}
}
