import {
	assertStorageEndpointAllowed,
	type CredentialProviderId,
	parseStorageEndpointAllowlist,
	StorageEndpointBlockedError,
	updateCredentialSchema,
} from "@bitovp/core";
import { NextResponse } from "next/server";
import { customerErrorDetails } from "@/lib/customer-error";
import { getServerContext } from "@/lib/server/context";
import {
	invalidIdResponse,
	jsonError,
	readJson,
	routeError,
	validationError,
} from "@/lib/server/http";

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: RouteParams) {
	const { id } = await params;
	const invalid = invalidIdResponse(id);
	if (invalid) {
		return invalid;
	}
	try {
		const ctx = await getServerContext();
		const row = await ctx.credentials.get(id);
		return row ? NextResponse.json(row) : jsonError(404, "Not found");
	} catch (err) {
		return routeError(err);
	}
}

export async function PATCH(req: Request, { params }: RouteParams) {
	const { id } = await params;
	const invalid = invalidIdResponse(id);
	if (invalid) {
		return invalid;
	}
	try {
		const ctx = await getServerContext();
		const existing = await ctx.credentials.get(id);
		if (!existing) {
			return jsonError(404, "Not found");
		}
		const schema = updateCredentialSchema(
			existing.provider as CredentialProviderId,
		);
		const parsed = schema.safeParse(await readJson(req));
		if (!parsed.success) {
			return validationError(parsed.error);
		}
		// : the same create-door endpoint rail on UPDATE — a
		// config edit must not smuggle an unlisted GENERIC_S3 host past it.
		if (
			existing.provider === "GENERIC_S3" &&
			parsed.data.config !== undefined &&
			process.env.STORAGE_ENDPOINT_ALLOWED_HOSTS !== undefined
		) {
			const allowlist = parseStorageEndpointAllowlist(
				process.env.STORAGE_ENDPOINT_ALLOWED_HOSTS,
			);
			const host =
				typeof (parsed.data.config as Record<string, unknown>).host === "string"
					? ((parsed.data.config as Record<string, unknown>).host as string)
					: "";
			try {
				assertStorageEndpointAllowed(host, allowlist, () => {});
			} catch (err) {
				if (err instanceof StorageEndpointBlockedError) {
					return jsonError(
						422,
						"This storage endpoint is not allowed",
						customerErrorDetails("STORAGE_ENDPOINT_NOT_ALLOWED"),
					);
				}
				throw err;
			}
		}
		const row = await ctx.credentials.update(id, {
			label: parsed.data.label,
			config: parsed.data.config,
			secret:
				parsed.data.secret !== undefined
					? JSON.stringify(parsed.data.secret)
					: undefined,
		});
		return NextResponse.json(row);
	} catch (err) {
		return routeError(err);
	}
}

export async function DELETE(_req: Request, { params }: RouteParams) {
	const { id } = await params;
	const invalid = invalidIdResponse(id);
	if (invalid) {
		return invalid;
	}
	try {
		const ctx = await getServerContext();
		await ctx.credentials.remove(id);
		return new NextResponse(null, { status: 204 });
	} catch (err) {
		return routeError(err);
	}
}
