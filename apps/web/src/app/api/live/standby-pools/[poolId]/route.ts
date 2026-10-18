import { LiveStandbyPoolUpdate } from "@bitmovin/api-sdk";
import { NextResponse } from "next/server";
import { z } from "zod";
import { accountQuerySchema } from "@/lib/infrastructure/schemas";
import {
	sanitizeStandbyPoolDetails,
	standbyPoolUpdateSchema,
} from "@/lib/live-runtime/schemas";
import { fromBase64, toBase64 } from "@/lib/server/base64";
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

/**
 * GET — pool details. Bitmovin returns `encodingTemplate` base64-encoded; we
 * pass the raw value through unchanged AND add `encodingTemplateText` (decoded)
 * so the detail view can show/edit the real template. A payload that does not
 * decode cleanly omits the text field rather than rendering garbage.
 */
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
			const pool = await api.encoding.live.standbyPools.get(poolId);
			return NextResponse.json(sanitizeStandbyPoolDetails(pool, fromBase64));
		} catch (apiErr) {
			return bitmovinProxyError(apiErr);
		}
	} catch (err) {
		return routeError(err);
	}
}

const patchSchema = z.strictObject({
	bitmovinAccountId: z.uuid(),
	pool: standbyPoolUpdateSchema,
});

/**
 * PATCH — partial update (this resource DOES have an update endpoint, unlike the
 * PR-2 infrastructure resources). `encodingTemplate` again arrives as plain text
 * and is base64-encoded here; raising `targetPoolSize` starts more idling
 * encodings and therefore costs money immediately.
 */
export async function PATCH(req: Request, { params }: RouteParams) {
	const { poolId } = await params;
	const invalid = invalidIdResponse(poolId);
	if (invalid) {
		return invalid;
	}
	const parsed = patchSchema.safeParse(await readJson(req));
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
			method: "PATCH",
			path: `/encoding/live/standby-pools/${poolId}`,
			request: {
				...(pool.targetPoolSize !== undefined
					? { targetPoolSize: pool.targetPoolSize }
					: {}),
				...(pool.encodingTemplate !== undefined
					? { encodingTemplateChars: pool.encodingTemplate.length }
					: {}),
			},
			call: () =>
				api.encoding.live.standbyPools.patch(
					poolId,
					new LiveStandbyPoolUpdate({
						...(pool.targetPoolSize !== undefined
							? { targetPoolSize: pool.targetPoolSize }
							: {}),
						...(pool.encodingTemplate !== undefined
							? { encodingTemplate: toBase64(pool.encodingTemplate) }
							: {}),
					}),
				),
			responseSnapshot: (result) => ({ id: result.id }),
		});
		if (!outcome.ok) {
			return outcome.response;
		}
		return NextResponse.json(
			sanitizeStandbyPoolDetails(outcome.result, fromBase64),
		);
	} catch (err) {
		return routeError(err);
	}
}

/** DELETE — remove the pool and, with it, every encoding it keeps idling. */
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
			path: `/encoding/live/standby-pools/${poolId}`,
			call: () => api.encoding.live.standbyPools.delete(poolId),
		});
		if (!outcome.ok) {
			return outcome.response;
		}
		return NextResponse.json({ id: poolId });
	} catch (err) {
		return routeError(err);
	}
}
