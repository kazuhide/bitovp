import { NextResponse } from "next/server";
import {
	type BulkDeleteResult,
	type BulkSkip,
	bulkIdsSchema,
	dedupeIds,
} from "@/lib/bulk-ops";
import { getServerContext } from "@/lib/server/context";
import { deleteVmafJobLocally } from "@/lib/server/delete-jobs";
import { requireQcVmafEnabled } from "@/lib/server/feature-flags";
import {
	jsonError,
	readJson,
	routeError,
	validationError,
} from "@/lib/server/http";
import { clientKey, createFixedWindowLimiter } from "@/lib/server/rate-limit";

const VIA = "/api/vmaf-jobs/bulk-delete";

/**
 * Same shape and cost as the encoding-job bulk delete (audited transaction per
 * id, frame results cascading by FK), so the same 30/min bound. Per-process,
 * per-client-IP.
 */
const limiter = createFixedWindowLimiter({ limit: 30, windowMs: 60_000 });

/**
 * Bulk delete of terminal VMAF reports — N × the single-report DELETE, running
 * the SAME shared `deleteVmafJobLocally` pipeline per id (atomic terminal-guard
 * on FINISHED|ERROR; frame results cascade by FK). LOCAL records only — VMAF is
 * our own libvmaf pipeline, so there is no Bitmovin resource at all.
 *
 * Each deletion is audited individually, and partial failure is isolated exactly
 * like the encoding-job bulk routes: a PENDING/RUNNING report is skipped with
 * the single route's own 409 message while the rest are deleted.
 */
export async function POST(req: Request) {
	// : OFF means this surface does not exist for the deployment.
	// The recovery pair (qc-override, qc-report) is deliberately NOT gated.
	const disabled = await requireQcVmafEnabled();
	if (disabled) {
		return disabled;
	}
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
		const deleted: string[] = [];
		const skipped: BulkSkip[] = [];
		for (const id of ids) {
			try {
				const outcome = await deleteVmafJobLocally(ctx, id, {
					via: VIA,
					req,
				});
				if (outcome.ok) {
					deleted.push(id);
				} else {
					skipped.push({ id, reason: outcome.message });
				}
			} catch (deleteErr) {
				// UNEXPECTED (not-found / still-scoring / lost-race are typed
				// outcomes above). Isolating it must not also hide it.
				console.error(
					`[api] vmaf bulk-delete failed for report ${id}:`,
					deleteErr instanceof Error
						? `${deleteErr.name}: ${deleteErr.message}`
						: deleteErr,
				);
				skipped.push({
					id,
					// Fixed string, matching `http.ts`'s policy for unexpected errors:
					// the detail is in the console.error above, not on the wire. The
					// per-id routes have always done this; the bulk routes were
					// leaking `err.message` instead (review catch).
					reason: "Delete failed",
				});
			}
		}
		const result: BulkDeleteResult = { deleted, skipped };
		return NextResponse.json(result);
	} catch (err) {
		return routeError(err);
	}
}
