import { vmafExecutionSchema } from "@bitovp/core";
import { NextResponse } from "next/server";
import { getServerContext } from "@/lib/server/context";
import { requireQcVmafEnabled } from "@/lib/server/feature-flags";
import { invalidIdResponse, jsonError, routeError } from "@/lib/server/http";

type RouteParams = { params: Promise<{ id: string }> };

/** Retain the job and compute ledger: the controller/reaper owns provider cleanup. */
export async function POST(_req: Request, { params }: RouteParams) {
	const disabled = await requireQcVmafEnabled();
	if (disabled) return disabled;
	const { id } = await params;
	const invalid = invalidIdResponse(id);
	if (invalid) return invalid;
	try {
		const { prisma } = await getServerContext();
		const job = await prisma.vmafJob.findUnique({
			where: { id },
			select: { mode: true, status: true, params: true },
		});
		if (!job) return jsonError(404, "Not found");
		const execution = vmafExecutionSchema.safeParse(
			typeof job.params === "object" &&
				job.params !== null &&
				"execution" in job.params
				? job.params.execution
				: { backend: "LOCAL" },
		).data;
		if (job.mode !== "VOD" || !execution)
			return jsonError(409, "Only supported VOD measurements can be canceled");
		let cancelRequested = false;
		if (job.status === "PENDING" || job.status === "RUNNING") {
			// Recheck eligibility atomically. A concurrent completion must never be overwritten.
			const updated = await prisma.vmafJob.updateMany({
				where: {
					id,
					mode: "VOD",
					status: { in: ["PENDING", "RUNNING"] },
					...(execution.backend === "CLOUD"
						? { params: { path: ["execution", "backend"], equals: "CLOUD" } }
						: {}),
				},
				data: {
					status: "ERROR",
					error:
						execution.backend === "CLOUD"
							? "Cloud measurement canceled; cleanup continues"
							: "Local measurement cancellation requested; cleanup continues",
				},
			});
			cancelRequested = updated.count === 1;
		}
		// Terminal jobs (including a completion racing this request) are idempotent.
		return NextResponse.json({ id, cancelRequested, stopped: false });
	} catch (error) {
		return routeError(error);
	}
}
