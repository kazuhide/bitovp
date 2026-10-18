import { NextResponse } from "next/server";
import { z } from "zod";
import {
	type CloudProviderId,
	isCloudProvider,
	listQuerySchema,
	PROVIDER_REGIONS,
	REGION_SETTINGS_SCHEMAS,
	sanitizePage,
	sanitizeRegionSettings,
} from "@/lib/infrastructure/schemas";
import {
	auditedBitmovinCall,
	bitmovinClientForAccount,
	bitmovinProxyError,
} from "@/lib/server/bitmovin";
import { getServerContext } from "@/lib/server/context";
import {
	invalidIdResponse,
	jsonError,
	readJson,
	routeError,
	validationError,
} from "@/lib/server/http";
import { cloudAccountOps } from "@/lib/server/infrastructure-sdk";

type RouteParams = {
	params: Promise<{ provider: string; infrastructureId: string }>;
};

type Resolved =
	| { provider: CloudProviderId; infrastructureId: string }
	| NextResponse;

function resolve(provider: string, infrastructureId: string): Resolved {
	if (!isCloudProvider(provider)) {
		return jsonError(404, `Unknown Cloud Connect provider "${provider}"`);
	}
	return invalidIdResponse(infrastructureId) ?? { provider, infrastructureId };
}

/** GET — list region settings for one Cloud Connect account (C6 paging). */
export async function GET(req: Request, { params }: RouteParams) {
	const p = await params;
	const resolved = resolve(p.provider, p.infrastructureId);
	if (resolved instanceof NextResponse) {
		return resolved;
	}
	const url = new URL(req.url);
	const query = listQuerySchema.safeParse({
		bitmovinAccountId: url.searchParams.get("bitmovinAccountId") ?? undefined,
		offset: url.searchParams.get("offset") ?? undefined,
		limit: url.searchParams.get("limit") ?? undefined,
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
			const page = await cloudAccountOps(api, resolved.provider).regions.list(
				resolved.infrastructureId,
				{ offset: query.data.offset, limit: query.data.limit },
			);
			return NextResponse.json(
				sanitizePage(page, (item) =>
					sanitizeRegionSettings(resolved.provider, item),
				),
			);
		} catch (apiErr) {
			return bitmovinProxyError(apiErr);
		}
	} catch (err) {
		return routeError(err);
	}
}

/**
 * POST — add region settings. `region` rides the body here but becomes the
 * Bitmovin path param (provider-specific enum, validated against the SDK
 * region list). No update API exists — delete + re-create.
 */
export async function POST(req: Request, { params }: RouteParams) {
	const p = await params;
	const resolved = resolve(p.provider, p.infrastructureId);
	if (resolved instanceof NextResponse) {
		return resolved;
	}
	const regions = PROVIDER_REGIONS[resolved.provider] as [string, ...string[]];
	const bodySchema = z.strictObject({
		bitmovinAccountId: z.uuid(),
		region: z.enum(
			regions,
			`region must be one of the ${resolved.provider} regions`,
		),
		settings: REGION_SETTINGS_SCHEMAS[resolved.provider],
	});
	const parsed = bodySchema.safeParse(await readJson(req));
	if (!parsed.success) {
		return validationError(parsed.error);
	}
	const { bitmovinAccountId, region } = parsed.data;
	const settings = parsed.data.settings as Record<string, unknown>;
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
			path: `/encoding/infrastructure/${resolved.provider}/${resolved.infrastructureId}/regions/${region}`,
			// Region settings carry no secret fields — snapshot as-is.
			request: { region, ...settings },
			call: () =>
				cloudAccountOps(api, resolved.provider).regions.create(
					resolved.infrastructureId,
					region,
					settings,
				),
		});
		if (!outcome.ok) {
			return outcome.response;
		}
		return NextResponse.json(
			sanitizeRegionSettings(resolved.provider, outcome.result),
			{ status: 201 },
		);
	} catch (err) {
		return routeError(err);
	}
}
