import "server-only";
import { aisaLivePreviewEnabled } from "@bitovp/core/aisa-live-client";
import { z } from "zod";

/** Call only with the freshly authenticated server context's tenant. */
export function aisaLiveAccessAllowed(tenant: unknown): boolean {
	const ownerId = process.env.BITOVP_AISA_LIVE_PREVIEW_USER_ID?.trim();
	if (
		!aisaLivePreviewEnabled() ||
		!ownerId ||
		!z.uuid().safeParse(ownerId).success ||
		!tenant ||
		typeof tenant !== "object" ||
		Array.isArray(tenant)
	)
		return false;
	const principal = tenant as Record<string, unknown>;
	return (
		principal.actorUserId === ownerId &&
		principal.effectiveUserId === ownerId &&
		principal.actor === `user:${ownerId}` &&
		principal.role === "ADMIN" &&
		principal.actorRole === "ADMIN" &&
		principal.isImpersonating === false
	);
}
