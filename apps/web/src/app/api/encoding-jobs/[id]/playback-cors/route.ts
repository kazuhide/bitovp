import { describeStorageError, UnsupportedBrowseError } from "@bitovp/storage";
import { NextResponse } from "next/server";
import { getServerContext } from "@/lib/server/context";
import { invalidIdResponse, jsonError, routeError } from "@/lib/server/http";
import {
	pageOrigin,
	playbackCorsForManifest,
} from "@/lib/server/playback-cors";
import { clientKey, createFixedWindowLimiter } from "@/lib/server/rate-limit";
import { storageErrorResponse } from "@/lib/server/storage";

type RouteParams = { params: Promise<{ id: string }> };

/**
 *  residual (b): this route decrypts a storage credential and calls
 * S3 per request, and was the named un-limited gap after row 33 unified every
 * other limiter. 30/min — the bulk-ops family's number, NOT storage-
 * inspections' derived 20 (review-181 I1 caught the first comment borrowing
 * that citation without its derivation). Basis on the CALL side: diagnoseNow
 * is one-shot per source, fires only from error handlers, and its deps are
 * primitives so the job poll cannot re-arm it — a successful play costs zero
 * requests and a realistic burst is single digits. Per-INSTALL until
 * TRUSTED_PROXY_HOPS is set (row 33), so all operators share the 30.
 */
const limiter = createFixedWindowLimiter({ limit: 30, windowMs: 60_000 });

/**
 * Whether a manifest's bucket is configured for in-browser playback
 * . Public-read does not imply CORS, and the
 * measured gap on the real bucket was `Access-Control-Expose-Headers` — so this
 * turns the most likely playback failure into a named prerequisite.
 *
 * Its own route, not part of the job payload: it makes an outbound storage call
 * and the job route is polled every 5s while an encoding runs. Prerequisites
 * only matter when someone tries to play something, so the player asks then.
 */
export async function GET(req: Request, { params }: RouteParams) {
	if (!limiter.check(clientKey(req))) {
		return jsonError(429, "Too many requests");
	}
	const { id } = await params;
	const invalid = invalidIdResponse(id);
	if (invalid) {
		return invalid;
	}
	const manifestKey = new URL(req.url).searchParams.get("manifestKey");
	if (!manifestKey) {
		return jsonError(400, "manifestKey is required");
	}
	try {
		return NextResponse.json(
			await playbackCorsForManifest(await getServerContext(), {
				scope: "vod",
				id,
				manifestKey,
				origin: pageOrigin(req),
			}),
		);
	} catch (err) {
		// An upstream storage failure carries an HTTP status (the shared
		// classifier reads it); anything without one is ours, and `routeError`
		// keeps its message out of the response.
		if (
			err instanceof UnsupportedBrowseError ||
			describeStorageError(err).status !== undefined
		) {
			return storageErrorResponse(err);
		}
		return routeError(err);
	}
}
