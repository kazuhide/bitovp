import { RescheduleEncodingRequest } from "@bitmovin/api-sdk";
import { NextResponse } from "next/server";
import { rescheduleSchema } from "@/lib/encoding-actions";
import { auditedBitmovinCall } from "@/lib/server/bitmovin";
import { getServerContext } from "@/lib/server/context";
import { resolveEncodingForRuntimeAction } from "@/lib/server/encoding-runtime";
import {
	invalidIdResponse,
	readJson,
	routeError,
	validationError,
} from "@/lib/server/http";

type RouteParams = { params: Promise<{ id: string }> };

/**
 * POST — MOVE this encoding to a different Cloud Connect (BYOC) infrastructure
 * (`encoding.encodings.reschedule(encodingId, new RescheduleEncodingRequest
 * ({infrastructureId}))`).
 *
 * NAMING TRAP (verified against dist/models/RescheduleEncodingRequest.d.ts,
 * @bitmovin/api-sdk 1.269.0): the request body carries **only**
 * `infrastructureId` — there is no date, delay or start-time field. "Reschedule"
 * here is the SCHEDULER sense (place this encoding on other infrastructure), NOT
 * "run it later". The UI labels it "Move to infrastructure" accordingly.
 *
 * `requireActive`: only an in-flight run can be re-placed; a finished encoding
 * has nowhere to move to.
 */
export async function POST(req: Request, { params }: RouteParams) {
	const { id } = await params;
	const invalid = invalidIdResponse(id);
	if (invalid) {
		return invalid;
	}
	const body = rescheduleSchema.safeParse(await readJson(req));
	if (!body.success) {
		return validationError(body.error);
	}
	const { infrastructureId } = body.data;
	try {
		const ctx = await getServerContext();
		const resolved = await resolveEncodingForRuntimeAction({
			ctx,
			jobId: id,
			subject: "Moving an encoding to another infrastructure",
			requireActive: true,
		});
		if (!resolved.ok) {
			return resolved.response;
		}
		const { api, encodingId, bitmovinAccountId } = resolved;
		const outcome = await auditedBitmovinCall({
			req,
			ctx,
			bitmovinAccountId,
			method: "POST",
			path: `/encoding/encodings/${encodingId}/reschedule`,
			// An infrastructure id is a plain resource reference, not a secret.
			request: { infrastructureId },
			call: () =>
				api.encoding.encodings.reschedule(
					encodingId,
					new RescheduleEncodingRequest({ infrastructureId }),
				),
		});
		if (!outcome.ok) {
			return outcome.response;
		}
		return NextResponse.json({ id, encodingId, infrastructureId });
	} catch (err) {
		return routeError(err);
	}
}
