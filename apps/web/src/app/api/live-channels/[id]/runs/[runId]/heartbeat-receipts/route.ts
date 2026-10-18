import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerContext } from "@/lib/server/context";
import {
	type HeartbeatReceiptPage,
	safeHeartbeatReceipt,
} from "@/lib/server/heartbeat-receipt-value";
import {
	invalidIdResponse,
	jsonError,
	routeError,
	validationError,
} from "@/lib/server/http";

const cursorSchema = z
	.string()
	.max(100)
	.transform((v) => v.split("|"))
	.pipe(z.tuple([z.iso.datetime({ offset: true }), z.uuid()]));
const querySchema = z.object({
	limit: z.coerce.number().int().min(1).max(200).default(100),
	cursor: cursorSchema.optional(),
});

/** Persisted, authenticated Push receipts, newest first; no provider calls or lifecycle authority. */
export async function GET(
	req: Request,
	{ params }: { params: Promise<{ id: string; runId: string }> },
) {
	const { id, runId } = await params;
	const invalid = invalidIdResponse(id) ?? invalidIdResponse(runId);
	if (invalid) return invalid;
	const query = new URL(req.url).searchParams;
	const parsed = querySchema.safeParse({
		limit: query.get("limit") ?? undefined,
		cursor: query.get("cursor") ?? undefined,
	});
	if (!parsed.success) return validationError(parsed.error);
	try {
		const { prisma } = await getServerContext();
		const run = await prisma.liveChannelRun.findFirst({
			where: { id: runId, liveChannelId: id },
			select: {
				id: true,
				status: true,
				bitmovinEncodingId: true,
				createdAt: true,
			},
		});
		if (!run) return jsonError(404, "run not found on this channel");
		const body: HeartbeatReceiptPage = {
			run: { id: run.id, status: run.status },
			rows: [],
		};
		if (!run.bitmovinEncodingId) return NextResponse.json(body);
		const { limit, cursor } = parsed.data;
		const rows = await prisma.webhookEvent.findMany({
			where: {
				source: "bitmovin",
				eventType: "LIVE_ENCODING_HEARTBEAT",
				signatureValid: true,
				liveChannelRunId: run.id,
				raw: { path: ["encoding", "id"], equals: run.bitmovinEncodingId },
				receivedAt: { gte: run.createdAt },
				...(cursor
					? {
							OR: [
								{ receivedAt: { lt: new Date(cursor[0]) } },
								{ receivedAt: new Date(cursor[0]), id: { lt: cursor[1] } },
							],
						}
					: {}),
			},
			orderBy: [{ receivedAt: "desc" }, { id: "desc" }],
			take: limit + 1,
			select: { id: true, receivedAt: true, raw: true },
		});
		const page = rows.slice(0, limit);
		for (const row of page) {
			const value = safeHeartbeatReceipt(row.raw, run.bitmovinEncodingId);
			if (value)
				body.rows.push({
					id: row.id,
					receivedAt: row.receivedAt.toISOString(),
					sampledAt: value.timestamp ?? null,
					value,
				});
		}
		const last = page.at(-1);
		// Cursor follows scanned records, even a malformed legacy envelope, so an
		// empty filtered page never hides older valid receipts. No offset drift.
		if (rows.length > limit && last)
			body.nextCursor = `${last.receivedAt.toISOString()}|${last.id}`;
		return NextResponse.json(body);
	} catch (error) {
		return routeError(error);
	}
}
