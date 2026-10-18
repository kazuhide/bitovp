import { NextResponse } from "next/server";
import {
	accountQuerySchema,
	LIST_LIMIT_MAX,
} from "@/lib/infrastructure/schemas";
import { type InputDto, sanitizeInput } from "@/lib/live-runtime/schemas";
import {
	bitmovinClientForAccount,
	bitmovinProxyError,
} from "@/lib/server/bitmovin";
import { getServerContext } from "@/lib/server/context";
import { jsonError, routeError, validationError } from "@/lib/server/http";

/**
 * GET /api/live/inputs — every Input resource in the account, projected to
 * `{id, name, type}`.
 *
 * Feeds the insertable-content input picker: registering content names a
 * Bitmovin **Input** id, and `encoding.inputs.list` is the ONE cross-type
 * list (the 19 type-scoped lists would otherwise need a 19-call fan-out —
 * C24). Grouped under `/api/live` beside `rtmp-inputs` because the live
 * surfaces are the only consumers today; nothing about the endpoint is
 * live-specific.
 *
 * Unlike the other proxy lists this route DRAINS the C6 pages itself (limit
 * 100 per request) — a picker renders one list and cannot ask the operator to
 * paginate before choosing. `MAX_PAGES` bounds a pathological account; hitting
 * it answers `truncated: true` so the UI can say the list is partial instead
 * of pretending it is complete.
 *
 * "Hitting the cap" is NOT the same as "there is more": an account with exactly
 * `MAX_PAGES × 100` inputs fills the last allowed page and has nothing after
 * it. `InputListQueryParams` carries no `includeTotalCount` (unlike
 * `EncodingListQueryParams`, where the flag exists, defaults false and the
 * SDK's own doc calls setting it "discouraged"), so we cannot ask for the
 * total — but `PaginationResponse.totalCount` is declared optional on every
 * list and does come back here, so when it is present we compare against it
 * and only claim partiality when rows really are unfetched. Absent, the cap
 * stays the fail-safe: over-reporting partial is a paste prompt, while
 * under-reporting hides an input.
 */
const MAX_PAGES = 5;

export async function GET(req: Request) {
	const url = new URL(req.url);
	const query = accountQuerySchema.safeParse({
		bitmovinAccountId: url.searchParams.get("bitmovinAccountId") ?? undefined,
	});
	// : server-side name search (C24 — InputListQueryParams.name).
	// Optional and additive: absent keeps the drain exactly as before.
	const nameFilter = url.searchParams.get("name")?.trim() || undefined;
	if (!query.success) {
		return validationError(query.error);
	}
	try {
		const ctx = await getServerContext();
		const api = await bitmovinClientForAccount(
			ctx,
			query.data.bitmovinAccountId,
		);
		if (!api) {
			return jsonError(404, "Bitmovin account not found");
		}
		try {
			const items: InputDto[] = [];
			let totalCount: number | undefined;
			// Rows RECEIVED, which is what a total is comparable to — `items` drops
			// the id-less ones below, so comparing it against `totalCount` would
			// report a complete list as partial.
			let fetched = 0;
			let truncated = false;
			for (let page = 0; page < MAX_PAGES; page += 1) {
				const result = await api.encoding.inputs.list({
					offset: page * LIST_LIMIT_MAX,
					limit: LIST_LIMIT_MAX,
					...(nameFilter ? { name: nameFilter } : {}),
				});
				if (result.totalCount !== undefined) {
					totalCount = result.totalCount;
				}
				const pageItems = result.items ?? [];
				fetched += pageItems.length;
				for (const item of pageItems) {
					const projected = sanitizeInput(item);
					// An id-less row cannot be picked (nor referenced), so it would
					// only render as an unselectable radio.
					if (typeof projected.id === "string") {
						items.push(projected as InputDto);
					}
				}
				// A short page is the end of the list; a full one may not be.
				if (pageItems.length < LIST_LIMIT_MAX) {
					break;
				}
				truncated =
					page === MAX_PAGES - 1 &&
					(totalCount === undefined || fetched < totalCount);
			}
			return NextResponse.json({
				items,
				...(totalCount !== undefined ? { totalCount } : {}),
				...(truncated ? { truncated: true } : {}),
			});
		} catch (apiErr) {
			return bitmovinProxyError(apiErr);
		}
	} catch (err) {
		return routeError(err);
	}
}
