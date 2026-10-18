import { NextResponse } from "next/server";
import { z } from "zod";
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

type RouteParams = { params: Promise<{ id: string }> };

/**
 * `encodingId` is REQUIRED (see the deviation note in ../route.ts): the SDK's
 * delete is `encoding.live.encodings.dnsMappings.delete(encodingId, id)` —
 * there is no account-level delete. The client takes it from the listed
 * mapping's own `encodingId` field.
 */
const querySchema = z.object({
	bitmovinAccountId: z.uuid("bitmovinAccountId must be a UUID"),
	encodingId: z.uuid("encodingId must be a UUID"),
});

/** DELETE — drop one DNS mapping. */
export async function DELETE(req: Request, { params }: RouteParams) {
	const { id } = await params;
	const invalid = invalidIdResponse(id);
	if (invalid) {
		return invalid;
	}
	const url = new URL(req.url);
	const query = querySchema.safeParse({
		bitmovinAccountId: url.searchParams.get("bitmovinAccountId") ?? undefined,
		encodingId: url.searchParams.get("encodingId") ?? undefined,
	});
	if (!query.success) {
		return validationError(query.error);
	}
	const { bitmovinAccountId, encodingId } = query.data;
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
			path: `/encoding/live/encodings/${encodingId}/dns-mappings/${id}`,
			call: () =>
				api.encoding.live.encodings.dnsMappings.delete(encodingId, id),
		});
		if (!outcome.ok) {
			return outcome.response;
		}
		return NextResponse.json({ id });
	} catch (err) {
		return routeError(err);
	}
}
