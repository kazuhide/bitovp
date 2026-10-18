import {
	enqueueFeederJob,
	feederProcessMayBeAlive,
	feederPublisherClaimHeld,
} from "@bitovp/core";
import { NextResponse } from "next/server";
import { z } from "zod";
import { customerErrorDetails } from "@/lib/customer-error";
import { getServerContext } from "@/lib/server/context";
import {
	invalidIdResponse,
	jsonError,
	readJson,
	routeError,
	validationError,
} from "@/lib/server/http";
import { getFeederQueue } from "@/lib/server/queue";

type RouteParams = { params: Promise<{ id: string }> };

/**
 * Feeder session actions. Stop-only: sessions are one-shot (a stopped or
 * errored session is recreated, not revived; ffmpeg restarts are internal
 * to the supervisor's backoff).
 *
 * A TERMINAL row is not automatically past stopping (audit 2026-08-29
 * CRITICAL-2). When a START job dies outside the worker, the dead-job handler
 * marks the session ERROR and KEEPS its pid, because the `-stream_loop -1`
 * ffmpeg it was supervising outlives the worker that spawned it.
 * Blanket-409ing ERROR sealed the only door to that process: the worker's kill
 * ladder is reachable ONLY through a stop job. So the terminal check now asks
 * about the PROCESS rather than the status — a row whose pid has never been
 * proven gone is stoppable. LC-02 adds the second repair target: a terminal
 * held publisher claim. A stop releases it only when process-gone proof is
 * already present; without proof it stays held, but the operator can retry the
 * one path that performs that guarded repair. Only a terminal row with neither
 * target 409s.
 *
 * Unlike live-channel stop there is no route-side status claim: the enum
 * has no STOPPING state (flipping to STOPPED here would lie while ffmpeg
 * still pushes), so stop is worker-claimed — the in-process supervisor
 * registry plus the process-free no-op make it idempotent. Concurrent
 * stops (route + channel-stop coupling) collapse on the constant
 * `<id>:stop` jobId. That used to be justified by "sessions are terminal
 * after one stop, so the completed-job-id reuse caveat cannot bite here" —
 * a premise the reclaim path above retires, since a terminal session can
 * still own a pushing ffmpeg and the reclaim IS a second stop. So the
 * shared core helper removes a SETTLED job parked under that id — failed
 * or completed — before adding: BullMQ would otherwise treat it as
 * "already enqueued" and silently swallow the retry.
 */
const actionSchema = z.object({ action: z.literal("stop") });

export async function POST(req: Request, { params }: RouteParams) {
	const { id } = await params;
	const invalid = invalidIdResponse(id);
	if (invalid) {
		return invalid;
	}
	const body = actionSchema.safeParse(await readJson(req));
	if (!body.success) {
		return validationError(body.error);
	}
	try {
		const ctx = await getServerContext();
		const row = await ctx.prisma.feederSession.findUnique({
			where: { id },
			select: {
				id: true,
				status: true,
				// The stop decision reads the PROCESS ledger, not the status.
				pid: true,
				processGoneAt: true,
				publisherClaimedAt: true,
				publisherReleasedAt: true,
			},
		});
		if (!row) {
			return jsonError(404, "Not found");
		}
		if (
			(row.status === "STOPPED" || row.status === "ERROR") &&
			!feederProcessMayBeAlive(row) &&
			!feederPublisherClaimHeld(row)
		) {
			return jsonError(
				409,
				`Session is already terminal (status: ${row.status}) and holds no process that could still be running and no publisher claim to repair`,
				customerErrorDetails("FEEDER_STOP_NOT_NEEDED", {
					status: row.status,
				}),
			);
		}
		await enqueueFeederJob(getFeederQueue(), {
			feederSessionId: id,
			action: "stop",
		});
		return NextResponse.json({ id, action: "stop", status: row.status });
	} catch (err) {
		return routeError(err);
	}
}
