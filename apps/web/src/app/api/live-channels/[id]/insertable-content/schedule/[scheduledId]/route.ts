import { NextResponse } from "next/server";
import { z } from "zod";
import { customerErrorDetails } from "@/lib/customer-error";
import { auditedBitmovinCall } from "@/lib/server/bitmovin";
import { getServerContext } from "@/lib/server/context";
import {
	invalidIdResponse,
	jsonError,
	routeError,
	validationError,
} from "@/lib/server/http";
import { resolveLiveEncoding } from "@/lib/server/live-channel-encoding";

type RouteParams = { params: Promise<{ id: string; scheduledId: string }> };

/**
 * `contentId` is a REQUIRED query param, not an optional nicety: the SDK's
 * de-schedule is `schedule.delete(encodingId, contentId, scheduledContentId)`
 * — the scheduled entry is addressed UNDER its content, and there is no
 * lookup-by-scheduled-id endpoint. The client takes it from the scheduled-list
 * row's own `contentId` field.
 */
const querySchema = z.object({
	bitmovinAccountId: z.uuid("bitmovinAccountId must be a UUID"),
	contentId: z.uuid("contentId must be a UUID"),
});

/** DELETE — de-schedule a pending/running content insertion. */
export async function DELETE(req: Request, { params }: RouteParams) {
	const { id, scheduledId } = await params;
	for (const routeId of [id, scheduledId]) {
		const invalid = invalidIdResponse(routeId);
		if (invalid) {
			return invalid;
		}
	}
	const url = new URL(req.url);
	const query = querySchema.safeParse({
		bitmovinAccountId: url.searchParams.get("bitmovinAccountId") ?? undefined,
		contentId: url.searchParams.get("contentId") ?? undefined,
	});
	if (!query.success) {
		return validationError(query.error);
	}
	const { bitmovinAccountId, contentId } = query.data;
	try {
		const ctx = await getServerContext();
		const resolved = await resolveLiveEncoding({
			ctx,
			channelId: id,
			bitmovinAccountId,
			requireRunning: true,
			subject: "De-scheduling insertable content",
		});
		if (!resolved.ok) {
			return resolved.response;
		}
		const { api, encodingId } = resolved;
		const outcome = await auditedBitmovinCall({
			req,
			ctx,
			bitmovinAccountId,
			method: "DELETE",
			path: `/encoding/encodings/${encodingId}/live/insertable-content/${contentId}/schedule/${scheduledId}`,
			call: () =>
				api.encoding.encodings.live.insertableContent.schedule.delete(
					encodingId,
					contentId,
					scheduledId,
				),
		});
		if (!outcome.ok) {
			if (outcome.response.status === 404 || outcome.response.status === 409) {
				return jsonError(
					outcome.response.status,
					"Scheduled insertion can no longer be cancelled",
					customerErrorDetails("CONTENT_RESERVATION_NOT_CANCELLABLE"),
				);
			}
			return outcome.response;
		}
		return NextResponse.json({ id: scheduledId, descheduled: true });
	} catch (err) {
		return routeError(err);
	}
}
