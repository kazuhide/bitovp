import { EsamMediaPoint, EsamSignal } from "@bitmovin/api-sdk";
import { redactSecrets } from "@bitovp/core";
import { appendLiveChannelStepLogEntry } from "@bitovp/db";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
	esamMediaPointCreateSchema,
	sanitizeEsamMediaPoint,
} from "@/lib/live-runtime/schemas";
import { auditedBitmovinCall } from "@/lib/server/bitmovin";
import { getServerContext } from "@/lib/server/context";
import {
	invalidIdResponse,
	readJson,
	routeError,
	validationError,
} from "@/lib/server/http";
import { resolveLiveEncoding } from "@/lib/server/live-channel-encoding";

type RouteParams = { params: Promise<{ id: string }> };

const bodySchema = z.strictObject({
	bitmovinAccountId: z.uuid(),
	mediaPoint: esamMediaPointCreateSchema,
});

/**
 * POST /api/live-channels/[id]/esam-media-point — insert an out-of-band ESAM
 * (SCTE-250) media point into a RUNNING live encoding. Unlike the SCTE-35 cue
 * action, which the live-channel worker fires off the queue, this is a direct
 * server-side proxy call: there is no encoder state to reconcile and the
 * operator wants the upstream 4xx verbatim.
 *
 * Recorded TWICE, deliberately: the C7 AuditLog row (`auditedBitmovinCall`)
 * holds the full reproducible request including the base64 splice binary, and a
 * status-DONE `ESAM_MEDIA_POINT` step-log entry gives the channel a durable
 * "this was inserted" history that survives a reload — which the audit log,
 * being a separate screen keyed by account rather than by channel, does not.
 * The step-log entry carries the real request shape minus the base64 binary
 * in `request` (where the timeline renders it, and where copy-as-cURL would
 * read a body from); see OPERATION_KINDS in packages/core for why.
 *
 * The append is best-effort and runs AFTER the insertion: the media point has
 * already hit a live stream by then, so a failed write must not be reported to
 * the operator as a failed insertion (the SCTE35_CUE precedent).
 *
 * The encoding must have been STARTED with
 * `adInsertionSettings.enableEsamMediaPointInsertion` — Bitmovin rejects the
 * insertion otherwise, and its 422/409 passes through untouched.
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
	const { bitmovinAccountId, mediaPoint } = parsed.data;
	try {
		const ctx = await getServerContext();
		const resolved = await resolveLiveEncoding({
			ctx,
			channelId: id,
			bitmovinAccountId,
			requireRunning: true,
			subject: "ESAM media points",
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
			path: `/encoding/encodings/${encodingId}/live/esam/media-points`,
			// Secret-free: the SCTE-35 splice binary is signalling data, not a
			// credential, and it is size-capped by the schema.
			request: mediaPoint,
			call: () =>
				api.encoding.encodings.live.esam.mediaPoints.create(
					encodingId,
					new EsamMediaPoint({
						...(mediaPoint.matchTime
							? { matchTime: new Date(mediaPoint.matchTime) }
							: {}),
						signals: mediaPoint.signals.map((signal) => new EsamSignal(signal)),
					}),
				),
			responseSnapshot: (result) => sanitizeEsamMediaPoint(result),
		});
		if (!outcome.ok) {
			return outcome.response;
		}
		const insertedAt = new Date().toISOString();
		try {
			await appendLiveChannelStepLogEntry(
				ctx.prisma,
				id,
				redactSecrets({
					step: `esam-media-point:${insertedAt}`,
					kind: "ESAM_MEDIA_POINT",
					payload: { at: insertedAt, signalCount: mediaPoint.signals.length },
					// `request` carries the REAL Bitmovin body minus the base64 binary,
					// not a summary of it. Two reasons, both from review: StepTimeline
					// gates its expander on request/response, so a payload-only entry
					// persisted detail that rendered NOWHERE — and `curl-from-step`
					// builds the cURL BODY from `request`, so a summary here would emit
					// a request Bitmovin never accepts the moment someone maps this
					// endpoint in ENDPOINTS (which exists — this route calls it). The
					// binary itself stays in the C7 audit row.
					request: {
						...(mediaPoint.matchTime
							? { matchTime: mediaPoint.matchTime }
							: {}),
						signals: mediaPoint.signals.map((signal) => ({
							...(signal.offset !== undefined ? { offset: signal.offset } : {}),
						})),
					},
					refs: { encodingId },
					status: "DONE",
					startedAt: insertedAt,
					finishedAt: insertedAt,
				}),
			);
		} catch (err) {
			// The insertion already landed; the record is advisory. Logged rather
			// than swallowed, because a silently missing history entry is
			// indistinguishable from "the operator never inserted anything".
			console.error(
				`[esam] media point inserted on ${encodingId} but the step-log append failed:`,
				err,
			);
		}
		return NextResponse.json(
			{
				encodingId,
				insertedAt,
				mediaPoint: sanitizeEsamMediaPoint(outcome.result),
			},
			{ status: 201 },
		);
	} catch (err) {
		return routeError(err);
	}
}
