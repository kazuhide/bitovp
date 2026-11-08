import { editingBody, editingRoute } from "@/lib/server/library-editing-common";
import { editingMutation } from "@/lib/server/library-editing-routes";
import {
	createMediaTask,
	listMediaTasks,
} from "@/lib/server/library-media-tasks";

export async function GET(req: Request) {
	return editingRoute(() =>
		listMediaTasks(Object.fromEntries(new URL(req.url).searchParams)),
	);
}
export async function POST(req: Request) {
	return editingMutation(
		req,
		async (actor) => createMediaTask(await editingBody(req), actor),
		202,
	);
}
