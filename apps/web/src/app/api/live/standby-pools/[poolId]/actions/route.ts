import { NextResponse } from "next/server";
import { z } from "zod";
import {
	STANDBY_POOL_ACTIONS,
	sanitizeStandbyPoolEncoding,
} from "@/lib/live-runtime/schemas";
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

const bodySchema = z.strictObject({
	bitmovinAccountId: z.uuid(),
	action: z.enum(STANDBY_POOL_ACTIONS),
});

/**
 * POST /api/live/standby-pools/[poolId]/actions
 *
 * `acquire` — take one READY encoding out of the pool and hand back its ingest
 *   points + manifest URLs. Sent with an **EMPTY body**: the SDK's
 *   `LiveStandbyPoolAcquireEncoding.ingestPoints` field is documented "not
 *   implemented yet and will be ignored if provided", so passing anything would
 *   be a lie in the audit trail. Adopting the acquired encoding as a managed
 *   LiveChannel is deliberately out of scope (ledgered in STATUS.md) — the
 *   coordinates are shown for copy/paste.
 * `deleteErrorEncodings` — clear the pool's ERROR instances so it can refill.
 *
 * The acquired encoding's `ingestPoints[].streamKey` is returned READABLE (it is
 * the credential the operator must type into their contribution encoder — same
 * ledgered exception as LiveChannel.streamKey) but the AUDIT row masks it:
 * redactSecrets matches the `key` suffix on the response snapshot.
 */
export async function POST(req: Request, { params }: RouteParams) {
	const { poolId } = await params;
	const invalid = invalidIdResponse(poolId);
	if (invalid) {
		return invalid;
	}
	const parsed = bodySchema.safeParse(await readJson(req));
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
		const actions = api.encoding.live.standbyPools.actions;
		const outcome = await auditedBitmovinCall({
			req,
			ctx,
			bitmovinAccountId,
			method: "POST",
			path:
				action === "acquire"
					? `/encoding/live/standby-pools/${poolId}/acquire`
					: `/encoding/live/standby-pools/${poolId}/delete-error-encodings`,
			request: { action },
			call: () =>
				action === "acquire"
					? actions.acquireEncoding(poolId)
					: actions.deleteErrorEncodings(poolId),
			responseSnapshot: (result) => sanitizeStandbyPoolEncoding(result),
		});
		if (!outcome.ok) {
			return outcome.response;
		}
		return NextResponse.json({
			poolId,
			action,
			encoding: sanitizeStandbyPoolEncoding(outcome.result),
		});
	} catch (err) {
		return routeError(err);
	}
}
