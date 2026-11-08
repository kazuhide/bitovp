import { invalidIdResponse } from "@/lib/server/http";
import { editingBody } from "@/lib/server/library-editing-common";
import { saveEditingDraft } from "@/lib/server/library-editing-projects";
import { editingMutation } from "@/lib/server/library-editing-routes";
export async function PUT(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { id } = await params;
	return (
		invalidIdResponse(id) ??
		editingMutation(
			req,
			async (_actor) => saveEditingDraft(id, await editingBody(req)),
			200,
		)
	);
}
