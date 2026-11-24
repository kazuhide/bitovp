import type { Prisma } from "../generated/client";
import type { AppPrismaClient, AppTransactionClient } from "./client";
import { liveChannelAccountId } from "./live-effect-claim";
import type { ResetCleanupEncoding } from "./reset-cleanup";
import { readResetRtmpArchives } from "./reset-live-inventory";

// The encrypted v1 payload may predate the explicit deferred worklist. Rehydrate
// only full native intent rows carrying their original verification account.
function object(v: unknown): Record<string, unknown> | undefined {
	return typeof v === "object" && v !== null && !Array.isArray(v)
		? (v as Record<string, unknown>)
		: undefined;
}
function parseIntent(value: unknown) {
	const v = object(value),
		accountId = object(v?.verificationRun)?.bitmovinAccountId;
	if (
		!v ||
		typeof v.id !== "string" ||
		typeof v.verificationKey !== "string" ||
		typeof accountId !== "string" ||
		(v.kind !== "VOD_JOB" && v.kind !== "LIVE_CHANNEL") ||
		!Array.isArray(v.providerIds) ||
		!v.providerIds.every((id): id is string => typeof id === "string") ||
		(v.localId != null && typeof v.localId !== "string") ||
		(v.providerId != null && typeof v.providerId !== "string")
	)
		return;
	const keys = v.possiblyCreatedKeys ?? [];
	if (
		!Array.isArray(keys) ||
		!keys.every((k): k is string => typeof k === "string")
	)
		return;
	return {
		id: v.id,
		kind: v.kind,
		providerIds: v.providerIds,
		verificationKey: v.verificationKey,
		localId: v.localId,
		providerId: v.providerId,
		possiblyCreatedKeys: keys,
		verificationRun: { bitmovinAccountId: accountId },
	};
}
export async function readVerificationCleanupWork(
	tx: AppPrismaClient | AppTransactionClient,
	raw: readonly unknown[],
	removed = { vod: false, live: false },
) {
	const rows = raw.flatMap((r) => {
		const parsed = parseIntent(r);
		return parsed ? [parsed] : [];
	});
	if (!rows.length)
		return { candidates: [] as ResetCleanupEncoding[], archive: null };
	const candidates: ResetCleanupEncoding[] = [];
	// An intent can learn provider IDs before local adoption. Protect retained
	// owners by canonical local key, verification key, and exact encoder refs.
	const [jobs, channels, runsWithOwners] = await Promise.all([
		removed.vod
			? []
			: tx.encodingJob.findMany({
					select: {
						id: true,
						verificationKey: true,
						bitmovinEncodingId: true,
						bitmovinAccountId: true,
						stepLog: true,
					},
				}),
		removed.live
			? []
			: tx.liveChannel.findMany({
					select: {
						id: true,
						verificationKey: true,
						bitmovinEncodingId: true,
						bitmovinAccountId: true,
						stepLog: true,
						plan: true,
					},
				}),
		removed.live
			? []
			: tx.liveChannelRun.findMany({
					select: {
						id: true,
						bitmovinEncodingId: true,
						stepLog: true,
						previousProviderEncodingIds: true,
						liveChannel: { select: { bitmovinAccountId: true, plan: true } },
					},
				}),
	]);
	const retainedArchive = removed.live ? null : await readResetRtmpArchives(tx);
	const retainedIds = retainedArchive?.ownedIds;
	const retained = [
		...jobs.map((row) => ({
			...row,
			previousProviderEncodingIds: [] as string[],
			kind: "VOD_JOB",
		})),
		...channels.map((row) => ({
			...row,
			bitmovinAccountId: liveChannelAccountId(row),
			previousProviderEncodingIds: [] as string[],
			kind: "LIVE_CHANNEL",
		})),
		...runsWithOwners.map((row) => ({
			...row,
			kind: "LIVE_RUN",
			verificationKey: null,
			bitmovinAccountId: liveChannelAccountId(row.liveChannel),
		})),
	];
	const stepEncodingIds = (stepLog: Prisma.JsonValue | undefined) =>
		Array.isArray(stepLog)
			? stepLog.flatMap((step) =>
					step &&
					typeof step === "object" &&
					!Array.isArray(step) &&
					step.kind === "CREATE_ENCODING" &&
					typeof step.resourceId === "string"
						? [step.resourceId]
						: [],
				)
			: [];
	for (const intent of rows) {
		const accountId = intent.verificationRun.bitmovinAccountId;
		if (!accountId) continue;
		const kind =
			intent.kind === "VOD_JOB"
				? "encodingJob"
				: intent.kind === "LIVE_CHANNEL"
					? "liveChannel"
					: null;
		if (!kind) continue;
		const localPrefix = `local:${intent.kind}:`;
		const localIds = new Set([
			...(intent.localId ? [intent.localId] : []),
			...(intent.possiblyCreatedKeys ?? [])
				.filter(
					(key) =>
						key.startsWith(localPrefix) && key.length > localPrefix.length,
				)
				.map((key) => key.slice(localPrefix.length)),
		]);
		if (
			retained.some(
				(row) =>
					row.kind === intent.kind &&
					(localIds.has(row.id) ||
						(typeof intent.verificationKey === "string" &&
							row.verificationKey === intent.verificationKey)),
			)
		)
			continue;
		const providerPrefix = "provider:BITMOVIN_ENCODING:";
		const providerIds = new Set([
			...intent.providerIds,
			...(intent.providerId ? [intent.providerId] : []),
			...(intent.possiblyCreatedKeys ?? [])
				.filter(
					(key) =>
						key.startsWith(providerPrefix) &&
						key.length > providerPrefix.length,
				)
				.map((key) => key.slice(providerPrefix.length)),
		]);
		const localId =
			intent.localId ?? (localIds.size === 1 ? [...localIds][0] : undefined);
		const entityKey = `${kind}:${localId ?? `verification-intent:${intent.id}`}`;
		for (const encodingId of providerIds) {
			if (retainedIds?.has(encodingId)) continue;
			if (
				retained.some(
					(row) =>
						(row.bitmovinAccountId == null ||
							row.bitmovinAccountId === accountId) &&
						(row.bitmovinEncodingId === encodingId ||
							stepEncodingIds(row.stepLog).includes(encodingId) ||
							row.previousProviderEncodingIds.includes(encodingId)),
				)
			)
				continue;
			candidates.push({
				entityKey,
				accountId,
				encodingId,
				verificationOwnerCheck: true,
			});
		}
	}
	return { candidates, archive: retainedArchive };
}
