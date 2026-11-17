import "server-only";
import { PROVIDER_TERMINAL_STATUSES } from "@bitovp/core";
import type { AppTransactionClient } from "@bitovp/db";
import { z } from "zod";
import type { MoqArchiveMetadata } from "@/lib/moq-player/observations";
import { removeMoqArchiveFile } from "./moq-archive";
import {
	MoqObservationError,
	parseMoqObservationStore,
} from "./moq-observations";

export type MoqArchiveCleanupSnapshot = {
	organizationId: string;
	id: string;
	runId: string;
	sessionId: string;
	archive: MoqArchiveMetadata | null;
};

/** Called under the caller's channel lock, before deleting any corresponding runs. */
export async function snapshotMoqArchiveCleanup(
	tx: AppTransactionClient,
	liveChannelId?: string,
): Promise<MoqArchiveCleanupSnapshot[]> {
	if (liveChannelId)
		await tx.$queryRaw`SELECT id FROM "LiveChannelRun" WHERE "liveChannelId" = ${liveChannelId}::uuid ORDER BY id FOR UPDATE`;
	else
		await tx.$queryRaw`SELECT id FROM "LiveChannelRun" ORDER BY id FOR UPDATE`;
	const result: MoqArchiveCleanupSnapshot[] = [];
	let cursor: string | undefined;
	while (true) {
		const rows = await tx.liveChannelRun.findMany({
			where: liveChannelId ? { liveChannelId } : {},
			orderBy: { id: "asc" },
			take: 25,
			...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
			select: {
				id: true,
				organizationId: true,
				liveChannelId: true,
				status: true,
				bitmovinEncodingId: true,
				encoderStoppedConfirmedFor: true,
				providerStatus: true,
				providerTerminalAt: true,
				moqObservations: true,
			},
		});
		for (const row of rows) {
			if (row.moqObservations === undefined) continue;
			const sessions = parseMoqObservationStore(row.moqObservations).sessions;
			if (!sessions.length) continue;
			if (
				![row.id, row.organizationId, row.liveChannelId].every(
					(id) => z.uuid().safeParse(id).success,
				) ||
				(liveChannelId && row.liveChannelId !== liveChannelId)
			)
				throw new MoqObservationError(409, "MOQ_ARCHIVE_OWNERSHIP_INVALID");
			if (
				["RUNNING", "PROVISIONING", "STOPPING"].includes(row.status) ||
				!row.bitmovinEncodingId ||
				!(
					row.encoderStoppedConfirmedFor === row.bitmovinEncodingId ||
					(row.providerTerminalAt &&
						(PROVIDER_TERMINAL_STATUSES as readonly string[]).includes(
							row.providerStatus ?? "",
						))
				)
			)
				throw new MoqObservationError(409, "MOQ_ARCHIVE_PROVIDER_UNCONFIRMED");
			for (const session of sessions)
				result.push({
					organizationId: row.organizationId,
					id: row.liveChannelId,
					runId: row.id,
					sessionId: session.id,
					archive: session.archive,
				});
			if (result.length > 10_000)
				throw new MoqObservationError(409, "MOQ_ARCHIVE_CLEANUP_LIMIT");
		}
		if (rows.length < 25) break;
		cursor = rows.at(-1)?.id;
		if (!cursor) break;
	}
	return result;
}

/** Only invoke after the database commit. A failed delete must leave evidence intact. */
export async function cleanupDeletedMoqArchives(
	snapshots: readonly MoqArchiveCleanupSnapshot[],
) {
	let removed = 0,
		failed = 0;
	for (const item of snapshots) {
		try {
			if (
				await removeMoqArchiveFile(
					item.organizationId,
					{ id: item.id, runId: item.runId, sessionId: item.sessionId },
					item.archive,
				)
			)
				removed++;
		} catch {
			failed++;
		}
	}
	if (failed)
		console.warn("[moq-archive] local cleanup incomplete", { failed });
	return { removed, failed };
}
