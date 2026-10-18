import { masterKeyFromEnv } from "@bitovp/core";
import { NextResponse } from "next/server";
import { actorFrom } from "@/lib/server/audit";
import { getServerContext } from "@/lib/server/context";
import { invalidIdResponse, jsonError, routeError } from "@/lib/server/http";
import { getOrchestratorQueue } from "@/lib/server/queue";
import { ReRunPlanError, reRunJob } from "@/lib/server/rerun-job";

type RouteParams = { params: Promise<{ id: string }> };

/**
 * Re-runs a job as a brand-new QUEUED job (distinct id; source untouched).
 * Unlike /retry (which resumes the SAME row from its failed steps), this
 * recompiles a FRESH step log from the source plan. Built here for the bulk
 * action; the job detail page wires its own "re-run" button to this in #10.
 */
export async function POST(req: Request, { params }: RouteParams) {
	const { id } = await params;
	const invalid = invalidIdResponse(id);
	if (invalid) {
		return invalid;
	}
	try {
		// Fail fast before creating QUEUED state: a broken MASTER_KEY means the
		// worker cannot process the new job (mirrors POST /api/encoding-jobs).
		masterKeyFromEnv();
		const ctx = await getServerContext();
		const source = await ctx.prisma.encodingJob.findUnique({
			where: { id },
			select: { id: true, plan: true },
		});
		if (!source) {
			return jsonError(404, "Not found");
		}
		try {
			const { newId } = await reRunJob(
				{
					prisma: ctx.prisma,
					bitmovinAccounts: ctx.bitmovinAccounts,
					credentials: ctx.credentials,
					queue: getOrchestratorQueue(),
					actor: actorFrom(req),
				},
				source,
			);
			return NextResponse.json(
				{ id: newId, sourceId: id, status: "QUEUED" },
				{ status: 201 },
			);
		} catch (reRunErr) {
			if (reRunErr instanceof ReRunPlanError) {
				return jsonError(400, reRunErr.message, reRunErr.details);
			}
			throw reRunErr;
		}
	} catch (err) {
		return routeError(err);
	}
}
