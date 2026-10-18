import { masterKeyFromEnv, stepLogSchema } from "@bitovp/core";
import type { Prisma } from "@bitovp/db";
import { NextResponse } from "next/server";
import { getServerContext } from "@/lib/server/context";
import { invalidIdResponse, jsonError, routeError } from "@/lib/server/http";
import { getOrchestratorQueue } from "@/lib/server/queue";

type RouteParams = { params: Promise<{ id: string }> };

/**
 * Re-enqueues an ERROR job. FAILED steps reset to PENDING; DONE steps keep
 * their resource ids, so the orchestrator resumes instead of recreating.
 */
export async function POST(_req: Request, { params }: RouteParams) {
	const { id } = await params;
	const invalid = invalidIdResponse(id);
	if (invalid) {
		return invalid;
	}
	try {
		// Fail fast before flipping state: a broken MASTER_KEY means the
		// worker cannot process the re-queued job (see POST route).
		masterKeyFromEnv();
		const ctx = await getServerContext();
		const row = await ctx.prisma.encodingJob.findUnique({ where: { id } });
		if (!row) {
			return jsonError(404, "Not found");
		}
		if (row.status !== "ERROR") {
			return jsonError(
				409,
				`Only ERROR jobs can be retried (status: ${row.status})`,
			);
		}
		if (row.remoteStopRequestedAt) {
			return jsonError(
				409,
				"Remote STOP was requested; use re-run-as-new instead of reusing these resources",
			);
		}
		const entries = stepLogSchema
			.parse(row.stepLog)
			.map((entry) =>
				entry.status === "FAILED" || entry.status === "RUNNING"
					? { ...entry, status: "PENDING" as const, error: undefined }
					: entry,
			);
		// Atomic claim: only one concurrent retry can flip ERROR → QUEUED
		// (single-writer contract; the worker assumes one active job per row).
		const { count } = await ctx.prisma.encodingJob.updateMany({
			where: { id, status: "ERROR", remoteStopRequestedAt: null },
			data: {
				status: "QUEUED",
				error: null,
				// rev431: a retry may RESUME the same encoding , so a
				// stop/CREATED confirmation for that pointer is stale from here.
				encoderStoppedConfirmedFor: null,
				stepLog: entries as unknown as Prisma.InputJsonValue,
			},
		});
		if (count === 0) {
			return jsonError(
				409,
				"Job changed or remote STOP was requested; refresh and use re-run-as-new if STOP was requested",
			);
		}
		try {
			await getOrchestratorQueue().add(
				"orchestrate",
				{ encodingJobId: id },
				// Unique per attempt: a completed BullMQ job with the same id
				// would otherwise swallow the re-enqueue.
				{
					jobId: `${id}-retry-${Date.now()}`,
					removeOnComplete: 1000,
					removeOnFail: 1000,
				},
			);
		} catch (enqueueErr) {
			// Leave the row recoverable instead of stranding it in QUEUED.
			await ctx.prisma.encodingJob.update({
				where: { id },
				data: { status: "ERROR", error: "Enqueue failed — retry again" },
			});
			throw enqueueErr;
		}
		return NextResponse.json({ id, status: "QUEUED" });
	} catch (err) {
		return routeError(err);
	}
}
