import { getMoqAnalytics } from "@/lib/server/moq-analytics";

export async function GET(
	req: Request,
	{ params }: { params: Promise<{ id: string; runId: string }> },
) {
	return getMoqAnalytics(req, await params);
}
