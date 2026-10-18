import { NextResponse } from "next/server";
import { z } from "zod";
import { customerErrorDetails } from "@/lib/customer-error";
import { auditedBitmovinCall } from "@/lib/server/bitmovin";
import { getServerContext } from "@/lib/server/context";
import {
	invalidIdResponse,
	jsonError,
	readJson,
	routeError,
	validationError,
} from "@/lib/server/http";
import { resolveLiveEncoding } from "@/lib/server/live-channel-encoding";

type RouteParams = { params: Promise<{ id: string }> };

const bodySchema = z.strictObject({ bitmovinAccountId: z.uuid() });

/**
 * POST /api/live-channels/[id]/insertable-content/stop — "Return to live now":
 * cut the currently-playing inserted content short and resume the ingest feed.
 *
 * The SDK's `stop.create` is typed `Promise<Response>` (a raw fetch Response,
 * NOT a Bitmovin model — this endpoint has no response body), so there is no
 * `id` to snapshot: a resolved promise IS the success signal and any non-2xx
 * has already been turned into a thrown BitmovinError by the SDK. The audit row
 * therefore records a fixed `{stopped: true}` snapshot instead of `{id}`.
 */
export async function POST(req: Request, { params }: RouteParams) {
	const { id } = await params;
	const invalid = invalidIdResponse(id);
	if (invalid) {
		return invalid;
	}
	const parsed = bodySchema.safeParse(await readJson(req));
	if (!parsed.success) {
		return validationError(parsed.error);
	}
	const { bitmovinAccountId } = parsed.data;
	try {
		const ctx = await getServerContext();
		const resolved = await resolveLiveEncoding({
			ctx,
			channelId: id,
			bitmovinAccountId,
			requireRunning: true,
			subject: "Stopping inserted content",
		});
		if (!resolved.ok) {
			return resolved.response;
		}
		const { api, encodingId } = resolved;
		const outcome = await auditedBitmovinCall({
			req,
			ctx,
			bitmovinAccountId,
			method: "POST",
			path: `/encoding/encodings/${encodingId}/live/insertable-content/stop`,
			call: () =>
				api.encoding.encodings.live.insertableContent.stop.create(encodingId),
			responseSnapshot: () => ({ stopped: true }),
		});
		if (!outcome.ok) {
			if (outcome.response.status === 409) {
				return jsonError(
					409,
					"No inserted content is currently active",
					customerErrorDetails("CONTENT_INSERT_NOT_ACTIVE"),
				);
			}
			return outcome.response;
		}
		return NextResponse.json({ encodingId, stopped: true });
	} catch (err) {
		return routeError(err);
	}
}
