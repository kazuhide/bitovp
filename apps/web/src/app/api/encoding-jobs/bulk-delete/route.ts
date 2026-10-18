import { NextResponse } from "next/server";
import {
	type BulkDeleteResult,
	type BulkSkip,
	bulkIdsSchema,
	dedupeIds,
} from "@/lib/bulk-ops";
import { getServerContext } from "@/lib/server/context";
import { deleteEncodingJobLocally } from "@/lib/server/delete-jobs";
import {
	jsonError,
	readJson,
	routeError,
	validationError,
} from "@/lib/server/http";
import { clientKey, createFixedWindowLimiter } from "@/lib/server/rate-limit";

const VIA = "/api/encoding-jobs/bulk-delete";

/**
 * Local DB deletes (no Bitmovin call, nothing in object storage), but each id
 * runs an audited transaction with dependent cascades — write amplification an
 * unattended loop should not get for free. 30/min is well past a list UI's
 * rate for a confirmed destructive action. Per-process, per-client-IP.
 */
const limiter = createFixedWindowLimiter({ limit: 30, windowMs: 60_000 });

/**
 * Bulk delete of terminal VOD jobs — N × the single-job DELETE, running the
 * SAME shared `deleteEncodingJobLocally` pipeline per id (atomic
 * terminal-guarded `$transaction`: dependents first, status-guarded parent
 * `deleteMany` whose count is asserted → rollback → that id is skipped with a
 * reason). LOCAL records only: no Bitmovin call, nothing in object storage.
 *
 * Every deletion is audited individually (the audit `path` stays the resource
 * path, with this endpoint recorded as `request.via`) — a bulk delete must leave
 * exactly the same trail as N single deletes.
 *
 * Partial-failure isolated like bulk-re-run: a missing id, an active job, a
 * lost race or an unexpected DB error is reported against that id only; the
 * remaining ids are still deleted.
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
		const deleted: string[] = [];
		const skipped: BulkSkip[] = [];
		for (const id of ids) {
			try {
				const outcome = await deleteEncodingJobLocally(ctx, id, {
					via: VIA,
					req,
				});
				if (outcome.ok) {
					deleted.push(id);
				} else {
					skipped.push({ id, reason: outcome.message });
				}
			} catch (deleteErr) {
				// UNEXPECTED (not-found / still-active / lost-race all come back as
				// typed outcomes above). Isolating it must not also hide it.
				console.error(
					`[api] bulk-delete failed for job ${id}:`,
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
