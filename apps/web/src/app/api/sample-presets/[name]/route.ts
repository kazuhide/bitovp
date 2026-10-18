import { samplePresetPlan } from "@bitovp/core/presets";
import { NextResponse } from "next/server";
import { jsonError } from "@/lib/server/http";

type RouteParams = { params: Promise<{ name: string }> };

/**
 * Plan JSON for one sample preset (the checked-in golden fixtures). Served
 * server-side so the 56 embedded plans never enter the client bundle —
 * the wizard fetches the selected one and feeds it through the import path.
 * Presets are immutable per build, so successful responses are cacheable.
 */
export async function GET(_req: Request, { params }: RouteParams) {
	const { name } = await params;
	const plan = samplePresetPlan(name);
	return plan
		? NextResponse.json(plan, {
				headers: { "Cache-Control": "public, max-age=3600" },
			})
		: jsonError(404, "Unknown preset");
}
