import { NextResponse } from "next/server";
import { accountQuerySchema } from "@/lib/infrastructure/schemas";
import { sanitizeStreamKey } from "@/lib/live-runtime/schemas";
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

type RouteParams = { params: Promise<{ id: string }> };

/**
 * GET — reveal ONE stream key, `value` included.
 *
 * The list projection deliberately withholds `value` (it would hand out up to
 * 100 live ingest credentials per unauthenticated GET); revealing is an
 * explicit per-key request, mirroring the credential store's
 * write-only-plus-reveal shape. `no-store` keeps the value out of any
 * intermediary or browser cache.
 */
export async function GET(req: Request, { params }: RouteParams) {
	const { id } = await params;
	const invalid = invalidIdResponse(id);
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
			const key = await api.encoding.live.streamKeys.get(id);
			return NextResponse.json(sanitizeStreamKey(key), {
				headers: { "Cache-Control": "no-store" },
			});
		} catch (apiErr) {
			return bitmovinProxyError(apiErr);
		}
	} catch (err) {
		return routeError(err);
	}
}

/**
 * DELETE — release a reserved stream key. Bitmovin refuses (409) while the key
 * is ASSIGNED to an encoding; unassign it first (POST ./unassign) or stop the
 * encoding. The upstream conflict passes through untouched.
 */
export async function DELETE(req: Request, { params }: RouteParams) {
	const { id } = await params;
	const invalid = invalidIdResponse(id);
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
			path: `/encoding/live/stream-keys/${id}`,
			call: () => api.encoding.live.streamKeys.delete(id),
		});
		if (!outcome.ok) {
			return outcome.response;
		}
		return NextResponse.json({ id });
	} catch (err) {
		return routeError(err);
	}
}
