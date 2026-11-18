import { getMoqPlaybackDescriptor } from "@/lib/server/moq-playback";

export async function GET(
	req: Request,
	{ params }: { params: Promise<{ id: string; runId: string }> },
) {
	return getMoqPlaybackDescriptor(req, await params);
}
