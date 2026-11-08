import { invalidIdResponse } from "@/lib/server/http";
import { editingBody } from "@/lib/server/library-editing-common";
import { confirmEditingRevision } from "@/lib/server/library-editing-projects";
import { editingMutation } from "@/lib/server/library-editing-routes";
export async function POST(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { id } = await params;
	return (
		invalidIdResponse(id) ??
		editingMutation(
			req,
			async (actor) =>
				confirmEditingRevision(id, await editingBody(req), actor),
			201,
		)
	);
}
