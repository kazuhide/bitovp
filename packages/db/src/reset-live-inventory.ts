import { aisaLiveNeverStarted, stepLogSchema } from "@bitovp/core";
import type { AppPrismaClient, AppTransactionClient } from "./client";
import {
	collectLiveStopTargets,
	divergentLivePrimaries,
	liveChannelAccountId,
	unconfirmedRtmpEncoders,
	unresolvedOrphanLiveClaimTargets,
	validLiveRetirementReceipts,
} from "./live-effect-claim";

type ResetLivePointer = {
	kind: "liveChannel" | "liveChannelRun";
	archivedRtmp: true;
	id: string;
	liveChannelId: string;
	liveChannelCreatedAt: Date;
	createdAt: Date;
	name: string;
	status: string;
	bitmovinEncodingId: string;
	bitmovinAccountId: string | null;
};

const ownershipLogKinds = [
	"CREATE_INPUT_RTMP",
	"START_LIVE_ENCODING",
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

	const channels = await prisma.liveChannel.findMany({
		where: {
			...(channelId ? { id: channelId } : {}),
			OR: [
				...logSources,
				{ bitmovinEncodingId: { not: null } },
				{ error: { startsWith: "stop did not confirm — " } },
				{
					runs: {
						some: {
							OR: [
								{ previousProviderEncodingIds: { isEmpty: false } },
								{ bitmovinEncodingId: { not: null } },
								...logSources,
							],
						},
					},
				},
				{ effectClaims: { some: {} } },
			],
		},
		select: {
			id: true,
			name: true,
			status: true,
			createdAt: true,
			error: true,
			stepLog: true,
			provisionClaimedAt: true,
			resetOrphanEncoderEvidence: true,
			encoderStoppedConfirmedFor: true,
			bitmovinEncodingId: true,
			bitmovinAccountId: true,
			plan: true,
			runs: {
				orderBy: { seq: "desc" },
				select: {
					id: true,
					status: true,
					error: true,
					createdAt: true,
					stepLog: true,
					bitmovinEncodingId: true,
					previousProviderEncodingIds: true,
					archivedRtmpAttempt: true,
					rtmpRetirementEvidence: true,
					encoderStoppedConfirmedFor: true,
					aisaAnalysisId: true,
					aisaFinalization: true,
					aisaStatus: true,
					providerStatus: true,
				},
			},
			effectClaims: {
				select: {
					liveChannelRunId: true,
					action: true,
					providerEncodingId: true,
					stopSendEncodingIds: true,
					legacyUnsentStopIds: true,
					stopOutcomeEvidence: true,
					stopProtocolVersion: true,
					failure: true,
				},
			},
		},
	});
	const allPointers: ResetLivePointer[] = [];
	const ownedIds = new Set<string>();
	const ownedProviderKeys = new Set<string>();
	const neverStarted = new Set<string>();
	const incompleteAccounts = new Set<string | null>();
	const pointers: ResetLivePointer[] = [];
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
			for (const id of [
				...targets.encodingIds,
				...(run?.previousProviderEncodingIds ?? []),
			]) {
				ownedIds.add(id);
				ownedProviderKeys.add(JSON.stringify([accountId, id]));
			}
			if (
				!targets.complete ||
				unconfirmedRtmpEncoders(owner, projection, accountId) === null
			) {
				incompleteAccounts.add(accountId);
				incomplete.set(channel.id, {
					id: channel.id,
					name: channel.name,
					status: channel.status,
				});
			}
			const secondary = new Set([
				...(run?.previousProviderEncodingIds ?? []),
				...targets.encodingIds.filter(
					(id) =>
						id !== owner.bitmovinEncodingId &&
						id !== projection.bitmovinEncodingId,
				),
			]);
			// A STOPPED row only describes its own primary. A mismatch between mirrors
			// must be resolved against both upstream identities before either is erased.
			const divergent = divergentLivePrimaries(owner, projection);
			for (const id of divergent) secondary.add(id);
			// A discarded logical run has no independent NEVER_STARTED journal. The same
			// terminal-only orphan inventory also governs a successor's admission.
			const orphan = run
				? []
				: unresolvedOrphanLiveClaimTargets(
						history,
						channel.resetOrphanEncoderEvidence,
						accountId,
					);
			if (!run)
				for (const id of orphan ?? targets.encodingIds) secondary.add(id);
			const aisaOwner = latest ? channel : run;
			if (
				run?.bitmovinEncodingId &&
				aisaOwner &&
				accountId &&
				aisaLiveNeverStarted(run, aisaOwner) &&
				!channel.provisionClaimedAt &&
				!history.some(
					(c) =>
						c.action === "RESTART" &&
						c.providerEncodingId === run.bitmovinEncodingId,
				)
			) {
				neverStarted.add(
					JSON.stringify([
						"liveChannelRun",
						run.id,
						accountId,
						run.bitmovinEncodingId,
					]),
				);
				if (latest)
					neverStarted.add(
						JSON.stringify([
							"liveChannel",
							channel.id,
							accountId,
							run.bitmovinEncodingId,
						]),
					);
			}
			const uncertainStarts = new Set<string>();
			const logs = [owner.stepLog, projection.stepLog].map((log) =>
				stepLogSchema.safeParse(log),
			);
			const entries = logs.flatMap((result) =>
				result.success ? result.data : [],
			);
			const starts = entries.filter(
				(entry) => entry.kind === "START_LIVE_ENCODING",
			);
			for (const id of new Set([
				owner.bitmovinEncodingId,
				projection.bitmovinEncodingId,
			])) {
				if (!id || !accountId || !starts.length) continue;
				const created = entries.filter(
					(entry) =>
						entry.kind === "CREATE_ENCODING" &&
						entry.status === "DONE" &&
						entry.resourceId === id,
				);
				const unsent =
					created.length > 0 &&
					logs.every((result) => result.success) &&
					targets.complete &&
					starts.every(
						(start) =>
							start.status === "PENDING" &&
							!start.startedAt &&
							!start.finishedAt &&
							!start.error &&
							!start.request &&
							!start.response &&
							created.every(
								(create) =>
									start.refs.encodingId === create.step &&
									(create.attempt ?? 0) === (start.attempt ?? 0),
							),
					);
				if (
					unsent &&
					!channel.provisionClaimedAt &&
					!history.length &&
					(!latest ||
						["ERROR", "STOPPED", "CREATED"].includes(channel.status)) &&
					(!run || ["ERROR", "STOPPED", "CREATED"].includes(run.status))
				) {
					if (run?.bitmovinEncodingId === id)
						neverStarted.add(
							JSON.stringify(["liveChannelRun", run.id, accountId, id]),
						);
					if (latest && channel.bitmovinEncodingId === id)
						neverStarted.add(
							JSON.stringify(["liveChannel", channel.id, accountId, id]),
						);
				}
				// Older reset versions accepted CREATED even after an inconclusive START.
				// A late START is possible until a terminal receipt covers this exact encoder.
				if (
					starts.some(
						(e) =>
							e.status === "RUNNING" ||
							e.status === "FAILED" ||
							e.status === "DONE",
					) &&
					(run?.status === "ERROR" ||
						run?.error ||
						(latest && (channel.status === "ERROR" || channel.error)))
				) {
					secondary.add(id);
					uncertainStarts.add(id);
				}
			}
			const retired = new Set<string>();
			for (const receipt of validLiveRetirementReceipts(
				run ?? { rtmpRetirementEvidence: channel.resetOrphanEncoderEvidence },
				history,
				accountId,
			)) {
				if (receipt.disposition === "NEVER_STARTED") {
					if (
						uncertainStarts.has(receipt.encodingId) ||
						divergent.includes(receipt.encodingId)
					)
						continue;
					if (run?.previousProviderEncodingIds.includes(receipt.encodingId))
						neverStarted.add(
							JSON.stringify([
								"liveChannelRun",
								run.id,
								accountId,
								receipt.encodingId,
							]),
						);
				}
				retired.add(receipt.encodingId);
			}
			for (const encodingId of secondary) {
				const pointer: ResetLivePointer = {
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
	return {
		ownedIds,
		ownedProviderKeys,
		allPointers,
		pointers,
		neverStarted,
		incompleteAccounts,
		incomplete: [...incomplete.values()],
	};
}
