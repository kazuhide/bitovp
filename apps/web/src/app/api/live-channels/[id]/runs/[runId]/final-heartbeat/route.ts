import { getLiveRunDiagnostics } from "@/lib/server/live-run-diagnostics";

/** Separate ADMIN route: its response contains a provider download capability. */
export async function GET(
	req: Request,
	{ params }: { params: Promise<{ id: string; runId: string }> },
) {
	return getLiveRunDiagnostics(req, await params, true);
}
