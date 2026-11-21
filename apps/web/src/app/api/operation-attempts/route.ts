import { roleAtLeast } from "@/lib/auth/roles";
import {
	AuthContextError,
	EXPECTED_ORGANIZATION_HEADER,
} from "@/lib/auth/tenancy";
import { operationAttemptEventSchema } from "@/lib/operation-attempts";
import { getServerContext } from "@/lib/server/context";
import { jsonError, routeError } from "@/lib/server/http";
import { recordOperationAttempt } from "@/lib/server/operation-attempt-collector";
import { createFixedWindowLimiter } from "@/lib/server/rate-limit";
import { readBoundedJson } from "@/lib/server/request-body";

const limiter = createFixedWindowLimiter({ limit: 120, windowMs: 60_000 });

export async function POST(req: Request) {
	try {
		const { tenant, prisma } = await getServerContext();
		if (
			!tenant ||
			tenant.isImpersonating ||
			!roleAtLeast(tenant.role, "OPERATOR") ||
			tenant.actor.startsWith("token:")
		) {
			return jsonError(
				403,
				"Operation collection requires an operator session",
			);
		}
		const { actor, organizationId } = tenant;
		if (req.headers.get(EXPECTED_ORGANIZATION_HEADER) !== organizationId) {
			return jsonError(409, "Organization changed");
		}
		if (!limiter.check(JSON.stringify([organizationId, actor]))) {
			return jsonError(429, "Too many operation events");
		}
		if (
			req.headers
				.get("content-type")
				?.split(";", 1)[0]
				?.trim()
				.toLowerCase() !== "application/json"
		) {
			return jsonError(415, "Expected application/json");
		}
		const body = await readBoundedJson(req, 1_024);
		if (body.tooLarge) return jsonError(413, "Operation event is too large");
		const parsed = operationAttemptEventSchema.safeParse(body.value);
		if (!parsed.success) return jsonError(400, "Invalid operation event");
		return await recordOperationAttempt(
			prisma,
			{ actor, organizationId },
			parsed.data,
		);
	} catch (error) {
		if (error instanceof AuthContextError) return routeError(error);
		console.error("[operation-attempts] collection unavailable");
		return jsonError(503, "Operation collection is unavailable");
	}
}
