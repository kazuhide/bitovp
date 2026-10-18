import { NextResponse } from "next/server";
import {
	accountQuerySchema,
	type CloudProviderId,
	isCloudProvider,
	PROVIDER_REGIONS,
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
	routeError,
	validationError,
} from "@/lib/server/http";
import { cloudAccountOps } from "@/lib/server/infrastructure-sdk";

type RouteParams = {
	params: Promise<{
		provider: string;
		infrastructureId: string;
		region: string;
	}>;
};

type Resolved =
	| { provider: CloudProviderId; infrastructureId: string; region: string }
	| NextResponse;

function resolve(
	provider: string,
	infrastructureId: string,
	region: string,
): Resolved {
	if (!isCloudProvider(provider)) {
		return jsonError(404, `Unknown Cloud Connect provider "${provider}"`);
	}
	const invalid = invalidIdResponse(infrastructureId);
	if (invalid) {
		return invalid;
	}
	if (!PROVIDER_REGIONS[provider].includes(region)) {
		return jsonError(404, `Unknown ${provider} region "${region}"`);
	}
	return { provider, infrastructureId, region };
}

/** GET — region settings details. */
export async function GET(req: Request, { params }: RouteParams) {
	const p = await params;
	const resolved = resolve(p.provider, p.infrastructureId, p.region);
	if (resolved instanceof NextResponse) {
		return resolved;
	}
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
			const settings = await cloudAccountOps(
				api,
				resolved.provider,
			).regions.get(resolved.infrastructureId, resolved.region);
			return NextResponse.json(
				sanitizeRegionSettings(resolved.provider, settings),
			);
		} catch (apiErr) {
			return bitmovinProxyError(apiErr);
		}
	} catch (err) {
		return routeError(err);
	}
}

/** DELETE — remove region settings (no update API: delete + re-create). */
export async function DELETE(req: Request, { params }: RouteParams) {
	const p = await params;
	const resolved = resolve(p.provider, p.infrastructureId, p.region);
	if (resolved instanceof NextResponse) {
		return resolved;
	}
	const url = new URL(req.url);
	const query = accountQuerySchema.safeParse({
		bitmovinAccountId: url.searchParams.get("bitmovinAccountId") ?? undefined,
	});
	if (!query.success) {
		return validationError(query.error);
	}
	const { bitmovinAccountId } = query.data;
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
			method: "DELETE",
			path: `/encoding/infrastructure/${resolved.provider}/${resolved.infrastructureId}/regions/${resolved.region}`,
			call: () =>
				cloudAccountOps(api, resolved.provider).regions.del(
					resolved.infrastructureId,
					resolved.region,
				),
		});
		if (!outcome.ok) {
			return outcome.response;
		}
		return NextResponse.json(
			sanitizeRegionSettings(resolved.provider, outcome.result),
		);
	} catch (err) {
		return routeError(err);
	}
}
