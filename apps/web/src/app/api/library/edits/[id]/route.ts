import { invalidIdResponse } from "@/lib/server/http";
import { editingRoute } from "@/lib/server/library-editing-common";
import { readEditingProject } from "@/lib/server/library-editing-projects";
export async function GET(
	_req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { id } = await params;
	return invalidIdResponse(id) ?? editingRoute(() => readEditingProject(id));
}
