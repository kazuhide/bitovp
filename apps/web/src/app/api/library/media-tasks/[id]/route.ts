import { editingRoute } from "@/lib/server/library-editing-common";
import { readMediaTask } from "@/lib/server/library-media-tasks";

export async function GET(
	_req: Request,
	context: { params: Promise<{ id: string }> },
) {
	return editingRoute(
		async () => readMediaTask((await context.params).id),
		200,
		{ allowUnavailable: "ARTIFACT_READ" },
	);
}
