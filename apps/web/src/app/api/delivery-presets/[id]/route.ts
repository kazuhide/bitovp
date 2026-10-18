import { deliverySpec } from "@bitovp/core";
import { NextResponse } from "next/server";
import { jsonError, routeError } from "@/lib/server/http";

type RouteParams = { params: Promise<{ id: string }> };

/**
 * One shipped delivery spec  — plan + constraints + suggested
 * gate. Code-shipped like /api/sample-presets (no DB); the wizard loads it
 * through the same import path and keeps the constraints for the drift
 * banner. Secret-free by construction: plans carry credential IDs only.
 */
export async function GET(_req: Request, { params }: RouteParams) {
	const { id } = await params;
	try {
		const spec = deliverySpec(id);
		if (!spec) {
			return jsonError(404, "Unknown delivery preset");
		}
		return NextResponse.json({ spec });
	} catch (err) {
		return routeError(err);
	}
}
