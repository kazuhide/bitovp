import { editingBody } from "@/lib/server/library-editing-common";
import { editingMutation } from "@/lib/server/library-editing-routes";
import { retryMediaTask } from "@/lib/server/library-media-tasks";

export async function POST(
	req: Request,
	context: { params: Promise<{ id: string }> },
) {
	return editingMutation(
		req,
		async (actor) =>
			retryMediaTask((await context.params).id, await editingBody(req), actor),
		202,
	);
}
