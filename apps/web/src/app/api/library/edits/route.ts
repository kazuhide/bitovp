import { z } from "zod";
import { getServerContext } from "@/lib/server/context";
import { editingBody, editingRoute } from "@/lib/server/library-editing-common";
import { createEditingProject } from "@/lib/server/library-editing-projects";
import { editingMutation } from "@/lib/server/library-editing-routes";
import { listEditingProjectSummaries } from "@/lib/server/library-hierarchy";
export async function GET(req: Request) {
	return editingRoute(
		async () => {
			const { contentId, offset } = z
				.strictObject({
					contentId: z.uuid(),
					offset: z.coerce.number().int().min(0).max(10000).default(0),
				})
				.parse(Object.fromEntries(new URL(req.url).searchParams));
			return listEditingProjectSummaries(
				await getServerContext(),
				contentId,
				offset,
			);
		},
		200,
		{ allowUnavailable: "ARTIFACT_READ" },
	);
}
export async function POST(req: Request) {
	return editingMutation(
		req,
		async (actor) => createEditingProject(await editingBody(req), actor),
		201,
	);
}
