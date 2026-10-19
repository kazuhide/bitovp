import "server-only";
import {
	cipherFromEnv,
	type SecretCipher,
	USAGE_BACKFILL_SETTING_PREFIX,
} from "@bitovp/core";
import type { AppPrismaClient, AppTransactionClient } from "@bitovp/db";
import {
	RESET_CATALOG,
	type ResetCategory,
	type ResetTable,
	requiredResetCategories,
} from "@/lib/reset-selection";
import { collectEncoderPointers, type ResetOutcome } from "./reset";
import { snapshotResetCleanup } from "./reset-cleanup-snapshot";

type ResetClient = AppPrismaClient | AppTransactionClient;
type Count = { category: ResetCategory; count: number };

function delegate(prisma: ResetClient, model: ResetTable) {
	return prisma[model] as unknown as {
		count(args?: unknown): Promise<number>;
		deleteMany(args?: unknown): Promise<{ count: number }>;
		updateMany(args?: unknown): Promise<{ count: number }>;
	};
}

export class SelectedResetBlocked extends Error {
	constructor() {
		super("Reset selection is missing required categories");
	}
}

/** All choices are counted, including choices currently left unchecked. */
export async function countResetCategories(
	prisma: ResetClient,
): Promise<Count[]> {
	return Promise.all(
		RESET_CATALOG.map(async (entry) => ({
			category: entry.category,
			count: (
				await Promise.all(
					entry.models.map((model) =>
						delegate(prisma, model).count(
							model === "vmafComputeCredential"
								? { where: { disabledAt: null } }
								: model === "vmafExecutionProfile"
									? { where: { resetAt: null } }
									: "where" in entry
										? { where: entry.where }
										: {},
						),
					),
				)
			).reduce((sum, count) => sum + count, 0),
		})),
	);
}

export type SelectedResetOutcome = Omit<ResetOutcome, "counts"> & {
	counts: Record<string, number>;
	deletedCounts: Count[];
	requiresSetup: false;
	cleanupTaskId: string | null;
};

export async function deleteSelectedData(
	prisma: AppPrismaClient,
	categories: readonly ResetCategory[],
	cipher: SecretCipher = {
		encrypt: (value, aad) => cipherFromEnv().encrypt(value, aad),
		decrypt: (value, aad) => cipherFromEnv().decrypt(value, aad),
	},
): Promise<SelectedResetOutcome> {
	const selected = new Set(categories);
	if (
		!selected.size ||
		requiredResetCategories(categories).some(
			(category) => !selected.has(category),
		)
	) {
		throw new SelectedResetBlocked();
	}
	for (let attempt = 0; ; attempt++) {
		try {
			return await prisma.$transaction(
				async (tx) => {
					if (
						selected.has("usageStatistics") ||
						selected.has("bitmovinAccounts") ||
						selected.has("applicationSettings")
					) {
						await tx.$queryRaw`SELECT id FROM "BitmovinAccount" ORDER BY id FOR UPDATE`;
						await tx.appSetting.deleteMany({
							where: { key: { startsWith: USAGE_BACKFILL_SETTING_PREFIX } },
						});
					}
					// Same lock order as capture: job, then source. A late capture cannot
					// resurrect erased library data from retained FINISHED history.
					await tx.$queryRaw`SELECT id FROM "EncodingJob" ORDER BY id FOR UPDATE`;
					if (selected.has("liveChannels")) {
						// Snapshot ownership and delete children under the same channel-first
						// order as owned finalizers, including delayed provider responses.
						await tx.$queryRaw`SELECT id FROM "LiveChannel" ORDER BY id FOR UPDATE`;
					}
					if (selected.has("contentLibrary")) {
						await tx.$queryRaw`SELECT id FROM "LibrarySource" ORDER BY id FOR UPDATE`;
					}
					if (
						selected.has("webhookRegistrations") ||
						selected.has("applicationSettings")
					) {
						await tx.$queryRaw`SELECT id FROM "WebhookRegistration" ORDER BY id FOR UPDATE`;
					}
					const cleanupTaskId = await snapshotResetCleanup(
						tx,
						selected,
						cipher,
					);
					const encoders = await collectEncoderPointers(
						tx as unknown as AppPrismaClient,
						{
							vodJobs: selected.has("vodJobs"),
							liveChannels: selected.has("liveChannels"),
						},
					);
					if (selected.has("contentLibrary") && !selected.has("vodJobs")) {
						await tx.encodingJob.updateMany({
							where: {},
							data: { libraryCaptureSuppressed: true },
						});
					}
					const disarmed =
						selected.has("watchFolderHistory") && !selected.has("watchFolders")
							? await tx.watchRule.findMany({
									where: { enabled: true },
									select: { id: true, name: true },
								})
							: [];
					const counts: Record<string, number> = {};
					if (
						selected.has("watchFolderHistory") &&
						!selected.has("watchFolders")
					) {
						counts.watchRuleDisarmed = (
							await tx.watchRule.updateMany({
								where: { enabled: true },
								data: {
									enabled: false,
									scanCursor: null,
									disarmedByResetAt: new Date(),
								},
							})
						).count;
					}
					const deletedCounts: Count[] = [];
					for (const entry of RESET_CATALOG) {
						if (!selected.has(entry.category)) continue;
						let count = 0;
						for (const model of entry.models) {
							// Erase the selectable credential immediately; immutable material
							// remains private so task snapshots can still tear down cloud resources.
							const deleted =
								model === "vmafComputeCredential"
									? await delegate(tx, model).updateMany({
											where: { disabledAt: null },
											data: { disabledAt: new Date() },
										})
									: model === "vmafExecutionProfile"
										? await delegate(tx, model).updateMany({
												where: { resetAt: null },
												data: {
													enabled: false,
													resetAt: new Date(),
													version: { increment: 1 },
												},
											})
										: await delegate(tx, model).deleteMany(
												"where" in entry ? { where: entry.where } : {},
											);
							// Disjoint halves of alertRule must retain separate audit counts.
							counts[model === "alertRule" ? entry.category : model] =
								deleted.count;
							count += deleted.count;
						}
						deletedCounts.push({ category: entry.category, count });
					}
					return {
						counts,
						cleanupTaskId,
						disarmed,
						encoders,
						deletedCounts,
						requiresSetup: false,
					};
				},
				{ isolationLevel: "Serializable", timeout: 120_000, maxWait: 10_000 },
			);
		} catch (error) {
			const conflict = error as { code?: string; meta?: { code?: string } };
			if (
				attempt >= 5 ||
				!(
					conflict.code === "P2034" ||
					(conflict.code === "P2010" &&
						["40001", "40P01"].includes(conflict.meta?.code ?? ""))
				)
			)
				throw error;
		}
	}
}
