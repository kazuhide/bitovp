import { LiveStandbyPoolRequest } from "@bitmovin/api-sdk";
import { NextResponse } from "next/server";
import { z } from "zod";
import { accountQuerySchema, sanitizePage } from "@/lib/infrastructure/schemas";
import {
	sanitizeStandbyPool,
	sanitizeStandbyPoolDetails,
	standbyPoolCreateSchema,
} from "@/lib/live-runtime/schemas";
import { fromBase64, toBase64 } from "@/lib/server/base64";
import {
	auditedBitmovinCall,
	bitmovinClientForAccount,
	bitmovinProxyError,
} from "@/lib/server/bitmovin";
import { getServerContext } from "@/lib/server/context";
import {
	jsonError,
	readJson,
	routeError,
	validationError,
} from "@/lib/server/http";

/**
 * Live standby pools keep a set of live encodings pre-started and idling so a
 * channel can go live in seconds: you `acquire` one and get its ingest points
 * and manifest URLs back immediately.
 *
 * GET — list. **Documented C6 EXCEPTION:** unlike every other Bitmovin list,
 * `encoding.live.standbyPools.list` takes NO query parameters at all (verified
 * in the SDK: `list: Promise<PaginationResponse<LiveStandbyPoolResponse>>`,
 * with no *ListQueryParams type generated). There is therefore no offset/limit
 * to clamp and no way to page — whatever the API returns in one shot is all we
 * can show. `totalCount` from the envelope is surfaced so the UI can disclose a
 * truncation if the API ever imposes an implicit page size. The pool ENCODINGS
 * and LOGS sub-lists DO take offset/limit and are clamped normally.
 */
export async function GET(req: Request) {
	const url = new URL(req.url);
	const query = accountQuerySchema.safeParse({
		bitmovinAccountId: url.searchParams.get("bitmovinAccountId") ?? undefined,
	});
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
			const page = await api.encoding.live.standbyPools.list();
			return NextResponse.json(sanitizePage(page, sanitizeStandbyPool));
		} catch (apiErr) {
			return bitmovinProxyError(apiErr);
		}
	} catch (err) {
		return routeError(err);
	}
}

const bodySchema = z.strictObject({
	bitmovinAccountId: z.uuid(),
	pool: standbyPoolCreateSchema,
});

/**
 * POST — create a pool. `encodingTemplate` arrives as PLAIN template text and is
 * base64-encoded here, because `LiveStandbyPoolRequest.encodingTemplate` is
 * documented base64 on the wire. Doing it server-side keeps the client form a
 * plain textarea and means a copy-pasted template can never be double-encoded.
 */
export async function POST(req: Request) {
	const parsed = bodySchema.safeParse(await readJson(req));
	if (!parsed.success) {
		return validationError(parsed.error);
	}
	const { bitmovinAccountId, pool } = parsed.data;
	try {
		const ctx = await getServerContext();
		const api = await bitmovinClientForAccount(ctx, bitmovinAccountId);
		if (!api) {
			return jsonError(404, "Bitmovin account not found");
		}
		const outcome = await auditedBitmovinCall({
			req,
			ctx,
			bitmovinAccountId,
			method: "POST",
			path: "/encoding/live/standby-pools",
			// The template is an encoding definition, not a credential — but it can
			// be hundreds of KB, so the audit row records its size, not its body.
			request: {
				name: pool.name,
				...(pool.description ? { description: pool.description } : {}),
				targetPoolSize: pool.targetPoolSize,
				encodingTemplateChars: pool.encodingTemplate.length,
			},
			call: () =>
				api.encoding.live.standbyPools.create(
					new LiveStandbyPoolRequest({
						name: pool.name,
						...(pool.description ? { description: pool.description } : {}),
						targetPoolSize: pool.targetPoolSize,
						encodingTemplate: toBase64(pool.encodingTemplate),
					}),
				),
			responseSnapshot: (result) => sanitizeStandbyPool(result),
		});
		if (!outcome.ok) {
			return outcome.response;
		}
		// create returns LiveStandbyPoolDetails (template included) — echo the
		// decoded template so the caller can confirm what was stored.
		return NextResponse.json(
			sanitizeStandbyPoolDetails(outcome.result, fromBase64),
			{ status: 201 },
		);
	} catch (err) {
		return routeError(err);
	}
}
