import { invalidIdResponse } from "@/lib/server/http";
import { editingBody } from "@/lib/server/library-editing-common";
import { requestEditingMedia } from "@/lib/server/library-editing-media";
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
			async (_actor) => requestEditingMedia(id, await editingBody(req)),
			202,
		)
	);
}
