import { orphanLiveEncodings } from "@bitovp/core";
import { NextResponse } from "next/server";
import { z } from "zod";
import { accountQuerySchema } from "@/lib/infrastructure/schemas";
import { bitmovinClientForAccount } from "@/lib/server/bitmovin";
import { getServerContext } from "@/lib/server/context";
import { jsonError, validationError } from "@/lib/server/http";

const pageSchema = z.object({
	items: z
		.array(z.object({ id: z.string().min(1), status: z.string().min(1) }))
		.max(100),
	totalCount: z.number().int().nonnegative().optional(),
});
const terminal = new Set(["FINISHED", "ERROR", "CANCELED", "TRANSFER_ERROR"]);

/** Read-only, manually requested snapshot; never an ownership or STOP decision.
 * Bounded to 10 provider pages / 1,000 local channels. Incomplete discovery
 * returns no count, rather than turning a partial inventory into a false zero.
 */
export async function GET(req: Request) {
	const query = accountQuerySchema.safeParse({
		bitmovinAccountId:
			new URL(req.url).searchParams.get("bitmovinAccountId") ?? undefined,
	});
	if (!query.success) return validationError(query.error);
	const { bitmovinAccountId } = query.data;
	try {
		const ctx = await getServerContext();
		const api = await bitmovinClientForAccount(ctx, bitmovinAccountId);
		if (!api) return jsonError(404, "Bitmovin account not found");
		const inventory = new Map<string, { id: string; status: string }>();
		let complete = false;
		for (let offset = 0; offset < 1000; offset += 100) {
			const page = pageSchema.parse(
				await api.encoding.encodings.list((q) =>
					q.type("LIVE").limit(100).offset(offset),
				),
			);
			for (const item of page.items) {
				if (inventory.has(item.id)) throw new Error("Unstable inventory");
				inventory.set(item.id, item);
			}
			if (page.items.length < 100 || page.totalCount === inventory.size) {
				if (page.totalCount !== undefined && page.totalCount !== inventory.size)
					throw new Error("Incomplete inventory");
				complete = true;
				break;
			}
		}
		if (!complete) throw new Error("Inventory limit reached");
		// Read after discovery to reduce false positives during CREATE. Do not
		// let a row belonging to a different account explain this account's ID.
		const channels = await ctx.prisma.liveChannel.findMany({
			where: { bitmovinAccountId },
			select: { bitmovinEncodingId: true, status: true, stepLog: true },
			take: 1001,
		});
		if (channels.length > 1000) throw new Error("Channel limit reached");
		const fromColumn = new Map<string, string>();
		const fromStepLog = new Map<string, string>();
		for (const channel of channels) {
			if (channel.bitmovinEncodingId)
				fromColumn.set(channel.bitmovinEncodingId, channel.status);
			for (const entry of Array.isArray(channel.stepLog)
				? channel.stepLog
				: []) {
				if (
					entry &&
					typeof entry === "object" &&
					!Array.isArray(entry) &&
					typeof entry.kind === "string" &&
					entry.kind.includes("ENCODING") &&
					typeof entry.resourceId === "string"
				) {
					fromStepLog.set(entry.resourceId, channel.status);
				}
			}
		}
		const now = new Date();
		const report = orphanLiveEncodings(
			[...inventory.values()].filter((item) => !terminal.has(item.status)),
			{ fromColumn, fromStepLog },
			now,
		);
		return NextResponse.json(
			{
				bitmovinAccountId,
				checkedAt: now.toISOString(),
				running: report.running,
				unexplained: report.orphans.length,
				contradicted: report.contradicted.length,
				inFlight: report.inFlight.length,
			},
			{ headers: { "Cache-Control": "no-store" } },
		);
	} catch {
		// SDK errors can contain request credentials; neither return nor log them.
		return jsonError(502, "Live inventory unavailable; count unknown");
	}
}
