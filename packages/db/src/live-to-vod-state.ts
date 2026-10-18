import { type LiveToVodRecord, normalizeLiveToVodRecord } from "@bitovp/core";
import type { Prisma } from "../generated/client";
import type { AppPrismaClient } from "./client";

/** A lost fence is a stale delivery, never a reason to overwrite a newer run. */
export class LiveToVodFenceError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "LiveToVodFenceError";
	}
}

type AttemptCoordinates = {
	liveChannelId: string;
	liveChannelRunId: string;
	encodingId: string;
	attemptId: string;
};

const json = (record: LiveToVodRecord): Prisma.InputJsonValue =>
	record as unknown as Prisma.InputJsonValue;

/**
 * Claim the channel and the exact run in one transaction. A route must not
 * enqueue until both rows carry the same attempt identity.
 */
export async function claimLiveToVodAttempt(
	prisma: AppPrismaClient,
	args: AttemptCoordinates & { updatedAt: Date; record: LiveToVodRecord },
): Promise<boolean> {
	if (
		args.record.attemptId !== args.attemptId ||
		args.record.liveChannelRunId !== args.liveChannelRunId ||
		args.record.revision !== 0
	) {
		throw new LiveToVodFenceError(
			"live-to-VOD claim record does not carry the exact attempt/run at revision 0",
		);
	}
	return prisma.$transaction(async (tx) => {
		const channel = await tx.liveChannel.updateMany({
			where: {
				id: args.liveChannelId,
				status: "STOPPED",
				bitmovinEncodingId: args.encodingId,
				updatedAt: args.updatedAt,
			},
			data: { liveToVod: json(args.record) },
		});
		if (channel.count === 0) {
			return false;
		}
		const run = await tx.liveChannelRun.updateMany({
			where: {
				id: args.liveChannelRunId,
				liveChannelId: args.liveChannelId,
				bitmovinEncodingId: args.encodingId,
			},
			data: { liveToVod: json(args.record) },
		});
		if (run.count !== 1) {
			throw new LiveToVodFenceError(
				`live-to-VOD run ${args.liveChannelRunId} is no longer the channel's exact encoding run`,
			);
		}
		return true;
	});
}

/**
 * Persist progress/settlement on both rows, fenced by exact attempt + run.
 * The transaction prevents a channel-only success or latest-run mis-mirror.
 */
export async function persistLiveToVodAttempt(
	prisma: AppPrismaClient,
	args: AttemptCoordinates & {
		expectedRevision: number;
		record: LiveToVodRecord;
	},
): Promise<LiveToVodRecord> {
	if (
		args.record.attemptId !== args.attemptId ||
		args.record.liveChannelRunId !== args.liveChannelRunId ||
		args.record.revision !== args.expectedRevision
	) {
		throw new LiveToVodFenceError(
			"live-to-VOD write record does not carry the exact attempt/run/revision identity",
		);
	}
	const next: LiveToVodRecord = {
		...args.record,
		revision: args.expectedRevision + 1,
	};
	const exactRecordFence = [
		{
			liveToVod: {
				path: ["revision"],
				equals: args.expectedRevision,
			},
		},
		{
			liveToVod: {
				path: ["liveChannelRunId"],
				equals: args.liveChannelRunId,
			},
		},
	];
	await prisma.$transaction(async (tx) => {
		const channel = await tx.liveChannel.updateMany({
			where: {
				id: args.liveChannelId,
				bitmovinEncodingId: args.encodingId,
				liveToVod: { path: ["attemptId"], equals: args.attemptId },
				AND: exactRecordFence,
			},
			data: { liveToVod: json(next) },
		});
		if (channel.count !== 1) {
			throw new LiveToVodFenceError(
				`live-to-VOD attempt ${args.attemptId} is no longer current on channel ${args.liveChannelId}`,
			);
		}
		const run = await tx.liveChannelRun.updateMany({
			where: {
				id: args.liveChannelRunId,
				liveChannelId: args.liveChannelId,
				bitmovinEncodingId: args.encodingId,
				liveToVod: { path: ["attemptId"], equals: args.attemptId },
				AND: exactRecordFence,
			},
			data: { liveToVod: json(next) },
		});
		if (run.count !== 1) {
			throw new LiveToVodFenceError(
				`live-to-VOD attempt ${args.attemptId} lost its exact run ${args.liveChannelRunId}`,
			);
		}
	});
	return next;
}

/** Read and normalize the exact attempt. Used by queue/dead-job reconciliation. */
export async function readLiveToVodAttempt(
	prisma: AppPrismaClient,
	args: AttemptCoordinates,
): Promise<LiveToVodRecord | null> {
	const row = await prisma.liveChannel.findUnique({
		where: { id: args.liveChannelId },
		select: { bitmovinEncodingId: true, liveToVod: true },
	});
	const record = normalizeLiveToVodRecord(row?.liveToVod);
	return row?.bitmovinEncodingId === args.encodingId &&
		record?.attemptId === args.attemptId &&
		record.liveChannelRunId === args.liveChannelRunId
		? record
		: null;
}
