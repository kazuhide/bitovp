import { type UsageStatisticKind, utcDayStart } from "@bitovp/core";
import type { AppPrismaClient } from "@bitovp/db";

/** Rows must already be committed, or share the caller's owned transaction. */
export async function advanceUsageSweepCursor(
	prisma: Pick<AppPrismaClient, "usageSweepCursor">,
	accountId: string,
	kind: UsageStatisticKind,
	through: string,
	fetchedAt: Date,
): Promise<void> {
	const sweptThrough = utcDayStart(through);
	await prisma.usageSweepCursor.upsert({
		where: { bitmovinAccountId_kind: { bitmovinAccountId: accountId, kind } },
		create: {
			bitmovinAccountId: accountId,
			kind,
			sweptThrough,
			sweptAt: fetchedAt,
		},
		update: {},
	});
	await prisma.usageSweepCursor.updateMany({
		where: {
			bitmovinAccountId: accountId,
			kind,
			sweptThrough: { lte: sweptThrough },
			sweptAt: { lte: fetchedAt },
		},
		data: { sweptThrough, sweptAt: fetchedAt },
	});
}
