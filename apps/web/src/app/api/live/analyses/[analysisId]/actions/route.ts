import { aisaAction } from "@/lib/server/aisa-live-routes";

export async function POST(
	req: Request,
	context: { params: Promise<{ analysisId: string }> },
) {
	return aisaAction(req, (await context.params).analysisId);
}
