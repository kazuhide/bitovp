import { getMoqArchive, putMoqArchive } from "@/lib/server/moq-archive";

type Params = {
	params: Promise<{ id: string; runId: string; sessionId: string }>;
};
export async function GET(req: Request, { params }: Params) {
	return getMoqArchive(req, await params);
}
export async function PUT(req: Request, { params }: Params) {
	return putMoqArchive(req, await params);
}
