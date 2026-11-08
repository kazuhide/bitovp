import { serveAisaRecording } from "@/lib/server/aisa-live-recording";

export const runtime = "nodejs";
type Context = { params: Promise<{ analysisId: string }> };
export async function GET(req: Request, { params }: Context) {
	return serveAisaRecording(req, (await params).analysisId);
}
export const HEAD = GET;
