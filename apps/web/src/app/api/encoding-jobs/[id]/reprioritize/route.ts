import { ReprioritizeEncodingRequest } from "@bitmovin/api-sdk";
import { NextResponse } from "next/server";
import { reprioritizeSchema } from "@/lib/encoding-actions";
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
 * POST — change this encoding's scheduling priority
 * (`encoding.encodings.reprioritize(encodingId, new ReprioritizeEncodingRequest
 * ({priority}))`). 0..100, API default 50: higher wins among the
 * organisation's QUEUED encodings, so it only bites while work is still waiting
 * for capacity. `requireActive` therefore refuses a terminal job (a Bitmovin 400
 * would surface as an opaque 502 under the curated error policy).
 *
 * The payload is non-secret, so the audit snapshot carries it verbatim.
 */
export async function POST(req: Request, { params }: RouteParams) {
	const { id } = await params;
	const invalid = invalidIdResponse(id);
	if (invalid) {
		return invalid;
	}
	const body = reprioritizeSchema.safeParse(await readJson(req));
	if (!body.success) {
		return validationError(body.error);
	}
	const { priority } = body.data;
	try {
		const ctx = await getServerContext();
		const resolved = await resolveEncodingForRuntimeAction({
			ctx,
			jobId: id,
			subject: "Reprioritizing",
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
			path: `/encoding/encodings/${encodingId}/reprioritize`,
			request: { priority },
			call: () =>
				api.encoding.encodings.reprioritize(
					encodingId,
					new ReprioritizeEncodingRequest({ priority }),
				),
		});
		if (!outcome.ok) {
			return outcome.response;
		}
		return NextResponse.json({ id, encodingId, priority });
	} catch (err) {
		return routeError(err);
	}
}
