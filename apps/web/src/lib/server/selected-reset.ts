import "server-only";
import {
	cipherFromEnv,
	type SecretCipher,
	USAGE_BACKFILL_SETTING_PREFIX,
} from "@bitovp/core";
import type { AppPrismaClient, AppTransactionClient } from "@bitovp/db";
import {
	RESET_CATALOG,
	RESET_PROTECTED_EDITING_MODELS,
	type ResetCategory,
	type ResetTable,
	requiredResetCategories,
} from "@/lib/reset-selection";
import {
	assertNoJobEvidenceReferences,
	countJobEvidenceReferences,
	isForeignKeyViolation,
} from "./job-evidence-retention";
import { collectEncoderPointers, type ResetOutcome } from "./reset";
import { snapshotResetCleanup } from "./reset-cleanup-snapshot";

type ResetClient = AppPrismaClient | AppTransactionClient;
type Count = {
	category: ResetCategory;
	count: number;
	protectedCount?: number;
};
const protectedEditingModels = new Set<string>(RESET_PROTECTED_EDITING_MODELS);

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

export class SelectedResetLibraryEditingBlocked extends Error {
	readonly code = "RESET_LIBRARY_EDITING_REFERENCES";
	constructor(public readonly protectedCount: number) {
		super(
			"Library editing history must be retained; reset cannot delete its referenced Library data or credentials",
		);
	}
}

async function countProtectedEditing(prisma: ResetClient): Promise<number> {
	return (
		await Promise.all(
			RESET_PROTECTED_EDITING_MODELS.map((model) =>
				delegate(prisma, model).count({}),
			),
		)
	).reduce((sum, count) => sum + count, 0);
}

/** All choices are counted, including choices currently left unchecked. */
export async function countResetCategories(
	prisma: ResetClient,
): Promise<Count[]> {
	return Promise.all(
		RESET_CATALOG.map(async (entry) => {
			const counts = await Promise.all(
				entry.models.map((model) =>
					delegate(prisma, model)
						.count(
							model === "vmafComputeCredential"
								? { where: { disabledAt: null } }
								: model === "vmafExecutionProfile"
									? { where: { resetAt: null } }
									: "where" in entry
										? { where: entry.where }
										: {},
						)
						.then((count) => ({ model, count })),
				),
			);
			const protectedCount =
				entry.category === "vodJobs"
					? await countJobEvidenceReferences(prisma)
					: counts
							.filter(({ model }) => protectedEditingModels.has(model))
							.reduce((sum, row) => sum + row.count, 0);
			return {
				category: entry.category,
				count: counts.reduce((sum, row) => sum + row.count, 0),
				...(protectedCount > 0 ? { protectedCount } : {}),
			};
		}),
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
	if (selected.has("vodJobs")) await assertNoJobEvidenceReferences(prisma);
	for (let attempt = 0; ; attempt++) {
		try {
			return await prisma.$transaction(
				async (tx) => {
					const clearsUsage =
						selected.has("usageStatistics") ||
						selected.has("bitmovinAccounts") ||
						selected.has("applicationSettings");
					if (clearsUsage) {
						await tx.$queryRaw`SELECT id FROM "BitmovinAccount" ORDER BY id FOR UPDATE`;
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
						const protectedCount = await countProtectedEditing(tx);
						if (protectedCount > 0)
							throw new SelectedResetLibraryEditingBlocked(protectedCount);
					}
					if (selected.has("vodJobs")) await assertNoJobEvidenceReferences(tx);
					if (clearsUsage) {
						await tx.appSetting.deleteMany({
							where: { key: { startsWith: USAGE_BACKFILL_SETTING_PREFIX } },
						});
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
							// Guarded empty above; these immutable dependency chains are never reset-deleted.
							if (protectedEditingModels.has(model)) continue;
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
			if (selected.has("vodJobs") && isForeignKeyViolation(error))
				await assertNoJobEvidenceReferences(prisma);
			const conflict = error as { code?: string; meta?: { code?: string } };
			if (
				selected.has("contentLibrary") &&
				(conflict.code === "P2003" ||
					(conflict.code === "P2010" && conflict.meta?.code === "23503"))
			) {
				const protectedCount = await countProtectedEditing(prisma);
				if (protectedCount > 0)
					throw new SelectedResetLibraryEditingBlocked(protectedCount);
			}
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
