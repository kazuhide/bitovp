import { invalidIdResponse } from "@/lib/server/http";
import { editingRoute } from "@/lib/server/library-editing-common";
import { serveEditingObject } from "@/lib/server/library-editing-media";
export const runtime = "nodejs";
export async function GET(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { id } = await params;
	const result =
		invalidIdResponse(id) ??
		(await editingRoute(() => serveEditingObject(req, id, "MEDIA")));
	result.headers.set("Cache-Control", "private, no-store");
	result.headers.set("X-Content-Type-Options", "nosniff");
	return result;
}
