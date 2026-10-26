import { NextResponse } from "next/server";
import {
	perTitleEncodingImportRequestSchema,
	projectPerTitleEncodingImport,
} from "@/app/vod/new/per-title-encoding-import";
import { authError } from "@/lib/auth/route-context";
import { requireOrganizationAdmin } from "@/lib/auth/tenancy";
import { contextForOrganization } from "@/lib/server/context";
import { createPerTitleEncodingHttpPort } from "@/lib/server/per-title-encoding-http";
import {
	loadPerTitleEncodingSnapshot,
	PerTitleEncodingLoaderError,
} from "@/lib/server/per-title-encoding-loader";
import { readBoundedJson } from "@/lib/server/request-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 8 * 1024;
const TIMEOUT_MS = 20_000;
const headers = { "cache-control": "private, no-store" };
const failure = (status: number, error: string) =>
	NextResponse.json({ error }, { status, headers });

export async function POST(req: Request) {
	let tenant: Awaited<ReturnType<typeof requireOrganizationAdmin>>;
	try {
		tenant = await requireOrganizationAdmin(req.headers);
	} catch (error) {
		const response = authError(error);
		response.headers.set("cache-control", headers["cache-control"]);
		return response;
	}
	if (
		req.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
		"application/json"
	)
		return failure(415, "A JSON request body is required");
	const body = await readBoundedJson(req, MAX_BODY_BYTES);
	if (body.tooLarge) return failure(413, "Request body is too large");
	const parsed = perTitleEncodingImportRequestSchema.safeParse(body.value);
	if (!parsed.success) return failure(400, "Invalid encoding import request");
	if (req.signal.aborted) return failure(408, "Encoding import canceled");
	const signal = AbortSignal.any([req.signal, AbortSignal.timeout(TIMEOUT_MS)]);
	try {
		const input = parsed.data;
		let credentials: { apiKey: string; tenantOrgId?: string };
		if ("bitmovinAccountId" in input) {
			const ctx = contextForOrganization(tenant.organizationId, false, tenant);
			const account = await ctx.bitmovinAccounts.get(input.bitmovinAccountId);
			if (!account) return failure(404, "Account not found");
			credentials = {
				apiKey: await ctx.bitmovinAccounts.revealApiKey(
					input.bitmovinAccountId,
				),
				...(account.tenantOrgId ? { tenantOrgId: account.tenantOrgId } : {}),
			};
		} else {
			credentials = {
				apiKey: input.apiKey,
				...(input.tenantOrgId ? { tenantOrgId: input.tenantOrgId } : {}),
			};
		}
		const api = createPerTitleEncodingHttpPort({ ...credentials, signal });
		const snapshot = await loadPerTitleEncodingSnapshot(api, input.encodingId, {
			signal,
		});
		return NextResponse.json(projectPerTitleEncodingImport(snapshot), {
			headers,
		});
	} catch (error) {
		if (signal.aborted)
			return failure(
				req.signal.aborted ? 408 : 504,
				req.signal.aborted
					? "Encoding import canceled"
					: "Encoding import timed out",
			);
		if (error instanceof PerTitleEncodingLoaderError)
			return failure(error.status, error.message);
		const status = (error as { httpStatusCode?: unknown } | null)
			?.httpStatusCode;
		if (typeof status === "number")
			return failure(
				status === 404 ? 404 : 502,
				status === 404
					? "Encoding settings were not found"
					: "Encoding settings are unavailable from Bitmovin",
			);
		// Provider failures can contain credentials and request details.
		return failure(500, "Encoding settings could not be imported");
	}
}
