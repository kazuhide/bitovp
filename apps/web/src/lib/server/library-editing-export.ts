import "server-only";
import type { AppTransactionClient, Prisma } from "@bitovp/db";
import { EditingRequestError } from "./library-editing-common";

export const exportRuns = {
	profile: { path: ["kind"], equals: "EXPORT" },
	generation: { gt: 0 },
} satisfies Prisma.RenderRunWhereInput;

export const successfulExport = {
	...exportRuns,
	state: "SUCCEEDED",
	artifact: { isNot: null },
} satisfies Prisma.RenderRunWhereInput;

export async function readExportRun(
	tx: Pick<AppTransactionClient, "renderRun">,
	organizationId: string,
	projectId: string,
	exportId: string,
) {
	const run = await tx.renderRun.findFirst({
		where: {
			id: exportId,
			projectId,
			organizationId,
			...successfulExport,
			project: { organizationId },
			revision: { projectId, organizationId },
			artifact: { is: { organizationId } },
		},
		select: {
			id: true,
			revisionId: true,
			generation: true,
			revision: { select: { document: true } },
			project: {
				select: {
					contentId: true,
					mediaVersionId: true,
					variant: true,
					title: true,
					draft: true,
					currentRevisionId: true,
				},
			},
			artifact: {
				select: {
					id: true,
					activeDerivations: {
						where: { organizationId, projectId },
						select: { derivedContentId: true },
						take: 1,
					},
				},
			},
		},
	});
	if (!run?.artifact) throw new EditingRequestError(404, "EDIT_NOT_FOUND");
	return { ...run, artifact: run.artifact };
}
