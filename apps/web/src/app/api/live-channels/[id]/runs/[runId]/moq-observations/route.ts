import { getMoqObservations } from "@/lib/server/moq-observations";

export async function GET(
	req: Request,
	{ params }: { params: Promise<{ id: string; runId: string }> },
) {
	return getMoqObservations(req, await params);
}
