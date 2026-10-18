import { jsonError } from "@/lib/server/http";

type RouteParams = { params: Promise<{ id: string }> };

/** Release-harness evidence has no customer-facing detail API. */
export async function GET(_request: Request, _context: RouteParams) {
	return jsonError(404, "Not found");
}
