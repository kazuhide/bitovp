import { NextResponse } from "next/server";
import { getServerContext } from "@/lib/server/context";
import { libraryRoute } from "@/lib/server/library";
import {
	sceneSearchQuery,
	searchLibraryScenes,
} from "@/lib/server/library-scene-search";

export async function GET(req: Request) {
	return libraryRoute(async () =>
		NextResponse.json(
			await searchLibraryScenes(
				(await getServerContext()).prisma,
				sceneSearchQuery.parse(
					Object.fromEntries(new URL(req.url).searchParams),
				),
			),
		),
	);
}
