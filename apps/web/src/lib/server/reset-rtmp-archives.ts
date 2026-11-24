import { classifyProviderStatusWord } from "@bitovp/core";
import {
	type AppPrismaClient,
	type AppTransactionClient,
	collectLiveStopTargets,
	liveChannelAccountId,
	mergeRtmpRetirementEvidence,
	type Prisma,
	unconfirmedRtmpEncoders,
} from "@bitovp/db";
import type { EncoderPointer } from "./reset";

export const INCOMPLETE_RTMP_ARCHIVE_MESSAGE =
	"This broadcast has missing encoder identities in its creation or stop history. Verify the provider account before deleting this broadcast.";

export class IncompleteRtmpArchive extends Error {
	constructor() {
		super(INCOMPLETE_RTMP_ARCHIVE_MESSAGE);
	}
}

const ownershipLogKinds = [
	"CREATE_INPUT_RTMP",
	"CREATE_ENCODING",
	"RESOLVE_AISA_LIVE_ENCODING",
];

/** The channel log belongs to the latest airing. Older airings use their own log. */
export async function readResetRtmpArchives(
	prisma: AppPrismaClient | AppTransactionClient,
	channelId?: string,
) {
	const logSources = ownershipLogKinds.map((kind) => ({
		stepLog: { array_contains: [{ kind }] },
	}));
	const claimActions = { action: { in: ["STOP", "RESTART"] } };
	const channels = await prisma.liveChannel.findMany({
		where: {
			...(channelId ? { id: channelId } : {}),
			OR: [
				...logSources,
				{ error: { startsWith: "stop did not confirm — " } },
				{
					runs: {
						some: {
							OR: [
								{ previousProviderEncodingIds: { isEmpty: false } },
								...logSources,
							],
						},
					},
				},
				{ effectClaims: { some: claimActions } },
			],
		},
		select: {
			id: true,
			name: true,
			status: true,
			createdAt: true,
			error: true,
			stepLog: true,
			bitmovinEncodingId: true,
			bitmovinAccountId: true,
			plan: true,
			runs: {
				orderBy: { seq: "desc" },
				select: {
					id: true,
					status: true,
					createdAt: true,
					stepLog: true,
					bitmovinEncodingId: true,
					previousProviderEncodingIds: true,
					archivedRtmpAttempt: true,
					rtmpRetirementEvidence: true,
				},
			},
			effectClaims: {
				where: claimActions,
				select: {
					liveChannelRunId: true,
					action: true,
					providerEncodingId: true,
					stopSendEncodingIds: true,
					stopOutcomeEvidence: true,
					stopProtocolVersion: true,
					failure: true,
				},
			},
		},
	});
	const allPointers: EncoderPointer[] = [];
	const pointers: EncoderPointer[] = [];
	const incomplete = new Map<
		string,
		{ id: string; name: string; status: string }
	>();
	const empty = { stepLog: [], bitmovinEncodingId: null };
	for (const channel of channels) {
		const accountId = liveChannelAccountId(channel);
		const claimsByRun = new Map<string, typeof channel.effectClaims>();
		for (const claim of channel.effectClaims) {
			const history = claimsByRun.get(claim.liveChannelRunId) ?? [];
			history.push(claim);
			claimsByRun.set(claim.liveChannelRunId, history);
		}
		function record(
			run: (typeof channel.runs)[number] | null,
			history: typeof channel.effectClaims,
			latest: boolean,
		) {
			const projection = latest ? channel : empty;
			const owner = run ?? empty;
			const targets = collectLiveStopTargets(
				owner,
				projection,
				history,
				accountId,
			);
			if (
				!targets.complete ||
				unconfirmedRtmpEncoders(owner, projection, accountId) === null
			)
				incomplete.set(channel.id, {
					id: channel.id,
					name: channel.name,
					status: channel.status,
				});
			const secondary = new Set([
				...(run?.previousProviderEncodingIds ?? []),
				...targets.encodingIds.filter(
					(id) =>
						id !== owner.bitmovinEncodingId &&
						id !== projection.bitmovinEncodingId,
				),
			]);
			const retired = new Set(
				mergeRtmpRetirementEvidence(run?.rtmpRetirementEvidence, [])
					.filter((r) => r.accountId === accountId)
					.map((r) => r.encodingId),
			);
			for (const encodingId of secondary) {
				const pointer: EncoderPointer = {
					kind: run ? "liveChannelRun" : "liveChannel",
					archivedRtmp: true,
					id: run?.id ?? channel.id,
					liveChannelId: channel.id,
					liveChannelCreatedAt: channel.createdAt,
					createdAt: run?.createdAt ?? channel.createdAt,
					name: channel.name,
					status: run?.status ?? channel.status,
					bitmovinEncodingId: encodingId,
					bitmovinAccountId: accountId,
				};
				allPointers.push(pointer);
				if (!retired.has(encodingId)) pointers.push(pointer);
			}
		}
		for (const [index, run] of channel.runs.entries()) {
			record(run, claimsByRun.get(run.id) ?? [], index === 0);
			claimsByRun.delete(run.id);
		}
		// A claim can outlive its logical run. Preserve its surviving targets on the channel.
		if (!channel.runs.length || claimsByRun.size)
			record(null, [...claimsByRun.values()].flat(), !channel.runs.length);
	}
	return { allPointers, pointers, incomplete: [...incomplete.values()] };
}

/** Append an exact terminal read to the run archive without transferring it to the current pointer. */
export async function confirmArchivedRtmpEncoding(
	prisma: AppPrismaClient,
	pointer: EncoderPointer,
	status: string,
) {
	const accountId = pointer.bitmovinAccountId;
	if (
		!accountId ||
		!pointer.liveChannelId ||
		pointer.kind !== "liveChannelRun" ||
		classifyProviderStatusWord(status) !== "TERMINAL"
	)
		return false;
	return prisma.$transaction(async (tx) => {
		await tx.$queryRaw`SELECT id FROM "LiveChannel" WHERE id = ${pointer.liveChannelId}::uuid FOR UPDATE`;
		await tx.$queryRaw`SELECT id FROM "LiveChannelRun" WHERE id = ${pointer.id}::uuid FOR UPDATE`;
		const run = await tx.liveChannelRun.findFirst({
			where: {
				id: pointer.id,
				liveChannelId: pointer.liveChannelId,
				createdAt: pointer.createdAt,
				status: pointer.status as Prisma.LiveChannelRunWhereInput["status"],
			},
			select: {
				rtmpRetirementEvidence: true,
				liveChannel: { select: { bitmovinAccountId: true, plan: true } },
			},
		});
		if (!run || liveChannelAccountId(run.liveChannel) !== accountId)
			return false;
		const archive = await readResetRtmpArchives(tx, pointer.liveChannelId);
		if (
			!archive.pointers.some(
				(candidate) =>
					candidate.id === pointer.id &&
					candidate.bitmovinEncodingId === pointer.bitmovinEncodingId &&
					candidate.bitmovinAccountId === accountId,
			)
		)
			return false;
		await tx.liveChannelRun.update({
			where: { id: pointer.id },
			data: {
				rtmpRetirementEvidence: mergeRtmpRetirementEvidence(
					run.rtmpRetirementEvidence,
					[
						{
							accountId,
							encodingId: pointer.bitmovinEncodingId,
							disposition: "TERMINAL",
							providerStatus: status,
							observedAt: new Date().toISOString(),
						},
					],
				),
			},
		});
		return true;
	});
}
