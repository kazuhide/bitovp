import { removeResource } from "@/lib/server/encoding-resources/removal";
import { readResources } from "@/lib/server/encoding-resources/route";
export async function GET(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { id } = await params;
	return readResources(req, { jobId: id });
}

export async function DELETE(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { id } = await params;
	return removeResource(req, { jobId: id }, "remove");
}

export async function POST(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { id } = await params;
	return removeResource(req, { jobId: id }, "verify");
}
