import "server-only";
import { getTenantPrisma } from "@bitovp/db";
import { verifiedClientIp } from "@/lib/auth/ip-policy";
import type { AuthenticatedContext } from "@/lib/auth/tenancy";

/** Access-gate decisions only. Administrator traffic is intentionally absent. */
export async function recordAccessNonAdmin(
	context: AuthenticatedContext,
	request: { method: string; url: string; headers: Headers },
	statusCode: number,
): Promise<void> {
	if (
		context.platformOwner ||
		context.actorRole === "ADMIN" ||
		context.isImpersonating
	)
		return;
	const path = new URL(request.url).pathname;
	// Polling is not an access visit and must not flood history.
	if (request.method === "GET" && path.startsWith("/api/")) return;
	await getTenantPrisma(context.organizationId).accessEvent.create({
		data: {
			userId: context.actorUserId,
			actor: context.actor,
			userDisplayName: context.user?.displayName ?? "API token",
			method: request.method,
			path,
			clientIp: verifiedClientIp(request.headers),
			statusCode,
		},
	});
}
