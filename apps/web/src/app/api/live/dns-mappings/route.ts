import { DnsMappingRequest } from "@bitmovin/api-sdk";
import { NextResponse } from "next/server";
import { z } from "zod";
import { roleAtLeast } from "@/lib/auth/roles";
import {
	LIST_LIMIT_MAX,
	listQuerySchema,
	sanitizePage,
} from "@/lib/infrastructure/schemas";
import {
	dnsMappingCreateSchema,
	sanitizeDnsMapping,
} from "@/lib/live-runtime/schemas";
import {
	auditedBitmovinCall,
	bitmovinClientForAccount,
	bitmovinProxyError,
} from "@/lib/server/bitmovin";
import { sameConfirmedResourceIds } from "@/lib/server/confirmed-resource-ids";
import { getServerContext } from "@/lib/server/context";
import {
	jsonError,
	readJson,
	routeError,
	validationError,
} from "@/lib/server/http";

/**
 * DNS ingest mappings: a stable `<subdomain>.<bitmovin zone>` hostname that
 * resolves to a live encoder's IP, so a contribution encoder can be pointed at
 * a name instead of an address that changes on every (re)start.
 *
 * SDK SHAPE (verified in @bitmovin/api-sdk 1.269.0 — deviates from a purely
 * account-level CRUD): `encoding.live.dnsMappings` exposes **list ONLY**.
 * create / get / delete / deleteAll live on the PER-ENCODING api
 * (`encoding.live.encodings.dnsMappings`) and all take an encodingId, because a
 * mapping only means something while it points at an encoding. So:
 *   GET  — account-wide list, or this-encoding list when `encodingId` is given
 *   POST — REQUIRES `encodingId` in the body
 *   DELETE — removes the confirmed mappings for one encoding by ID
 *   DELETE (./[id]) — removes a single mapping
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
	const scope = z
		.object({ encodingId: z.uuid("encodingId must be a UUID").optional() })
		.safeParse({
			encodingId: url.searchParams.get("encodingId") ?? undefined,
		});
	if (!scope.success) {
		return validationError(scope.error);
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
		const paging = { offset: query.data.offset, limit: query.data.limit };
		try {
			const page = scope.data.encodingId
				? await api.encoding.live.encodings.dnsMappings.list(
						scope.data.encodingId,
						paging,
					)
				: await api.encoding.live.dnsMappings.list(paging);
			return NextResponse.json(sanitizePage(page, sanitizeDnsMapping));
		} catch (apiErr) {
			return bitmovinProxyError(apiErr);
		}
	} catch (err) {
		return routeError(err);
	}
}

const bodySchema = z.strictObject({
	bitmovinAccountId: z.uuid(),
	dnsMapping: dnsMappingCreateSchema,
});

/** POST — map a subdomain onto one encoding's ingest IP. */
export async function POST(req: Request) {
	const parsed = bodySchema.safeParse(await readJson(req));
	if (!parsed.success) {
		return validationError(parsed.error);
	}
	const { bitmovinAccountId, dnsMapping } = parsed.data;
	const { encodingId, ...request } = dnsMapping;
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
			path: `/encoding/live/encodings/${encodingId}/dns-mappings`,
			// A hostname mapping carries no secrets.
			request: dnsMapping,
			call: () =>
				api.encoding.live.encodings.dnsMappings.create(
					encodingId,
					new DnsMappingRequest(request),
				),
			responseSnapshot: (result) => sanitizeDnsMapping(result),
		});
		if (!outcome.ok) {
			return outcome.response;
		}
		return NextResponse.json(sanitizeDnsMapping(outcome.result), {
			status: 201,
		});
	} catch (err) {
		return routeError(err);
	}
}

const bulkDeleteSchema = z.strictObject({
	bitmovinAccountId: z.uuid(),
	encodingId: z.uuid(),
	confirmMappingIds: z
		.array(z.uuid())
		.min(1)
		.max(LIST_LIMIT_MAX)
		.refine(
			(ids) => new Set(ids).size === ids.length,
			"Mapping ids must be distinct",
		),
});

export async function DELETE(req: Request) {
	const parsed = bulkDeleteSchema.safeParse(await readJson(req));
	if (!parsed.success) return validationError(parsed.error);
	const { bitmovinAccountId, encodingId, confirmMappingIds } = parsed.data;
	try {
		const ctx = await getServerContext();
		if (
			!ctx.tenant ||
			ctx.tenant.isImpersonating ||
			!roleAtLeast(ctx.tenant.role, "OPERATOR")
		)
			return jsonError(403, "Operator access required.");
		const api = await bitmovinClientForAccount(
			ctx,
			bitmovinAccountId,
			AbortSignal.timeout(15_000),
		);
		if (!api) return jsonError(404, "Bitmovin account not found");

		let page: Awaited<
			ReturnType<typeof api.encoding.live.encodings.dnsMappings.list>
		>;
		try {
			page = await api.encoding.live.encodings.dnsMappings.list(encodingId, {
				limit: LIST_LIMIT_MAX,
				offset: 0,
			});
		} catch (error) {
			return bitmovinProxyError(error);
		}
		if (
			!Array.isArray(page.items) ||
			page.totalCount !== page.items.length ||
			(page.offset !== undefined && page.offset !== 0) ||
			page.items.some(
				(mapping) =>
					mapping.encodingId !== undefined && mapping.encodingId !== encodingId,
			) ||
			!sameConfirmedResourceIds(
				page.items.map((mapping) => mapping.id),
				confirmMappingIds,
			)
		)
			return jsonError(
				409,
				"The DNS mappings changed. Refresh the list before removing them.",
			);
		const ids: string[] = [];
		const unresolvedIds: string[] = [];
		for (const id of confirmMappingIds) {
			const outcome = await auditedBitmovinCall({
				req,
				ctx,
				bitmovinAccountId,
				method: "DELETE",
				path: `/encoding/live/encodings/${encodingId}/dns-mappings/${id}`,
				call: async () => {
					const result = await api.encoding.live.encodings.dnsMappings.delete(
						encodingId,
						id,
					);
					if (result.id !== id)
						throw Object.assign(
							new Error("Unexpected DNS mapping response ID"),
							{
								httpStatusCode: 502,
								shortMessage: "Unexpected DNS mapping response ID",
							},
						);
					return result;
				},
			});
			(outcome.ok ? ids : unresolvedIds).push(id);
		}
		return NextResponse.json(
			{ ids, unresolvedIds },
			{
				status: unresolvedIds.length ? 207 : 200,
			},
		);
	} catch (error) {
		return routeError(error);
	}
}
