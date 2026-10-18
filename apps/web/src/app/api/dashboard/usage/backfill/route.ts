import { randomUUID } from "node:crypto";
import {
	USAGE_BACKFILL_SETTING_PREFIX,
	USAGE_REFRESH_FAILURE_COOLDOWN_MS,
	type UsageBackfillStatus,
	usageBackfillDataSchema,
	usageBackfillJobId,
	usageBackfillProgressSchema,
	usageRefreshIsFresh,
	usageRefreshRange,
	usageStatisticsRequestSchema,
	utcDayStart,
} from "@bitovp/core";
import type { Job } from "bullmq";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerContext } from "@/lib/server/context";
import { jsonError, routeError } from "@/lib/server/http";
import { getUsageStatisticsQueue } from "@/lib/server/queue";

async function snapshot(
	job: Job | undefined,
): Promise<UsageBackfillStatus | null> {
	if (!job) return null;
	const data = usageBackfillDataSchema.parse(job.data);
	const state = await job.getState();
	const progress = usageBackfillProgressSchema.safeParse(job.progress);
	const days =
		(utcDayStart(data.to).getTime() - utcDayStart(data.from).getTime()) /
			86_400_000 +
		1;
	return {
		...data,
		status:
			state === "completed"
				? "completed"
				: state === "failed"
					? "failed"
					: state === "active"
						? "running"
						: "queued",
		completedChunks: progress.success ? progress.data.completedChunks : 0,
		totalChunks: progress.success
			? progress.data.totalChunks
			: Math.ceil(days / 25) * 2,
		rowsUpserted: progress.success ? progress.data.rowsUpserted : 0,
		// Never expose BullMQ failedReason: provider/transport errors may carry secrets.
		error:
			state === "failed"
				? "Statistics import failed; retry the request."
				: null,
	};
}

/** VIEWER read / OPERATOR request through the existing role table. */
export async function GET(req: Request) {
	const accountId = z
		.uuid()
		.safeParse(new URL(req.url).searchParams.get("accountId"));
	if (!accountId.success)
		return jsonError(400, "A valid accountId is required");
	try {
		const ctx = await getServerContext();
		const account = await ctx.prisma.bitmovinAccount.findUnique({
			where: { id: accountId.data },
			select: { id: true },
		});
		if (!account) return jsonError(404, "Bitmovin account not found");
		const marker = await ctx.prisma.appSetting.findUnique({
			where: { key: `${USAGE_BACKFILL_SETTING_PREFIX}${accountId.data}` },
			select: { value: true },
		});
		const job = marker
			? await getUsageStatisticsQueue().getJob(
					usageBackfillJobId(accountId.data, z.uuid().parse(marker.value)),
				)
			: undefined;
		return NextResponse.json({ job: await snapshot(job) });
	} catch (err) {
		return routeError(err);
	}
}

export async function POST(req: Request) {
	const body = await req.json().catch(() => null);
	const parsed = usageStatisticsRequestSchema.safeParse(body);
	if (!parsed.success)
		return jsonError(400, "Validation failed", z.flattenError(parsed.error));
	try {
		const data = parsed.data;
		const result = await (await getServerContext()).prisma.$transaction(
			async (tx) => {
				// Serialize new requests for this account across
				// both web processes. No provider call runs while this short lock is held.
				const accounts = await tx.$queryRaw<{ id: string }[]>`
				SELECT id FROM "BitmovinAccount" WHERE id = ${data.accountId}::uuid FOR UPDATE
			`;
				if (accounts.length === 0) return { missing: true as const };
				const queue = getUsageStatisticsQueue();
				const marker = await tx.appSetting.findUnique({
					where: { key: `${USAGE_BACKFILL_SETTING_PREFIX}${data.accountId}` },
					select: { value: true },
				});
				const previous = marker
					? await queue.getJob(
							usageBackfillJobId(data.accountId, z.uuid().parse(marker.value)),
						)
					: undefined;
				if (previous) {
					const state = await previous.getState();
					if (state !== "completed" && state !== "failed")
						return snapshot(previous);
				}
				let range: { from: string; to: string; automatic?: true };
				if (data.mode === "automatic") {
					const now = new Date();
					if (
						previous &&
						(await previous.getState()) === "failed" &&
						previous.data?.automatic === true
					) {
						const failedAt =
							previous.finishedOn ?? previous.processedOn ?? previous.timestamp;
						if (
							Number.isFinite(failedAt) &&
							failedAt > now.getTime() - USAGE_REFRESH_FAILURE_COOLDOWN_MS
						)
							return snapshot(previous);
					}
					const cursors = await tx.usageSweepCursor.findMany({
						where: { bitmovinAccountId: data.accountId },
						select: { kind: true, sweptThrough: true, sweptAt: true },
					});
					if (usageRefreshIsFresh(now, cursors)) return null;
					range = { ...usageRefreshRange(now, cursors), automatic: true };
				} else {
					range = { from: data.from, to: data.to };
				}
				const generation = randomUUID();
				await tx.appSetting.upsert({
					where: { key: `${USAGE_BACKFILL_SETTING_PREFIX}${data.accountId}` },
					create: {
						key: `${USAGE_BACKFILL_SETTING_PREFIX}${data.accountId}`,
						value: generation,
					},
					update: { value: generation },
				});
				const job = await queue.add(
					"backfill",
					{ accountId: data.accountId, ...range, generation },
					{
						// A rolled-back DB transaction may leave a Redis job behind. Its
						// generation can neither block a new request nor pass the worker fence.
						jobId: usageBackfillJobId(data.accountId, generation),
						attempts: 3,
						backoff: { type: "exponential", delay: 60_000 },
						removeOnComplete: { age: 604_800, count: 1000 },
						removeOnFail: { age: 604_800, count: 1000 },
					},
				);
				return snapshot(job);
			},
		);
		if (result && "missing" in result)
			return jsonError(404, "Bitmovin account not found");
		return NextResponse.json({ job: result }, { status: result ? 202 : 200 });
	} catch (err) {
		return routeError(err);
	}
}
