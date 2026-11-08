import { editingMutation } from "@/lib/server/library-editing-routes";
import { cancelMediaTask } from "@/lib/server/library-media-tasks";

export async function POST(
	req: Request,
	context: { params: Promise<{ id: string }> },
) {
	return editingMutation(
		req,
		async () => cancelMediaTask((await context.params).id),
		200,
		{ allowUnavailable: "CANCEL" },
	);
}
