import { aisaResults } from "@/lib/server/aisa-live-routes";

export async function GET(
	req: Request,
	context: { params: Promise<{ analysisId: string }> },
) {
	return aisaResults(req, (await context.params).analysisId);
}
