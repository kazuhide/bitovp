import { serveAisaRecordingMedia } from "@/lib/server/aisa-live-recording";

export const runtime = "nodejs";
type Context = { params: Promise<{ analysisId: string }> };
export async function GET(req: Request, { params }: Context) {
	return serveAisaRecordingMedia(req, (await params).analysisId);
}
export const HEAD = GET;
