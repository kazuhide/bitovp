import {
	encodingPlanSchema,
	stepLogSchema,
	VMAF_SCORING_VERSION,
	vmafExecutionSchema,
} from "@bitovp/core";
import {
	autoTriggerKey,
	DB_NULL,
	labManualTriggerPrefix,
	type Prisma,
} from "@bitovp/db";
import { NextResponse } from "next/server";
import { getServerContext } from "@/lib/server/context";
import { requireQcVmafEnabled } from "@/lib/server/feature-flags";
import { invalidIdResponse, jsonError, routeError } from "@/lib/server/http";
import { getVmafQueue } from "@/lib/server/queue";

type RouteParams = { params: Promise<{ id: string }> };
class RetryConflict extends Error {
	constructor(readonly publicMessage: string) {
		super(publicMessage);
	}
}

/** A new local measurement over existing outputs, never an encoding retry.
 * Keep failed evidence; transfer automatic gate ownership atomically so only
 * the replacement can release deferred manifests. */
export async function POST(_req: Request, { params }: RouteParams) {
	const disabled = await requireQcVmafEnabled();
	if (disabled) return disabled;
	const { id } = await params;
	const invalid = invalidIdResponse(id);
	if (invalid) return invalid;
	try {
		const { prisma } = await getServerContext();
		const pointer = await prisma.vmafJob.findUnique({
			where: { id },
			select: { encodingJobId: true },
		});
		if (!pointer) return jsonError(404, "Not found");
		if (!pointer.encodingJobId)
			return jsonError(409, "The encoding job is no longer available");
		const encodingJobId = pointer.encodingJobId;
		const queue = getVmafQueue();
		const created = await prisma.$transaction(
			async (tx) => {
				await tx.$queryRaw`SELECT id FROM "EncodingJob" WHERE id = ${encodingJobId}::uuid FOR UPDATE`;
				const row = await tx.vmafJob.findUnique({
					where: { id },
					include: { encodingJob: true },
				});
				if (!row || row.encodingJobId !== encodingJobId || !row.encodingJob)
					throw new RetryConflict("The encoding job is no longer available");
				if (row.mode !== "VOD" || row.status !== "ERROR")
					throw new RetryConflict(
						"Only failed VOD measurements can be retried",
					);
				const stored = (row.params ?? {}) as Record<string, unknown>;
				const execution = vmafExecutionSchema.safeParse(
					stored.execution ?? { backend: "LOCAL" },
				);
				if (!execution.success || execution.data.backend !== "LOCAL")
					throw new RetryConflict(
						"Retry cloud measurements from VMAF Lab with an explicit compute budget",
					);
				const automatic = row.triggerKey === autoTriggerKey(encodingJobId);
				if (
					!automatic &&
					!row.triggerKey?.startsWith(labManualTriggerPrefix(encodingJobId))
				)
					throw new RetryConflict(
						"This measurement has already been retried or has unknown provenance",
					);
				const job = row.encodingJob;
				const plan = encodingPlanSchema.safeParse(job.plan);
				if (!plan.success)
					throw new RetryConflict("The stored plan no longer parses");
				const blocked = job.status === "QC_FAILED";
				if (job.status !== "FINISHED" && !blocked)
					throw new RetryConflict(
						"Wait for the encoding and its QC recovery to settle before retrying",
					);
				if (
					blocked &&
					(!automatic ||
						plan.data.qc?.gate?.onFail !== "BLOCK_MANIFESTS" ||
						job.qcOverriddenAt)
				)
					throw new RetryConflict(
						"Only the failed automatic measurement can retry a blocked QC gate",
					);
				// A continuation may only resume already-completed encoding steps.
				const steps = stepLogSchema.safeParse(job.stepLog);
				if (
					blocked &&
					(!steps.success ||
						!steps.data.some((e) => e.phase === "post-qc") ||
						steps.data.some(
							(e) => e.phase !== "post-qc" && e.status !== "DONE",
						))
				)
					throw new RetryConflict(
						"The encoding steps are not complete; VMAF-only retry cannot resume them",
					);
				if (
					await tx.vmafJob.count({
						where: { encodingJobId, status: { in: ["PENDING", "RUNNING"] } },
					})
				)
					throw new RetryConflict(
						"A measurement for this encoding is already active",
					);
				const queued = await queue.getJob(id);
				if (
					queued &&
					!["completed", "failed", "unknown"].includes(await queued.getState())
				)
					throw new RetryConflict(
						"The previous measurement worker has not stopped yet",
					);
				const claimed = await tx.vmafJob.updateMany({
					where: { id, status: "ERROR", triggerKey: row.triggerKey },
					data: { triggerKey: `retry-history:${id}` },
				});
				if (claimed.count !== 1)
					throw new RetryConflict("This measurement is already being retried");
				const next = await tx.vmafJob.create({
					data: {
						encodingJobId,
						mode: "VOD",
						model: row.model,
						scoringVersion: VMAF_SCORING_VERSION,
						status: "PENDING",
						triggerKey: automatic
							? autoTriggerKey(encodingJobId)
							: `${labManualTriggerPrefix(encodingJobId)}${row.model}:retry-${id}`,
						params: {
							execution: { backend: "LOCAL" },
							retryOf: id,
							...(stored.source === "OUTPUT_MP4"
								? { source: "OUTPUT_MP4" }
								: {}),
							...(typeof stored.psnr === "boolean"
								? { psnr: stored.psnr }
								: {}),
						} as Prisma.InputJsonValue,
					},
					select: { id: true },
				});
				if (blocked)
					await tx.encodingJob.update({
						where: { id: encodingJobId },
						data: { status: "AWAITING_QC", error: null, qcVerdict: DB_NULL },
					});
				return { ...next, blocked };
			},
			{ isolationLevel: "Serializable" },
		);
		try {
			await queue.add(
				"vmaf",
				{ vmafJobId: created.id },
				{ jobId: created.id, removeOnComplete: 1000, removeOnFail: 1000 },
			);
		} catch (error) {
			// Leave an actionable failed replacement, preserving its gate ownership.
			await prisma.$transaction(async (tx) => {
				await tx.$queryRaw`SELECT id FROM "EncodingJob" WHERE id = ${encodingJobId}::uuid FOR UPDATE`;
				const failed = await tx.vmafJob.updateMany({
					where: { id: created.id, status: "PENDING" },
					data: {
						status: "ERROR",
						error: "Enqueue failed — retry this VMAF measurement",
					},
				});
				if (created.blocked && failed.count)
					await tx.encodingJob.updateMany({
						where: { id: encodingJobId, status: "AWAITING_QC" },
						data: { status: "QC_FAILED", error: "VMAF enqueue failed" },
					});
			});
			throw error;
		}
		return NextResponse.json(
			{ id: created.id, encodingJobId, status: "PENDING" },
			{ status: 201 },
		);
	} catch (error) {
		if (error instanceof RetryConflict)
			return jsonError(409, error.publicMessage);
		if (
			error &&
			typeof error === "object" &&
			"code" in error &&
			["P2002", "P2034"].includes(String(error.code))
		)
			return jsonError(
				409,
				"A measurement for this encoding is already starting; refresh and try again",
			);
		return routeError(error);
	}
}
