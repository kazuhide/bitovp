import { invalidIdResponse } from "@/lib/server/http";
import { editingRoute } from "@/lib/server/library-editing-common";
import { readEditingThumbnailFrame } from "@/lib/server/library-editing-thumbnail";

export async function GET(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { id } = await params;
	const response =
		invalidIdResponse(id) ??
		(await editingRoute(() => readEditingThumbnailFrame(req, id), 200, {
			allowUnavailable: "ARTIFACT_READ",
		}));
	response.headers.set("Cache-Control", "private, no-store");
	return response;
}
