import { StreamKey, type StreamKeyType } from "@bitmovin/api-sdk";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
	auditSnapshot,
	listQuerySchema,
	sanitizePage,
} from "@/lib/infrastructure/schemas";
import {
	sanitizeStreamKey,
	sanitizeStreamKeyListItem,
	streamKeyCreateSchema,
	streamKeyListQuerySchema,
} from "@/lib/live-runtime/schemas";
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
 * Reserved stream keys: account-level ingest credentials that survive across
 * live encodings, so a contribution encoder can be configured once and re-used.
 * A key is ASSIGNED while an encoding holds it and UNASSIGNED otherwise;
 * RESERVED keys are the ones you create here, TEMPORARY ones are minted by
 * Bitmovin for a single encoding.
 *
 * GET — list (C6 paging) with the SDK's type/status/assignedEncodingId filters.
 */
export async function GET(req: Request) {
	const url = new URL(req.url);
	const query = listQuerySchema.safeParse({
		bitmovinAccountId: url.searchParams.get("bitmovinAccountId") ?? undefined,
		offset: url.searchParams.get("offset") ?? undefined,
		limit: url.searchParams.get("limit") ?? undefined,
	});
	if (!query.success) {
		return validationError(query.error);
	}
	const filters = streamKeyListQuerySchema.safeParse({
		type: url.searchParams.get("type") ?? undefined,
		status: url.searchParams.get("status") ?? undefined,
		assignedEncodingId: url.searchParams.get("assignedEncodingId") ?? undefined,
	});
	if (!filters.success) {
		return validationError(filters.error);
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
			const page = await api.encoding.live.streamKeys.list({
				offset: query.data.offset,
				limit: query.data.limit,
				...filters.data,
			});
			// LIST withholds `value` — revealing is a per-key GET (review M6).
			return NextResponse.json(sanitizePage(page, sanitizeStreamKeyListItem));
		} catch (apiErr) {
			return bitmovinProxyError(apiErr);
		}
	} catch (err) {
		return routeError(err);
	}
}

const bodySchema = z.strictObject({
	bitmovinAccountId: z.uuid(),
	streamKey: streamKeyCreateSchema,
});

/**
 * POST — reserve a stream key. Omit `value` and Bitmovin generates a secure
 * random one (recommended: a guessable key lets anyone push to your encoding).
 *
 * AUDIT CARE — the key material is called `value` on this model, and `value` is
 * NOT matched by redactSecrets' SENSITIVE_SUFFIX (only `*key`-suffixed names
 * like the LiveChannel.streamKey column and LiveStandbyPoolEncodingIngestPoint
 * .streamKey are). The backstop therefore does NOT cover it, so both audit
 * snapshots are hand-built with a `valueProvided` presence flag (the PR-2
 * auditSnapshot precedent) and `value` is excluded from them outright. It stays
 * in the HTTP RESPONSE — the ledgered display exception, same as
 * LiveChannel.streamKey.
 */
export async function POST(req: Request) {
	const parsed = bodySchema.safeParse(await readJson(req));
	if (!parsed.success) {
		return validationError(parsed.error);
	}
	const { bitmovinAccountId, streamKey } = parsed.data;
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
			path: "/encoding/live/stream-keys",
			request: auditSnapshot(streamKey, ["value"]),
			call: () => {
				const { type, ...rest } = streamKey;
				return api.encoding.live.streamKeys.create(
					new StreamKey({
						...rest,
						...(type ? { type: type as StreamKeyType } : {}),
					}),
				);
			},
			responseSnapshot: (result) =>
				auditSnapshot(sanitizeStreamKey(result), ["value"]),
		});
		if (!outcome.ok) {
			return outcome.response;
		}
		return NextResponse.json(sanitizeStreamKey(outcome.result), {
			status: 201,
		});
	} catch (err) {
		return routeError(err);
	}
}
