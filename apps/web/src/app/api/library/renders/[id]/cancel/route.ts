import { invalidIdResponse } from "@/lib/server/http";
import { cancelEditingRender } from "@/lib/server/library-editing-renders";
import { editingMutation } from "@/lib/server/library-editing-routes";
export async function POST(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { id } = await params;
	return (
		invalidIdResponse(id) ??
		editingMutation(req, () => cancelEditingRender(id), 202, {
			allowUnavailable: "CANCEL",
		})
	);
}
