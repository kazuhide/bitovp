import { NextResponse } from "next/server";
import { getServerContext } from "@/lib/server/context";
import { invalidIdResponse, jsonError, routeError } from "@/lib/server/http";

type RouteParams = { params: Promise<{ id: string }> };

/**
 * Cooperative cancel . SETS the `cancelRequested` flag via an
 * atomic claim — it does NOT change `status`: the orchestrator worker is the
 * single writer of `status` and owns the terminal CANCELED transition (it
 * re-reads the flag at safe points and stops the Bitmovin encoding best-effort
 * first). Mirrors the live STOP action's atomic-claim style.
 *
 * The claim is the lock: only a QUEUED|RUNNING job that is NOT already
 * cancel-requested matches, so a terminal job (FINISHED/ERROR/CANCELED), a job
 * already being canceled, or a DRAFT all match zero rows → 409. A second
 * concurrent cancel also matches zero rows (flag already true) → 409. Unlike
 * the live STOP, NO MASTER_KEY check is needed: this is a pure DB flag flip;
 * the worker (which DOES need the key) already owns the cancel finalize.
 */
export async function POST(_req: Request, { params }: RouteParams) {
	const { id } = await params;
	const invalid = invalidIdResponse(id);
	if (invalid) {
		return invalid;
	}
	try {
		const ctx = await getServerContext();
		// Atomic claim: flip cancelRequested false→true only for a live job that
		// has not already been asked to cancel. Secret-free; touches no `status`.
		const { count } = await ctx.prisma.encodingJob.updateMany({
			where: {
				id,
				status: { in: ["QUEUED", "RUNNING"] },
				cancelRequested: false,
			},
			data: { cancelRequested: true },
		});
		if (count === 0) {
			// Already terminal, already canceling, or never cancelable (DRAFT).
			return jsonError(
				409,
				"Job is not cancelable (already finished, canceled, or canceling)",
			);
		}
		return NextResponse.json({ id, cancelRequested: true });
	} catch (err) {
		return routeError(err);
	}
}
