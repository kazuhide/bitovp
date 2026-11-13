import { vodInputFavoriteCreateSchema } from "@bitovp/core/vod-input-timeline";
import { NextResponse } from "next/server";
import { jsonError, validationError } from "@/lib/server/http";
import { readBoundedJson } from "@/lib/server/request-body";
import {
	addVodInputFavorite,
	listVodInputFavorites,
} from "@/lib/server/vod-input-favorites";
import { vodInputFavoriteRouteError } from "@/lib/server/vod-input-favorites-http";

export async function GET() {
	try {
		return NextResponse.json(await listVodInputFavorites(), {
			headers: { "Cache-Control": "private, no-store" },
		});
	} catch (error) {
		return vodInputFavoriteRouteError(error);
	}
}
export async function POST(req: Request) {
	try {
		const raw = await readBoundedJson(req, 8192);
		if (raw.tooLarge)
			return jsonError(413, "Fixed source request is too large");
		const body = vodInputFavoriteCreateSchema.safeParse(raw.value);
		if (!body.success) return validationError(body.error);
		return NextResponse.json(
			{ favorite: await addVodInputFavorite(body.data) },
			{ status: 201, headers: { "Cache-Control": "private, no-store" } },
		);
	} catch (error) {
		return vodInputFavoriteRouteError(error);
	}
}
