import { aisaIngest } from "@/lib/server/aisa-live-routes";

export async function GET(
	req: Request,
	context: { params: Promise<{ analysisId: string }> },
) {
	return aisaIngest(req, (await context.params).analysisId);
}
