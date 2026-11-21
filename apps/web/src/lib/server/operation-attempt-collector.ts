import "server-only";
import { createHash } from "node:crypto";
import type { AppPrismaClient } from "@bitovp/db";
import {
	type OperationAttemptEvent,
	RESULT_RECEIVE_WINDOW_MS,
} from "@/lib/operation-attempts";
import { readLockedFeatureFlags } from "./feature-flags";
import { jsonError } from "./http";
import {
	moqPlaybackRunSelect,
	readMoqPlaybackBinding,
} from "./moq-playback-run";

function accepted() {
	return new Response(null, { status: 204 });
}

function canRetry(error: unknown) {
	const conflict = error as { code?: string; meta?: { code?: string } } | null;
	return (
		conflict?.code === "P2034" ||
		(conflict?.code === "P2010" && conflict.meta?.code === "40001")
	);
}

export async function recordOperationAttempt(
	prisma: AppPrismaClient,
	{ organizationId, actor }: { organizationId: string; actor: string },
	event: OperationAttemptEvent,
): Promise<Response> {
	const { attemptId: id, channelId, runId, operation, stage } = event;
	// Bind replays to the actor and target without retaining reusable identifiers.
	const ownerDigest = createHash("sha256")
		.update(
			JSON.stringify([organizationId, actor, operation, id, channelId, runId]),
		)
		.digest("hex");
	const scope = { organizationId, id, operation, ownerDigest };

	for (let attempt = 0; ; attempt++) {
		try {
			return await prisma.$transaction(
				async (tx) => {
					if (
						!(await readLockedFeatureFlags(tx, organizationId))
							.operationAnalytics
					) {
						return jsonError(404, "Operation collection is turned off");
					}
					if (stage === "STARTED") {
						// An acknowledged attempt stays replayable even if its run ended or
						// was deleted. Check its immutable ownership before run admission.
						const existing = await tx.operationAttempt.findFirst({
							where: { organizationId, id },
							select: { operation: true, ownerDigest: true },
						});
						if (existing) {
							return existing.operation === operation &&
								existing.ownerDigest === ownerDigest
								? accepted()
								: jsonError(409, "Attempt already exists");
						}
						// Match reset's parent-first lock order. Serializable checks protect
						// a concurrent history deletion from using a pre-insert snapshot.
						const [channel] = await tx.$queryRaw<{ id: string }[]>`
						SELECT "id" FROM "LiveChannel"
						WHERE "organizationId" = ${organizationId}::uuid AND "id" = ${channelId}::uuid
						FOR KEY SHARE
					`;
						if (!channel) return jsonError(404, "Run not found");
						const run = await tx.liveChannelRun.findFirst({
							where: { organizationId, liveChannelId: channelId },
							orderBy: { seq: "desc" },
							select: moqPlaybackRunSelect,
						});
						const binding = readMoqPlaybackBinding(run, {
							organizationId,
							channelId,
							runId,
						});
						if (!binding.ok)
							return jsonError(
								binding.status,
								"Run is not ready for MoQ playback",
							);
						const { count } = await tx.operationAttempt.createMany({
							data: scope,
							skipDuplicates: true,
						});
						// A concurrent insert normally raises a serialization error, which
						// retries against a fresh snapshot and runs the replay check above.
						return count === 1
							? accepted()
							: jsonError(409, "Attempt already exists");
					}

					const { elapsedMs } = event;
					const { count } = await tx.operationAttempt.updateMany({
						where: {
							...scope,
							outcome: null,
							startedAt: {
								gte: new Date(Date.now() - RESULT_RECEIVE_WINDOW_MS),
							},
						},
						data: { outcome: stage, elapsedMs },
					});
					if (count === 1) return accepted();
					const existing = await tx.operationAttempt.findFirst({
						where: scope,
						select: { outcome: true, elapsedMs: true },
					});
					if (!existing) return jsonError(404, "Attempt not found");
					if (existing.outcome === stage && existing.elapsedMs === elapsedMs) {
						return accepted();
					}
					return jsonError(409, "Attempt no longer accepts a result");
				},
				{ isolationLevel: "Serializable" },
			);
		} catch (error) {
			if (attempt === 2 || !canRetry(error)) throw error;
		}
	}
}
