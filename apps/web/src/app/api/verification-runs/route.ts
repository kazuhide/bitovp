import { jsonError } from "@/lib/server/http";

/**
 * Verification runs are release-harness evidence, not a customer API.
 * Workers and the harness continue to persist and read the DB records directly.
 */
export async function GET(_request: Request) {
	return jsonError(404, "Not found");
}
