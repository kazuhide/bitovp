import { generationHistoryFilters } from "@/lib/library-generation-history";
import { requestOrganizationId } from "@/lib/passive-request";
import { getServerContext } from "@/lib/server/context";
import { editingBody, editingRoute } from "@/lib/server/library-editing-common";
import { editingMutation } from "@/lib/server/library-editing-routes";
import { listGenerationHistory } from "@/lib/server/library-generation-history";
import {
	createMediaTask,
	listMediaTasks,
} from "@/lib/server/library-media-tasks";

export async function GET(req: Request) {
	return editingRoute(
		async () => {
			const { view, ...query } = Object.fromEntries(
				new URL(req.url).searchParams,
			);
			if (view !== "history")
				return listMediaTasks(view === undefined ? query : { view, ...query });
			const ctx = await getServerContext();
			return listGenerationHistory(
				ctx.prisma,
				requestOrganizationId(ctx),
				generationHistoryFilters.parse(query),
			);
		},
		200,
		{ allowUnavailable: "ARTIFACT_READ" },
	);
}
export async function POST(req: Request) {
	return editingMutation(
		req,
		async (actor) => createMediaTask(await editingBody(req), actor),
		202,
	);
}
