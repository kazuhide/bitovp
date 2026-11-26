import { invalidIdResponse } from "@/lib/server/http";
import { deleteVodInputFavorite } from "@/lib/server/vod-input-favorites";
import { vodInputFavoriteRouteError } from "@/lib/server/vod-input-favorites-http";

export async function DELETE(
	_req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { id } = await params,
		invalid = invalidIdResponse(id);
	if (invalid) return invalid;
	try {
		await deleteVodInputFavorite(id);
		return new Response(null, {
			status: 204,
			headers: { "Cache-Control": "private, no-store" },
		});
	} catch (error) {
		return vodInputFavoriteRouteError(error);
	}
}
