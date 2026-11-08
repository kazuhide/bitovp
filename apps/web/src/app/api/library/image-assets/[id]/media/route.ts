import { editingRoute } from "@/lib/server/library-editing-common";
import { serveImageAsset } from "@/lib/server/library-image-assets";
export const runtime = "nodejs";
export async function GET(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { id } = await params;
	const response = await editingRoute(() => serveImageAsset(req, id));
	response.headers.set("Cache-Control", "private, no-store");
	response.headers.set("X-Content-Type-Options", "nosniff");
	return response;
}
export async function HEAD(
	req: Request,
	context: { params: Promise<{ id: string }> },
) {
	return GET(req, context);
}
