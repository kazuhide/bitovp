import { NextResponse } from "next/server";
import { requestOrganizationId } from "@/lib/passive-request";
import { getServerContext } from "@/lib/server/context";
import { libraryRoute } from "@/lib/server/library";
import {
	sceneSearchQuery,
	searchLibraryScenes,
} from "@/lib/server/library-scene-search";

export async function GET(req: Request) {
	return libraryRoute(async () => {
		const ctx = await getServerContext();
		return NextResponse.json(
			await searchLibraryScenes(
				ctx.prisma,
				sceneSearchQuery.parse(
					Object.fromEntries(new URL(req.url).searchParams),
				),
				requestOrganizationId(ctx),
			),
		);
	});
}
