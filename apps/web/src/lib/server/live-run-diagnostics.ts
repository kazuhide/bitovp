import "server-only";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
	diagnosticsEventSchema,
	diagnosticsHdStartSchema,
	diagnosticsSrtSchema,
	diagnosticsStreamSchema,
	diagnosticsSummarySchema,
	finalHeartbeatSchema,
	liveDiagnosticsQuerySchema,
} from "@/lib/live-diagnostics/schemas";
import { writeAuditLog } from "./audit";
import { bitmovinClientForAccount } from "./bitmovin";
import { getServerContext } from "./context";
import {
	invalidIdResponse,
	jsonError,
	routeError,
	validationError,
} from "./http";

type Params = { id: string; runId: string };
const providerPageSchema = z.object({
	items: z.array(z.unknown()).max(100),
	totalCount: z.number().int().nonnegative(),
});

/** Reads are bound to the run's immutable encoding and original provider audit
 * account. Channel settings can be edited after a broadcast, so they are never
 * credential provenance. Missing or conflicting history fails closed. */
export async function getLiveRunDiagnostics(
	req: Request,
	{ id, runId }: Params,
	final = false,
) {
	const response = await handleDiagnostics(req, { id, runId }, final);
	response.headers.set("Cache-Control", "private, no-store");
	return response;
}

async function handleDiagnostics(
	req: Request,
	{ id, runId }: Params,
	final: boolean,
) {
	const invalid = invalidIdResponse(id) ?? invalidIdResponse(runId);
	if (invalid) return invalid;
	const search = new URL(req.url).searchParams;
	if (Array.from(search.keys()).some((key) => search.getAll(key).length !== 1))
		return jsonError(400, "Duplicate query parameter");
	if (final && search.size > 0)
		return jsonError(400, "Final heartbeat does not accept query parameters");
	const parsed = liveDiagnosticsQuerySchema.safeParse(
		Object.fromEntries(search),
	);
	if (!parsed.success) return validationError(parsed.error);
	const query = parsed.data;
	try {
		const ctx = await getServerContext();
		const run = await ctx.prisma.liveChannelRun.findFirst({
			where: { id: runId, liveChannelId: id },
			select: {
				id: true,
				status: true,
				endedAt: true,
				bitmovinEncodingId: true,
			},
		});
		if (!run) return jsonError(404, "Live run not found");
		if (
			!run.bitmovinEncodingId ||
			!z.uuid().safeParse(run.bitmovinEncodingId).success
		)
			return jsonError(409, "This run has no provider encoding");
		if (
			final &&
			(!(run.status === "STOPPED" || run.status === "ERROR") || !run.endedAt)
		)
			return jsonError(
				409,
				"Final heartbeat is only available after the run has ended",
			);
		const encodingId = run.bitmovinEncodingId;
		// Include CREATE evidence for runs that failed before live/start. The
		// response id, not a channel pointer or client account, binds that row.
		const provenance = await ctx.prisma.auditLog.findMany({
			where: {
				method: "POST",
				statusCode: { gte: 200, lt: 300 },
				OR: [
					{ path: `/encoding/encodings/${encodingId}/live/start` },
					{ path: `/encoding/encodings/${encodingId}/live/hd/start` },
					{
						path: "/encoding/encodings",
						response: { path: ["id"], equals: encodingId },
					},
				],
			},
			select: { bitmovinAccountId: true },
			distinct: ["bitmovinAccountId"],
		});
		const accounts = new Set(provenance.map((row) => row.bitmovinAccountId));
		const accountId = provenance[0]?.bitmovinAccountId;
		if (accounts.size !== 1 || !accountId)
			return jsonError(
				409,
				"The original Bitmovin account cannot be established for this run",
			);
		const api = await bitmovinClientForAccount(ctx, accountId);
		if (!api)
			return jsonError(
				404,
				"The original Bitmovin account is no longer available",
			);
		const kind = final ? "final-heartbeat" : query.kind;
		const basePath = `/encoding/statistics/encodings/${encodingId}/live-statistics`;
		const path = final
			? `/encoding/encodings/${encodingId}/live/heartbeat-final`
			: query.kind === "hd-start"
				? `/encoding/encodings/${encodingId}/live/hd/start`
				: `${basePath}${query.kind === "summary" ? "" : `/${query.kind}`}${query.srtInputId ? `/${query.srtInputId}` : ""}`;
		const started = Date.now();
		try {
			const stats = api.encoding.statistics.encodings.liveStatistics;
			const paging = { offset: query.offset, limit: query.limit };
			const envelope = {
				kind,
				runId,
				encodingId,
				fetchedAt: new Date().toISOString(),
			};
			let result: Record<string, unknown>;
			if (final) {
				const data = finalHeartbeatSchema.parse(
					await api.encoding.encodings.live.heartbeatFinal.get(encodingId),
				);
				result = { ...envelope, data };
			} else if (query.kind === "hd-start") {
				result = {
					...envelope,
					data: diagnosticsHdStartSchema.parse(
						await api.encoding.encodings.live.hd.getStartRequest(encodingId),
					),
				};
			} else if (query.kind === "summary") {
				result = {
					...envelope,
					data: diagnosticsSummarySchema.parse(await stats.get(encodingId)),
				};
			} else {
				const raw =
					query.kind === "events"
						? await stats.events.list(encodingId, paging)
						: query.kind === "streams"
							? await stats.streams.list(encodingId, paging)
							: query.srtInputId
								? await stats.srt.listBySrtInputId(
										encodingId,
										query.srtInputId,
										paging,
									)
								: await stats.srt.list(encodingId, paging);
				const page = providerPageSchema.parse(raw);
				if (page.items.length > query.limit)
					throw new Error("Provider exceeded page limit");
				const schema =
					query.kind === "events"
						? diagnosticsEventSchema
						: query.kind === "streams"
							? diagnosticsStreamSchema
							: diagnosticsSrtSchema;
				result = {
					...envelope,
					...paging,
					totalCount: page.totalCount,
					nextOffset:
						page.items.length > 0 &&
						query.offset + page.items.length < page.totalCount
							? query.offset + page.items.length
							: null,
					data: page.items.map((item) => schema.parse(item)),
				};
			}
			await writeAuditLog(
				ctx,
				{
					method: "GET",
					path,
					bitmovinAccountId: accountId,
					statusCode: 200,
					durationMs: Date.now() - started,
					request: { liveChannelId: id, runId, ...(final ? {} : query) },
					// Download URLs are bearer capabilities, never durable audit data.
					response: final ? { ...envelope, data: { available: true } } : result,
				},
				req,
			);
			return NextResponse.json(result, {
				headers: { "Cache-Control": "private, no-store" },
			});
		} catch (err) {
			const upstream = (err as { httpStatusCode?: unknown } | null)
				?.httpStatusCode;
			const status =
				typeof upstream === "number" && [404, 409, 422].includes(upstream)
					? upstream
					: 502;
			const error =
				status === 404
					? "Provider diagnostics are unavailable or have expired"
					: "Unable to retrieve provider diagnostics";
			// Do not copy SDK message/shortMessage/stack: any can contain signed
			// URLs or input credentials, including on a failed download request.
			await writeAuditLog(
				ctx,
				{
					method: "GET",
					path,
					bitmovinAccountId: accountId,
					statusCode: status,
					durationMs: Date.now() - started,
					request: { liveChannelId: id, runId, ...(final ? {} : query) },
					error,
				},
				req,
			);
			return jsonError(status, error);
		}
	} catch (err) {
		return routeError(err);
	}
}
