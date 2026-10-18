import {
	assertStorageEndpointAllowed,
	createCredentialSchema,
	parseStorageEndpointAllowlist,
	StorageEndpointBlockedError,
} from "@bitovp/core";
import { NextResponse } from "next/server";
import { getServerContext } from "@/lib/server/context";
import {
	jsonError,
	readJson,
	routeError,
	validationError,
} from "@/lib/server/http";

/**
 * : the create-door half of the GENERIC_S3 endpoint rail (the
 * point-of-use half lives in the storage factory). When the deployment
 * lists vetted endpoints, an unlisted host is refused at save time — the
 * operator hears it while typing, not when a sweep later refuses to run.
 * Unset stays permissive here; the point-of-use warning carries the nudge.
 */
function endpointDoorCheck(
	provider: string,
	config: Record<string, unknown> | undefined,
): string | null {
	if (provider !== "GENERIC_S3") {
		return null;
	}
	const raw = process.env.STORAGE_ENDPOINT_ALLOWED_HOSTS;
	if (raw === undefined) {
		return null;
	}
	const allowlist = parseStorageEndpointAllowlist(raw);
	const host = typeof config?.host === "string" ? config.host : "";
	try {
		assertStorageEndpointAllowed(host, allowlist, () => {});
		return null;
	} catch (err) {
		if (err instanceof StorageEndpointBlockedError) {
			return err.message;
		}
		throw err;
	}
}

export async function GET() {
	try {
		const ctx = await getServerContext();
		// `listWithSecretPresence`, not `list` — this route is the ONE producer
		// of `credentialSummaryWireSchema`, which requires `hasSecret` (ledger
		// #196). Note tsc cannot see that: `NextResponse.json` accepts anything,
		// so the wire type has always been a claim about this response that
		// nothing checked. `route.test.ts` now parses the response against the
		// schema, which is the link that did not exist.
		return NextResponse.json(await ctx.credentials.listWithSecretPresence());
	} catch (err) {
		return routeError(err);
	}
}

export async function POST(req: Request) {
	const parsed = createCredentialSchema.safeParse(await readJson(req));
	if (!parsed.success) {
		return validationError(parsed.error);
	}
	try {
		const ctx = await getServerContext();
		const { label, provider, config, secret } = parsed.data;
		const blocked = endpointDoorCheck(provider, config);
		if (blocked) {
			return jsonError(422, blocked);
		}
		const row = await ctx.credentials.create({
			label,
			provider,
			config,
			secret: JSON.stringify(secret ?? {}),
		});
		return NextResponse.json(row, { status: 201 });
	} catch (err) {
		return routeError(err);
	}
}
