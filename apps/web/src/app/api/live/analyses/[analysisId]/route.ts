import { aisaDetail } from "@/lib/server/aisa-live-routes";

export async function GET(
	req: Request,
	context: { params: Promise<{ analysisId: string }> },
) {
	return aisaDetail(req, (await context.params).analysisId);
}
