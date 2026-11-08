import { invalidIdResponse } from "@/lib/server/http";
import { editingRoute } from "@/lib/server/library-editing-common";
import { readEditingRender } from "@/lib/server/library-editing-renders";
export async function GET(
	_req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { id } = await params;
	return invalidIdResponse(id) ?? editingRoute(() => readEditingRender(id));
}
