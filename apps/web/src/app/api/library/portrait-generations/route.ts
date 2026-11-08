import { createAutomaticPortrait } from "@/lib/server/library-automatic-portrait";
import { editingBody } from "@/lib/server/library-editing-common";
import { editingMutation } from "@/lib/server/library-editing-routes";

export async function POST(req: Request) {
	return editingMutation(
		req,
		async (actor) => createAutomaticPortrait(await editingBody(req), actor),
		202,
	);
}
