import { version as installedSdkVersion } from "@bitmovin/api-sdk/package.json";
import { NextResponse } from "next/server";
import current from "@/data/api-coverage/current.json";
import summary from "@/data/api-coverage/summary.json";

/**
 * Read-only bundled source census. The proxy retains the VIEWER read floor.
 * Parameter reachability is a separate historical survey, not refreshed data.
 */
export async function GET(_request: Request) {
	return NextResponse.json({
		sdk: {
			installed: installedSdkVersion,
			surveyed: current.provenance.sdkVersion,
			stale: installedSdkVersion !== current.provenance.sdkVersion,
		},
		current,
		parameterSnapshot: {
			surveyedSdk: summary.surveyedSdk,
			surveyedAt: summary.surveyedAt,
			paramTotals: summary.paramTotals,
			paramFamilies: summary.paramFamilies,
			fields: summary.headline.paramFields,
			operatorReachable: summary.headline.paramOperatorReachable,
		},
	});
}
