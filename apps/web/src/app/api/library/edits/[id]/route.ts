import { z } from "zod";
import { getServerContext } from "@/lib/server/context";
import { invalidIdResponse } from "@/lib/server/http";
import { editingRoute } from "@/lib/server/library-editing-common";
import { readEditingProject } from "@/lib/server/library-editing-projects";
import { readStoredEditingExport } from "@/lib/server/library-hierarchy";
export async function GET(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { id } = await params;
	return (
		invalidIdResponse(id) ??
		editingRoute(
			async () => {
				const [exportId] = z
					.array(z.uuid())
					.max(1)
					.parse(new URL(req.url).searchParams.getAll("exportId"));
				return exportId
					? readStoredEditingExport(await getServerContext(), id, exportId)
					: readEditingProject(id);
			},
			200,
			{ allowUnavailable: "ARTIFACT_READ" },
		)
	);
}
