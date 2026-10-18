import { StreamKeysUnassignAction } from "@bitmovin/api-sdk";
import { NextResponse } from "next/server";
import { z } from "zod";
import { streamKeyUnassignSchema } from "@/lib/live-runtime/schemas";
import {
	auditedBitmovinCall,
	bitmovinClientForAccount,
} from "@/lib/server/bitmovin";
import { getServerContext } from "@/lib/server/context";
import {
	jsonError,
	readJson,
	routeError,
	validationError,
} from "@/lib/server/http";

const bodySchema = z
	.strictObject({ bitmovinAccountId: z.uuid() })
	.extend(streamKeyUnassignSchema.shape);

/**
 * POST /api/live/stream-keys/unassign — free every stream key held by one
 * encoding, so a RESERVED key can be re-pointed (or deleted) without waiting
 * for the encoding to be cleaned up. Bulk by encoding: the SDK action takes an
 * encodingId, not a key id.
 */
export async function POST(req: Request) {
	const parsed = bodySchema.safeParse(await readJson(req));
	if (!parsed.success) {
		return validationError(parsed.error);
	}
	const { bitmovinAccountId, encodingId } = parsed.data;
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
			path: "/encoding/live/stream-keys/unassign",
			request: { encodingId },
			call: () =>
				api.encoding.live.streamKeys.actions.unassign(
					new StreamKeysUnassignAction({ encodingId }),
				),
			// The action echoes back its own payload — no resource id exists.
			responseSnapshot: () => ({ encodingId }),
		});
		if (!outcome.ok) {
			return outcome.response;
		}
		return NextResponse.json({ encodingId, unassigned: true });
	} catch (err) {
		return routeError(err);
	}
}
