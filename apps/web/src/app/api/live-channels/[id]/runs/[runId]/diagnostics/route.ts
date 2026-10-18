import { getLiveRunDiagnostics } from "@/lib/server/live-run-diagnostics";

export async function GET(
	req: Request,
	{ params }: { params: Promise<{ id: string; runId: string }> },
) {
	return getLiveRunDiagnostics(req, await params);
}
