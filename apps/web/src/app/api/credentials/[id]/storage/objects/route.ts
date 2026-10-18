import type { ObjectStorageBrowser } from "@bitovp/storage";
import { searchObjects, UnsupportedBrowseError } from "@bitovp/storage";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerContext } from "@/lib/server/context";
import {
	invalidIdResponse,
	jsonError,
	routeError,
	validationError,
} from "@/lib/server/http";
import {
	browserForCredentialId,
	storageErrorResponse,
} from "@/lib/server/storage";

type RouteParams = { params: Promise<{ id: string }> };

const querySchema = z.object({
	bucket: z.string().min(1, "bucket is required"),
	prefix: z.string().optional(),
	cursor: z.string().optional(),
	limit: z.coerce.number().int().min(1).max(100).optional(),
	/**
	 * Either search param switches the route from one folder listing to a
	 * BOUNDED recursive scan under `prefix` (searchObjects caps pages walked and
	 * matches returned, and reports whether the answer is complete). Capped
	 * lengths because no object name is longer than this.
	 */
	search: z.string().min(1).max(256).optional(),
	ext: z.string().min(1).max(32).optional(),
});

export async function GET(req: Request, { params }: RouteParams) {
	const { id } = await params;
	const invalid = invalidIdResponse(id);
	if (invalid) {
		return invalid;
	}
	const url = new URL(req.url);
	const parsed = querySchema.safeParse({
		bucket: url.searchParams.get("bucket") ?? undefined,
		prefix: url.searchParams.get("prefix") ?? undefined,
		cursor: url.searchParams.get("cursor") ?? undefined,
		limit: url.searchParams.get("limit") ?? undefined,
		// A cleared search box sends "search=" — that is "not searching", not a
		// validation error.
		search: url.searchParams.get("search") || undefined,
		ext: url.searchParams.get("ext") || undefined,
	});
	if (!parsed.success) {
		return validationError(parsed.error);
	}
	// Explicit, not `Awaited<ReturnType<typeof browserForCredentialId>>`: that alias
	// resolves to the widest overload and so includes the `"stopped"` sentinel this
	// route can never receive, leaving `browser.…` type-safe only for as long as
	// control-flow analysis carries the narrowing across the try/catch below.
	let browser: ObjectStorageBrowser | null;
	try {
		const ctx = await getServerContext();
		browser = await browserForCredentialId(ctx, id);
	} catch (err) {
		return err instanceof UnsupportedBrowseError
			? storageErrorResponse(err)
			: routeError(err);
	}
	if (!browser) {
		return jsonError(404, "Not found");
	}
	try {
		const { search, ext, ...list } = parsed.data;
		const result =
			search || ext
				? await searchObjects(browser, { ...list, search, extension: ext })
				: await browser.listObjects(list);
		return NextResponse.json(result);
	} catch (err) {
		return storageErrorResponse(err);
	} finally {
		browser.dispose?.();
	}
}
