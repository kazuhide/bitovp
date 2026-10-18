import { masterKeyFromEnv } from "@bitovp/core";
import type { Prisma } from "@bitovp/db";
import { NextResponse } from "next/server";
import { writeAuditLog } from "@/lib/server/audit";
import { getServerContext } from "@/lib/server/context";
import { invalidIdResponse, jsonError, routeError } from "@/lib/server/http";
import { getOrchestratorQueue } from "@/lib/server/queue";

type RouteParams = { params: Promise<{ id: string }> };

/**
 * Override-and-deliver : resume a
 * QC_FAILED job's deferred manifest group DESPITE the failing verdict. The
 * verdict is not amended — the evidence report keeps stating FAIL, plus the
 * fact that delivery was forced (`qcOverriddenAt`). JOB-LEVEL by design
 * (design §6: not per-rule).
 *
 * Mechanics mirror /retry: an atomic status claim is the lock (only one
 * concurrent override can flip QC_FAILED→QUEUED), the enqueue uses a
 * timestamped jobId (a completed BullMQ job under the plain id would swallow
 * the add), and a THROWN enqueue reverts the claim + flag with a
 * compensating audit entry. A hard crash between claim and enqueue still
 * strands QUEUED (review-203 N1) — the same residual /retry has always had,
 * shared class, not new here.
 */
export async function POST(req: Request, { params }: RouteParams) {
	const { id } = await params;
	const invalid = invalidIdResponse(id);
	if (invalid) {
		return invalid;
	}
	try {
		// Fail fast like /retry (review-203 N3): with a broken MASTER_KEY the
		// worker cannot decrypt anything — consuming the override (audit +
		// flag + QUEUED) for a run that can only land ERROR wastes the
		// operator's audited decision.
		masterKeyFromEnv();
		const ctx = await getServerContext();
		const row = await ctx.prisma.encodingJob.findUnique({
			where: { id },
			select: { id: true, status: true, stepLog: true },
		});
		if (!row) {
			return jsonError(404, "Not found");
		}
		if (row.status !== "QC_FAILED") {
			return jsonError(
				409,
				`Only QC_FAILED jobs can be delivered anyway (status: ${row.status})`,
			);
		}
		// A QC_FAILED job with no deferred steps has nothing to deliver —
		// possible only for a corrupted log, but 409 beats a silent FINISH.
		const entries = Array.isArray(row.stepLog)
			? (row.stepLog as { phase?: string; status?: string }[])
			: [];
		if (!entries.some((entry) => entry.phase === "post-qc")) {
			return jsonError(409, "This job has no blocked manifest steps");
		}
		const overriddenAt = new Date();
		const { count } = await ctx.prisma.encodingJob.updateMany({
			where: { id, status: "QC_FAILED" },
			data: {
				status: "QUEUED",
				error: null,
				qcOverriddenAt: overriddenAt,
			} satisfies Prisma.EncodingJobUpdateManyMutationInput,
		});
		if (count === 0) {
			return jsonError(409, "Job is no longer in QC_FAILED state");
		}
		// The forced delivery is an audited decision: who forced what, when.
		// The actor comes from the request  — passing it is what
		// makes that true; the wrapper used to be handed no request at all and
		// this comment claimed attribution the row never got.
		await writeAuditLog(
			ctx,
			{
				method: "POST",
				path: `/api/encoding-jobs/${id}/qc-override`,
				statusCode: 200,
				response: { id, overriddenAt: overriddenAt.toISOString() },
			},
			req,
		);
		try {
			await getOrchestratorQueue().add(
				"orchestrate",
				{ encodingJobId: id },
				// Unique per attempt — the /retry lesson: a completed BullMQ job
				// under the plain row id silently swallows the re-enqueue.
				{
					jobId: `${id}-qc-override-${Date.now()}`,
					removeOnComplete: 1000,
					removeOnFail: 1000,
				},
			);
		} catch (enqueueErr) {
			// Revert so the row stays actionable instead of QUEUED-forever.
			// The flag reverts WITH the status: an un-acted override must not
			// linger — the next successful override stamps its own time.
			await ctx.prisma.encodingJob.update({
				where: { id },
				data: {
					status: "QC_FAILED",
					error: "Enqueue failed — deliver anyway again",
					qcOverriddenAt: null,
				},
			});
			// review-203 I3: the pre-enqueue audit recorded the DECISION with a
			// 200; without this compensating entry the trail asserted a forced
			// delivery that never happened. writeAuditLog swallows its own
			// errors, so this cannot mask the rethrow below.
			await writeAuditLog(
				ctx,
				{
					method: "POST",
					path: `/api/encoding-jobs/${id}/qc-override`,
					statusCode: 500,
					response: {
						id,
						reverted: true,
						error: "enqueue failed — override rolled back",
					},
				},
				req,
			);
			throw enqueueErr;
		}
		return NextResponse.json({
			id,
			status: "QUEUED",
			overriddenAt: overriddenAt.toISOString(),
		});
	} catch (err) {
		return routeError(err);
	}
}
