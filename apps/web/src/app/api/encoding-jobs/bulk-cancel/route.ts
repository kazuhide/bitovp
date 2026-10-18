import { NextResponse } from "next/server";
import {
	type BulkCancelResult,
	type BulkSkip,
	bulkIdsSchema,
	dedupeIds,
} from "@/lib/bulk-ops";
import { getServerContext } from "@/lib/server/context";
import {
	jsonError,
	readJson,
	routeError,
	validationError,
} from "@/lib/server/http";
import { clientKey, createFixedWindowLimiter } from "@/lib/server/rate-limit";

/**
 * Cheap per id (one guarded DB flag flip, no Bitmovin call), so the cap is
 * about DB write amplification rather than cost: 30/min is far past a list
 * UI's click rate — cancelling is a deliberate, confirmed action — while
 * bounding a loop to 1500 row-updates/min. Per-process, per-client-IP.
 */
const limiter = createFixedWindowLimiter({ limit: 30, windowMs: 60_000 });

/**
 * Bulk cooperative cancel  — N × the single-job cancel route, with
 * EXACTLY its semantics per id:
 *
 *  - the atomic claim IS the lock: `updateMany` matching only QUEUED|RUNNING
 *    rows that are not already cancel-requested, writing ONLY `cancelRequested`.
 *    `status` is never in `data` — the orchestrator worker is the single writer
 *    of `status` and owns the terminal CANCELED transition;
 *  - a 0-count claim (terminal, already canceling, DRAFT, or gone) is not an
 *    error: the id lands in `skipped` with its reason, mirroring the single
 *    route's 409 message;
 *  - partial failure is isolated like bulk-re-run: one id's DB error is reported
 *    against that id and the remaining ids still run.
 *
 * Ids are deduplicated first — the claim is one-shot, so a doubled selection
 * would otherwise report its own second attempt as "already canceling".
 *
 * No MASTER_KEY check (unlike bulk-re-run): this is a pure DB flag flip; the
 * worker, which does need the key, owns the cancel finalize.
 */
export async function POST(req: Request) {
	if (!limiter.check(clientKey(req))) {
		return jsonError(429, "Too many requests");
	}
	const body = bulkIdsSchema.safeParse(await readJson(req));
	if (!body.success) {
		return validationError(body.error);
	}
	const ids = dedupeIds(body.data.ids);
	try {
		const ctx = await getServerContext();
		const canceled: string[] = [];
		const skipped: BulkSkip[] = [];
		for (const id of ids) {
			try {
				const { count } = await ctx.prisma.encodingJob.updateMany({
					where: {
						id,
						status: { in: ["QUEUED", "RUNNING"] },
						cancelRequested: false,
					},
					data: { cancelRequested: true },
				});
				if (count === 0) {
					skipped.push({
						id,
						reason:
							"Job is not cancelable (already finished, canceled, or canceling)",
					});
					continue;
				}
				canceled.push(id);
			} catch (cancelErr) {
				// UNEXPECTED (the ordinary "not cancelable" outcome is the 0-count
				// claim above). Isolating it must not also hide it: log server-side
				// like routeError would, then report it against this id only.
				console.error(
					`[api] bulk-cancel failed for job ${id}:`,
					cancelErr instanceof Error
						? `${cancelErr.name}: ${cancelErr.message}`
						: cancelErr,
				);
				skipped.push({
					id,
					reason: "Cancel failed",
				});
			}
		}
		const result: BulkCancelResult = { canceled, skipped };
		return NextResponse.json(result);
	} catch (err) {
		return routeError(err);
	}
}
