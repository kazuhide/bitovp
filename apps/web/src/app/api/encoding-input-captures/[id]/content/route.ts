import { servePinnedInputCapture } from "@/lib/server/input-capture-gateway";

type Context = { params: Promise<{ id: string }> };
export async function GET(req: Request, context: Context) {
	return servePinnedInputCapture(req, (await context.params).id);
}
export async function HEAD(req: Request, context: Context) {
	return servePinnedInputCapture(req, (await context.params).id);
}
