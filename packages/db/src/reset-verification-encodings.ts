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
	cleanupAccounts?: readonly { id: string; tenantOrgId: string | null }[],
) {
	const rows = raw.flatMap((r) => {
		const parsed = parseIntent(r);
		return parsed ? [parsed] : [];
	});
	const protectedWorkKeys = new Set<string>();
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
						plan: true,
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
	const ownedEncodings =
		retainedArchive?.ownedEncodings ?? new Map<string, Set<string | null>>();
	const retained = [
		...jobs.map((row) => ({
			...row,
			bitmovinAccountId: liveChannelAccountId(row),
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
	for (const owner of retained) {
		for (const id of [
			owner.bitmovinEncodingId,
			...stepEncodingIds(owner.stepLog),
			...owner.previousProviderEncodingIds,
		]) {
			if (!id) continue;
			const owners = ownedEncodings.get(id) ?? new Set<string | null>();
			owners.add(owner.bitmovinAccountId);
			ownedEncodings.set(id, owners);
		}
	}
	// A local account ID identifies a credential record, not a provider tenant.
	// Only two explicit, different provider organization headers prove disjoint scope.
	const accounts = ownedEncodings.size
		? await tx.bitmovinAccount.findMany({
				select: { id: true, tenantOrgId: true },
			})
		: [];
	const currentScope = new Map(
		accounts.map((account) => [account.id, account.tenantOrgId]),
	);
	const cleanupScope = cleanupAccounts
		? new Map(
				cleanupAccounts.map((account) => [account.id, account.tenantOrgId]),
			)
		: currentScope;
	const owned = (accountId: string | null, encodingId: string) => {
		const scope = accountId && cleanupScope.get(accountId);
		for (const owner of ownedEncodings.get(encodingId) ?? []) {
			const ownerScope = owner && currentScope.get(owner);
			if (owner === accountId || !scope || !ownerScope || scope === ownerScope)
				return true;
		}
		return false;
	};
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
		const localOwner = retained.some(
			(row) =>
				row.kind === intent.kind &&
				(localIds.has(row.id) ||
					row.verificationKey === intent.verificationKey),
		);
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
			if (localOwner || owned(accountId, encodingId)) {
				protectedWorkKeys.add(
					JSON.stringify([entityKey, accountId, encodingId]),
				);
				continue;
			}
			candidates.push({
				entityKey,
				accountId,
				encodingId,
				verificationOwnerCheck: true,
			});
		}
	}
	return {
		candidates,
		archive: retainedArchive,
		protectedWorkKeys,
		owned,
	};
}
