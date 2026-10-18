import { listVmafCloudProfiles } from "@bitovp/db";
import { NextResponse } from "next/server";
import type { VmafComputeProfileSummary } from "@/app/qc/vmaf-shared";
import { getServerContext } from "@/lib/server/context";
import { requireQcVmafEnabled } from "@/lib/server/feature-flags";
import { jsonError } from "@/lib/server/http";

/** Guarded by the shared API auth/RBAC proxy; no private configuration crosses it. */
export async function GET() {
	const disabled = await requireQcVmafEnabled();
	if (disabled) return disabled;
	try {
		const profiles = await listVmafCloudProfiles(
			(await getServerContext()).prisma,
			process.env.VMAF_COMPUTE_PROFILES,
		);
		const items: VmafComputeProfileSummary[] = profiles.map((profile) => ({
			id: profile.id,
			label: profile.label,
			provider: profile.provider,
			region: profile.region,
			maxCostUsdPerHour: profile.maxCostUsdPerHour,
			timeoutSeconds: profile.timeoutSeconds,
			queueTimeoutSeconds: profile.queueTimeoutSeconds,
			overheadUsd: profile.overheadUsd,
			transferUsdPerGiB: profile.transferUsdPerGiB,
		}));
		return NextResponse.json(
			{ items },
			{ headers: { "Cache-Control": "no-store" } },
		);
	} catch {
		// Configuration errors can contain private values. Do not serialize them.
		return jsonError(503, "Cloud compute profiles are unavailable");
	}
}
