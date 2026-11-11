import { getIdentityPrisma } from "@bitovp/db";
import { NextResponse } from "next/server";
import { probeSdkExternal } from "@/lib/server/sdk-probe";

/**
 * Public liveness + the  deployment gate: a container whose SDK
 * packaging is broken (pre-fix image, standalone copy, pruned shim tree)
 * answers 503 "degraded" WITH the named cause, instead of serving 200 here
 * while every SDK route 502s. The verify smoke's first step reads this
 * status, so a broken deployment stops the harness before it spends.
 * Identity reads also exercise the native Prisma engine used by the auth gate.
 */
export const dynamic = "force-dynamic";

export async function GET() {
	const sdkFailure = await probeSdkExternal();
	let databaseUnavailable = false;
	try {
		await getIdentityPrisma().user.count();
	} catch {
		databaseUnavailable = true;
	}
	const degraded = Boolean(sdkFailure) || databaseUnavailable;
	return NextResponse.json(
		{
			status: degraded ? "degraded" : "ok",
			service: "bitovp-web",
			...(sdkFailure ? { sdk: sdkFailure } : {}),
			...(databaseUnavailable ? { database: "unavailable" } : {}),
			time: new Date().toISOString(),
		},
		degraded ? { status: 503 } : undefined,
	);
}
