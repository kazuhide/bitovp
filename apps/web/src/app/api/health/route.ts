import { NextResponse } from "next/server";
import { probeSdkExternal } from "@/lib/server/sdk-probe";

/**
 * Public liveness + the  deployment gate: a container whose SDK
 * packaging is broken (pre-fix image, standalone copy, pruned shim tree)
 * answers 503 "degraded" WITH the named cause, instead of serving 200 here
 * while every SDK route 502s. The verify smoke's first step reads this
 * status, so a broken deployment stops the harness before it spends.
 */
export async function GET() {
	const sdkFailure = await probeSdkExternal();
	return NextResponse.json(
		{
			status: sdkFailure ? "degraded" : "ok",
			service: "bitovp-web",
			...(sdkFailure ? { sdk: sdkFailure } : {}),
			time: new Date().toISOString(),
		},
		sdkFailure ? { status: 503 } : undefined,
	);
}
