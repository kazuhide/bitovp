import {
	inspectSavedPlanCompatibility,
	liveChannelPlanSchema,
	validateLiveChannel,
} from "@bitovp/core";
import type { AppPrismaClient } from "./client";

/** Administrator-only, read-only inventory used before replacing DB writers. */
export async function readUpgradePreflight(prisma: AppPrismaClient) {
	return prisma.$transaction(
		async (tx) => {
			await tx.$executeRaw`SET TRANSACTION READ ONLY`;
			const [role] = await tx.$queryRaw<{ allTenants: boolean }[]>`
			SELECT rolsuper OR rolbypassrls AS "allTenants"
			FROM pg_roles WHERE rolname = current_user`;
			if (!role?.allTenants)
				throw new Error(
					"Upgrade preflight requires an administrator that can inspect every organization.",
				);
			const affected = [];
			let checked = 0;
			let cursor: string | undefined;
			for (;;) {
				const rows = await tx.preset.findMany({
					where: { kind: { in: ["FULL_PLAN", "LIVE_PLAN"] } },
					orderBy: { id: "asc" },
					take: 100,
					...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
					select: {
						id: true,
						organizationId: true,
						kind: true,
						revision: true,
						body: true,
						watchRules: { select: { id: true, enabled: true } },
					},
				});
				for (const row of rows) {
					checked++;
					const live =
						row.kind === "LIVE_PLAN"
							? liveChannelPlanSchema.safeParse(row.body)
							: undefined;
					const result = live
						? live.success
							? {
									issues: validateLiveChannel(live.data).map(
										({ code, level, path }) => ({
											code,
											level,
											...(path ? { path } : {}),
										}),
									),
									action: "OPEN_TEMPLATE_AND_RESAVE",
								}
							: {
									issues: [{ code: "PLAN_PARSE", level: "error" as const }],
									action: "OPEN_TEMPLATE_AND_RESAVE",
								}
						: inspectSavedPlanCompatibility(row.body);
					if (!result.issues.length) continue;
					affected.push({
						presetId: row.id,
						organizationId: row.organizationId,
						kind: row.kind,
						revision: row.revision,
						blocking: result.issues.some((issue) => issue.level === "error"),
						issueCount: result.issues.length,
						issues: result.issues.slice(0, 20),
						action: result.action,
						watchRules: row.watchRules,
					});
				}
				if (rows.length < 100) break;
				cursor = rows.at(-1)?.id;
			}
			return {
				formatVersion: 1,
				checkedTemplates: checked,
				blockingTemplates: affected.filter((row) => row.blocking).length,
				affected,
				boundary:
					"Plan structure and current delivery commitments only; provider access, credentials and deployment capabilities require separate checks.",
			};
		},
		{ isolationLevel: "RepeatableRead", timeout: 60_000 },
	);
}
