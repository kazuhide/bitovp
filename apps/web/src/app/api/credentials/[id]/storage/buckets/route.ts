import type { ObjectStorageBrowser } from "@bitovp/storage";
import { UnsupportedBrowseError } from "@bitovp/storage";
import { NextResponse } from "next/server";
import { getServerContext } from "@/lib/server/context";
import { invalidIdResponse, jsonError, routeError } from "@/lib/server/http";
import {
	browserForCredentialId,
	storageErrorResponse,
} from "@/lib/server/storage";

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: RouteParams) {
	const { id } = await params;
	const invalid = invalidIdResponse(id);
	if (invalid) {
		return invalid;
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
		const buckets = await browser.listBuckets();
		return NextResponse.json({ buckets });
	} catch (err) {
		return storageErrorResponse(err);
	} finally {
		browser.dispose?.();
	}
}
