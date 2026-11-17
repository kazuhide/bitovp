import { putMoqObservation } from "@/lib/server/moq-observations";

export async function PUT(
	req: Request,
	{
		params,
	}: { params: Promise<{ id: string; runId: string; sessionId: string }> },
) {
	return putMoqObservation(req, await params);
}
