import { readFile } from "node:fs/promises";
import {
	EditingRequestError,
	editingRoute,
} from "@/lib/server/library-editing-common";
export const runtime = "nodejs";
export async function GET() {
	return editingRoute(
		async () => {
			const path = process.env.EDITING_FONT_PATH;
			if (!path) throw new EditingRequestError(503, "EDITING_FONT_UNAVAILABLE");
			const bytes = await readFile(path);
			return new Response(bytes, {
				headers: {
					"Content-Type": "font/otf",
					"Cache-Control": "private, max-age=86400",
					"X-Content-Type-Options": "nosniff",
				},
			});
		},
		200,
		{ allowUnavailable: "ARTIFACT_READ" },
	);
}
