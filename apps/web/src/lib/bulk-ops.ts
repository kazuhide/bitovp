import { z } from "zod";

/**
 * Shared contract for the bulk job/report routes (bulk-re-run, bulk-cancel,
 * bulk-delete × 2).
 *
 * ONE cap and ONE body schema for all of them, imported by both the routes and
 * the selection bars, so the server's 400 boundary and the UI's disabled state
 * can never drift (same reasoning as the shared `isActiveJobStatus` /
 * `isActiveChannelStatus` status helpers).
 *
 * Client-safe (no `server-only`): the list clients import MAX_BULK_IDS to gate
 * their action bars and the result types to render the per-id outcome summary.
 */

/** Bulk cap: keep one request bounded (the UI also gates selection size). */
export const MAX_BULK_IDS = 50;

export const bulkIdsSchema = z.object({
	ids: z.array(z.uuid()).min(1).max(MAX_BULK_IDS),
});

/**
 * Deduplicates the request's ids. A doubled selection (e.g. the same row picked
 * through two filters) must act on each target exactly ONCE — for cancel that
 * keeps the atomic claim's 409-on-second-attempt semantics from reporting a
 * bogus "skipped" for an id we ourselves just claimed.
 *
 * CASE-FOLDED, and that is the whole point. `z.uuid` accepts either case,
 * Postgres `@db.Uuid` normalizes on the way in, so `A1B2…` and `a1b2…` are ONE
 * row — but a plain `new Set` treats them as two entries and the batch acts on
 * that row twice. A v4 UUID carries 12–16 hex letters, so 50 spellings of a
 * single id fit inside MAX_BULK_IDS trivially. The worst case is bulk-re-run,
 * where each duplicate is a REAL billable Bitmovin encoding of the same source.
 *
 * Returns the canonical lowercase form, which is also what the DB rows carry —
 * so the per-id outcomes the routes echo back match the ids the list UI holds.
 */
export function dedupeIds(ids: readonly string[]): string[] {
	return [...new Set(ids.map((id) => id.toLowerCase()))];
}

/** One id the batch deliberately did not act on, with the operator-facing why. */
export type BulkSkip = { id: string; reason: string };

/** POST /api/encoding-jobs/bulk-cancel */
export type BulkCancelResult = {
	/** Ids whose `cancelRequested` flag this request claimed (false → true). */
	canceled: string[];
	skipped: BulkSkip[];
};

/** POST /api/encoding-jobs/bulk-delete · POST /api/vmaf-jobs/bulk-delete */
export type BulkDeleteResult = {
	deleted: string[];
	skipped: BulkSkip[];
};

/** Compact "3 canceled, 1 skipped" summary shared by the selection bars. */
export function bulkSummary(
	done: number,
	skipped: number,
	verb: string,
): string {
	return skipped > 0
		? `${done} ${verb}, ${skipped} skipped`
		: `${done} ${verb}`;
}
