import { NextResponse } from "next/server";
import {
	accountQuerySchema,
	type CloudProviderId,
	isCloudProvider,
	sanitizeCloudAccount,
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

/** GET — account details (response allowlisted; secrets never round-trip). */
export async function GET(req: Request, { params }: RouteParams) {
	const p = await params;
	const resolved = resolve(p.provider, p.infrastructureId);
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
			const account = await cloudAccountOps(api, resolved.provider).get(
				resolved.infrastructureId,
			);
			return NextResponse.json(
				sanitizeCloudAccount(resolved.provider, account),
			);
		} catch (apiErr) {
			return bitmovinProxyError(apiErr);
		}
	} catch (err) {
		return routeError(err);
	}
}

/** DELETE — Cloud Connect has no update API; the UI flow is delete + re-create. */
export async function DELETE(req: Request, { params }: RouteParams) {
	const p = await params;
	const resolved = resolve(p.provider, p.infrastructureId);
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
			path: `/encoding/infrastructure/${resolved.provider}/${resolved.infrastructureId}`,
			call: () =>
				cloudAccountOps(api, resolved.provider).del(resolved.infrastructureId),
		});
		if (!outcome.ok) {
			return outcome.response;
		}
		return NextResponse.json(
			sanitizeCloudAccount(resolved.provider, outcome.result),
		);
	} catch (err) {
		return routeError(err);
	}
}
