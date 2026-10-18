import {
	normalizeSlateInputPath,
	redactSecrets,
	type SlateSource,
	slateConversionDestination,
	slateNormalizationTarget,
	slateNormalizeJobSchema,
} from "@bitovp/core";
import type { AppPrismaClient, Prisma } from "@bitovp/db";
import { loadChannelIngestMedia } from "../orchestrator/live-processor";
import type { SdkOps } from "../orchestrator/sdk-ops";
import { createSourceInput } from "../orchestrator/slate-register";
import type { SlatePreparer } from "./prepare";

/**
 * The `SlateNormalization` row's processor and promoter  — the
 * direct route's registration, moved off the request and onto the worker,
 * because it now downloads, transcodes (ffmpeg lives in the worker image)
 * and uploads before it touches the provider.
 *
 * States: QUEUED → NORMALIZING → REGISTERING → READY, with WAITING_FOR_INPUT
 * when a movie has no ingest reference to be matched to yet and ERROR for a
 * refusal. The row is the operator's view; every terminal path writes its
 * reason onto it.
 *
 * Claim = transition-is-the-lock, like the storage inspection: only a
 * QUEUED or WAITING_FOR_INPUT row may start. A NORMALIZING/REGISTERING row
 * whose `updatedAt` is older than `SLATE_NORMALIZE_STALE_CLAIM_MS` is a
 * worker that died mid-flight (BullMQ redelivers, the promoter re-queues);
 * it may be re-claimed, and the adopt-by-marker below makes that a resume,
 * not a duplicate content.
 *
 * The PROMOTER is the repeatable job on the same queue: it re-queues
 * WAITING_FOR_INPUT rows whose channel now has a usable ingest reference
 * (the input has connected since), and stale in-flight rows.
 */

export const SLATE_NORMALIZE_STALE_CLAIM_MS = 15 * 60_000;
export const SLATE_NORMALIZE_PROMOTE_INTERVAL_MS = 30_000;
export const DEFAULT_NORMALIZE_REGISTRATION_TIMEOUT_MS = 10 * 60_000;
/** Rows one promoter tick examines. */
const PROMOTE_BATCH = 50;
/** A channel in one of these will never report an ingest again. */
const TERMINAL_CHANNEL_STATUSES: ReadonlySet<string> = new Set([
	"STOPPED",
	"ERROR",
]);

export type SlateNormalizeDeps = {
	prisma: AppPrismaClient;
	prepare: SlatePreparer;
	revealBitmovinAccount(accountId: string): Promise<{
		apiKey: string;
		tenantOrgId: string | null;
	}>;
	makeSdk(args: {
		apiKey: string;
		tenantOrgId: string | null;
		bitmovinAccountId: string;
	}): SdkOps;
	resolveCredential: Parameters<
		typeof createSourceInput
	>[0]["resolveCredential"];
	now(): Date;
	sleep(ms: number): Promise<void>;
	pollIntervalMs: number;
	registrationTimeoutMs?: number;
};

export type SlateNormalizeResult = {
	acknowledged: true;
	slateNormalizationId: string;
	status: string;
};

/** The adopt key on the provider content's description: one per row. */
export function slateNormalizationMarker(rowId: string): string {
	return `slate-normalization:${rowId}`;
}

export function createSlateNormalizeProcessor(deps: SlateNormalizeDeps) {
	const timeoutMs =
		deps.registrationTimeoutMs ?? DEFAULT_NORMALIZE_REGISTRATION_TIMEOUT_MS;
	return async function process(raw: unknown): Promise<SlateNormalizeResult> {
		const { slateNormalizationId: id } = slateNormalizeJobSchema.parse(raw);
		const done = (status: string): SlateNormalizeResult => ({
			acknowledged: true,
			slateNormalizationId: id,
			status,
		});
		const row = await deps.prisma.slateNormalization.findUnique({
			where: { id },
		});
		if (!row) {
			return done("MISSING");
		}
		const staleBefore = new Date(
			deps.now().getTime() - SLATE_NORMALIZE_STALE_CLAIM_MS,
		);
		const claimed = await deps.prisma.slateNormalization.updateMany({
			where: {
				id,
				OR: [
					{ status: { in: ["QUEUED", "WAITING_FOR_INPUT"] } },
					{
						status: { in: ["NORMALIZING", "REGISTERING"] },
						updatedAt: { lt: staleBefore },
					},
				],
			},
			data: { status: "NORMALIZING", note: "preparing the file", error: null },
		});
		if (claimed.count === 0) {
			return done(row.status);
		}
		const fail = async (error: string) => {
			await deps.prisma.slateNormalization.update({
				where: { id },
				data: { status: "ERROR", error: redactSecrets(error) },
			});
			return done("ERROR");
		};
		try {
			const channel = await deps.prisma.liveChannel.findUnique({
				where: { id: row.liveChannelId },
				select: {
					status: true,
					bitmovinEncodingId: true,
					lastHeartbeat: true,
					plan: true,
				},
			});
			if (channel?.status !== "RUNNING" || !channel.bitmovinEncodingId) {
				return fail(
					`the channel is ${channel?.status ?? "gone"}, so there is no live encoding to register the slate on — register it again once the channel is running`,
				);
			}
			const encodingId = channel.bitmovinEncodingId;
			const source: SlateSource = {
				credentialId: row.credentialId,
				bucket: row.bucket,
				key: row.sourceKey,
			};
			const ingest = await loadChannelIngestMedia(
				deps.prisma,
				row.liveChannelId,
				channel.lastHeartbeat,
			);
			const prepared = await deps.prepare({
				label: id,
				source,
				ingest,
				destination: slateConversionDestination(channel.plan),
				// Each touch refreshes `updatedAt`, which is the claim's lease: a
				// large file in flight must not look stale to the promoter.
				onProgress: async (note) => {
					await deps.prisma.slateNormalization.update({
						where: { id },
						data: { note },
					});
				},
			});
			if (prepared.kind === "WAIT") {
				await deps.prisma.slateNormalization.update({
					where: { id },
					data: { status: "WAITING_FOR_INPUT", note: prepared.note },
				});
				return done("WAITING_FOR_INPUT");
			}
			if (prepared.kind === "REFUSED") {
				return fail(prepared.reason);
			}
			await deps.prisma.slateNormalization.update({
				where: { id },
				data: {
					status: "REGISTERING",
					registeredKey: prepared.source.key,
					registeredBucket:
						prepared.source.bucket === row.bucket
							? null
							: prepared.source.bucket,
					normalized: prepared.normalized,
					target: (prepared.target ?? undefined) as
						| Prisma.InputJsonValue
						| undefined,
					note: prepared.note,
				},
			});

			// Register — adopt first, so a redelivery after a lost response finds
			// the first attempt's content instead of minting a second.
			const account = await deps.revealBitmovinAccount(row.bitmovinAccountId);
			const sdk = deps.makeSdk({
				apiKey: account.apiKey,
				tenantOrgId: account.tenantOrgId,
				bitmovinAccountId: row.bitmovinAccountId,
			});
			const marker = slateNormalizationMarker(id);
			const existing = await sdk.listLiveInsertableContent(encodingId);
			let contentId =
				existing.find((item) => item.description?.includes(marker))?.id ?? null;
			if (contentId === null) {
				const input = await createSourceInput(
					{ resolveCredential: deps.resolveCredential, sdk },
					id,
					prepared.source,
				);
				if (input.inputId === null) {
					return fail(input.reason);
				}
				contentId = await sdk.createLiveInsertableContent(encodingId, {
					name: row.name ?? `slate:${id.slice(0, 8)}`,
					// Marker FIRST: adoption reads it with `includes`, and a provider
					// that truncated a long description would cut the tail.
					description: `${marker}; ${prepared.note}`,
					inputs: [
						{
							inputId: input.inputId,
							inputPath: normalizeSlateInputPath(prepared.source.key).path,
						},
					],
				});
			}
			const startedAt = deps.now().getTime();
			for (;;) {
				const content = await sdk.getLiveInsertableContent(
					encodingId,
					contentId,
				);
				if (content.status === "READY") {
					break;
				}
				if (content.status === "ERROR") {
					return fail(
						`the provider could not download or process the file (${contentId})`,
					);
				}
				if (deps.now().getTime() - startedAt > timeoutMs) {
					return fail(
						`the provider had not marked the content READY after ${Math.round(timeoutMs / 60_000)} minutes (${contentId})`,
					);
				}
				await deps.sleep(deps.pollIntervalMs);
			}
			await deps.prisma.slateNormalization.update({
				where: { id },
				data: { status: "READY", insertableContentId: contentId, error: null },
			});
			return done("READY");
		} catch (err) {
			return fail(
				`registration failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	};
}

export type SlateNormalizePromoterDeps = {
	allowNewWork?: () => Promise<boolean>;
	prisma: AppPrismaClient;
	now(): Date;
	enqueue(slateNormalizationId: string): Promise<void>;
};

/**
 * Re-queue what can move: WAITING_FOR_INPUT rows whose channel now yields a
 * full normalization target, and in-flight rows nobody has touched for a
 * stale-claim window. Oldest first, bounded per tick; a row that still has
 * no reference is left alone (no job, no churn).
 */
export function createSlateNormalizePromoter(deps: SlateNormalizePromoterDeps) {
	return async function promote(): Promise<{ promoted: number }> {
		if (deps.allowNewWork && !(await deps.allowNewWork()))
			return { promoted: 0 };
		const staleBefore = new Date(
			deps.now().getTime() - SLATE_NORMALIZE_STALE_CLAIM_MS,
		);
		const rows = await deps.prisma.slateNormalization.findMany({
			where: {
				OR: [
					{ status: "WAITING_FOR_INPUT" },
					{
						status: { in: ["NORMALIZING", "REGISTERING"] },
						updatedAt: { lt: staleBefore },
					},
				],
			},
			orderBy: { updatedAt: "asc" },
			take: PROMOTE_BATCH,
			select: { id: true, status: true, liveChannelId: true },
		});
		let promoted = 0;
		for (const row of rows) {
			if (row.status === "WAITING_FOR_INPUT") {
				const channel = await deps.prisma.liveChannel.findUnique({
					where: { id: row.liveChannelId },
					select: { status: true, lastHeartbeat: true },
				});
				if (!channel || TERMINAL_CHANNEL_STATUSES.has(channel.status)) {
					// The input will never arrive: hand the row to the processor,
					// whose RUNNING check writes the "channel is STOPPED" error.
					await deps.enqueue(row.id);
					promoted += 1;
					continue;
				}
				if (channel.status !== "RUNNING") {
					continue;
				}
				const ingest = await loadChannelIngestMedia(
					deps.prisma,
					row.liveChannelId,
					channel.lastHeartbeat,
				);
				if (slateNormalizationTarget(ingest).target === null) {
					continue;
				}
			}
			await deps.enqueue(row.id);
			promoted += 1;
		}
		return { promoted };
	};
}
