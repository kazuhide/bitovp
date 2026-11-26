import { NextResponse } from "next/server";
import { authError } from "@/lib/auth/route-context";
import type { OperationAnalyticsDto } from "@/lib/operation-analytics";
import { getOrganizationAdminReadContext } from "@/lib/server/context";
import { readStoredFeatureFlags } from "@/lib/server/feature-flags";
import { readWeeklyOperationAnalytics } from "@/lib/server/operation-analytics";

export async function GET(req: Request) {
	try {
		const { organizationId, prisma } = await getOrganizationAdminReadContext(
			req.headers,
		);
		const [weeks, flags] = await Promise.all([
			readWeeklyOperationAnalytics(prisma, organizationId),
			readStoredFeatureFlags(prisma),
		]);
		return NextResponse.json<OperationAnalyticsDto>(
			{ weeks, isCollecting: flags.operationAnalytics },
			{ headers: { "cache-control": "private, no-store" } },
		);
	} catch (error) {
		const response = authError(error);
		response.headers.set("cache-control", "private, no-store");
		return response;
	}
}
