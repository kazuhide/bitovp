import { invalidIdResponse } from "@/lib/server/http";
import { serveVodInputPreviewContent } from "@/lib/server/vod-input-preview-content";
import { vodInputPreviewRouteError } from "@/lib/server/vod-input-preview-http";

export const runtime = "nodejs";
export async function GET(
	req: Request,
	context: { params: Promise<{ id: string }> },
) {
	const { id } = await context.params;
	const invalid = invalidIdResponse(id);
	if (invalid) return invalid;
	try {
		return await serveVodInputPreviewContent(req, id);
	} catch (error) {
		return vodInputPreviewRouteError(error);
	}
}
export const HEAD = GET;
