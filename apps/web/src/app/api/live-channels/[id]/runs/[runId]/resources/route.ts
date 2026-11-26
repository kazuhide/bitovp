import { removeResource } from "@/lib/server/encoding-resources/removal";
import { readResources } from "@/lib/server/encoding-resources/route";
export async function GET(
	req: Request,
	{ params }: { params: Promise<{ id: string; runId: string }> },
) {
	const { id, runId } = await params;
	return readResources(req, { channelId: id, runId });
}

export async function DELETE(
	req: Request,
	{ params }: { params: Promise<{ id: string; runId: string }> },
) {
	const { id, runId } = await params;
	return removeResource(req, { channelId: id, runId }, "remove");
}

export async function POST(
	req: Request,
	{ params }: { params: Promise<{ id: string; runId: string }> },
) {
	const { id, runId } = await params;
	return removeResource(req, { channelId: id, runId }, "verify");
}
