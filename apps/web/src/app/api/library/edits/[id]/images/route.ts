import { invalidIdResponse } from "@/lib/server/http";
import { editingMutation } from "@/lib/server/library-editing-routes";
import { createImageAsset } from "@/lib/server/library-image-assets";
export const runtime = "nodejs";
export async function POST(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { id } = await params;
	return (
		invalidIdResponse(id) ??
		editingMutation(req, (actor) => createImageAsset(req, id, actor), 201)
	);
}
