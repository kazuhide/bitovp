import { createHash } from "node:crypto";
import { roleAtLeast } from "@/lib/auth/roles";
import {
	AuthContextError,
	EXPECTED_ORGANIZATION_HEADER,
} from "@/lib/auth/tenancy";
import {
	operationAttemptEventSchema,
	RESULT_RECEIVE_WINDOW_MS,
} from "@/lib/operation-attempts";
import { getServerContext } from "@/lib/server/context";
import { readFeatureFlags } from "@/lib/server/feature-flags";
import { jsonError, routeError } from "@/lib/server/http";
import { createFixedWindowLimiter } from "@/lib/server/rate-limit";
import { readBoundedJson } from "@/lib/server/request-body";

const limiter = createFixedWindowLimiter({ limit: 120, windowMs: 60_000 });

function accepted() {
	return new Response(null, { status: 204 });
}

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
		if (!(await readFeatureFlags(prisma)).operationAnalytics) {
			return jsonError(404, "Operation collection is turned off");
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
		const event = parsed.data;
		const { attemptId: id, channelId, runId, operation, stage } = event;
		// Scope retries to the original session actor and target without retaining
		// a reusable actor identifier or a link to the broadcast in analytics.
		const ownerDigest = createHash("sha256")
			.update(
				JSON.stringify([
					organizationId,
					actor,
					operation,
					id,
					channelId,
					runId,
				]),
			)
			.digest("hex");
		const scope = { organizationId, id, operation, ownerDigest };

		if (stage === "STARTED") {
			const run = await prisma.liveChannelRun.findFirst({
				where: { id: runId, liveChannelId: channelId, organizationId },
				select: { id: true },
			});
			if (!run) return jsonError(404, "Run not found");
			const { count } = await prisma.operationAttempt.createMany({
				data: scope,
				skipDuplicates: true,
			});
			if (count === 1) return accepted();
			const existing = await prisma.operationAttempt.findFirst({
				where: scope,
				select: { id: true },
			});
			return existing ? accepted() : jsonError(409, "Attempt already exists");
		}

		const { elapsedMs } = event;
		const { count } = await prisma.operationAttempt.updateMany({
			where: {
				...scope,
				outcome: null,
				startedAt: { gte: new Date(Date.now() - RESULT_RECEIVE_WINDOW_MS) },
			},
			data: { outcome: stage, elapsedMs },
		});
		if (count === 1) return accepted();
		const existing = await prisma.operationAttempt.findFirst({
			where: scope,
			select: { outcome: true, elapsedMs: true },
		});
		if (!existing) return jsonError(404, "Attempt not found");
		if (existing.outcome === stage && existing.elapsedMs === elapsedMs) {
			return accepted();
		}
		return jsonError(409, "Attempt no longer accepts a result");
	} catch (error) {
		if (error instanceof AuthContextError) return routeError(error);
		console.error("[operation-attempts] collection unavailable");
		return jsonError(503, "Operation collection is unavailable");
	}
}
