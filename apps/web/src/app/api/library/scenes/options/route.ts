import { NextResponse } from "next/server";
import { getServerContext } from "@/lib/server/context";
import { libraryRoute } from "@/lib/server/library";
import {
	librarySceneOptions,
	sceneOptionsQuery,
} from "@/lib/server/library-scene-search";

export async function GET(req: Request) {
	return libraryRoute(async () =>
		NextResponse.json(
			await librarySceneOptions(
				(await getServerContext()).prisma,
				sceneOptionsQuery.parse(
					Object.fromEntries(new URL(req.url).searchParams),
				),
			),
		),
	);
}
