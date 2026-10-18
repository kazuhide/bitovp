import {
	REGISTRATION_RECONCILE_INTERVAL_MS,
	WEBHOOK_RECONCILE_REQUEST_KEY,
} from "@bitovp/core";
import { NextResponse } from "next/server";
import { getServerContext } from "@/lib/server/context";
import { routeError } from "@/lib/server/http";

/**
 * "Re-register now" (WP-G G-2). The registrar lives in the WORKER, so the web
 * app cannot call it — it leaves a timestamped request under
 * `AppSetting[webhook.reconcileRequestedAt]`, and the registrar's next tick
 * (≤ 10 s) clears every SKIPPED/FAILED backoff so those rows retry at once,
 * then marks the request handled. ACTIVE rows under a moved ingress or a
 * rotated master are re-registered by the registrar's own rules regardless;
 * this button exists for the rows that were waiting on a backoff or on an
 * ingress that has since appeared.
 *
 * Writes only the request row: no provider call, so it is cheap, idempotent
 * (a second click before the tick overwrites the same key) and safe for an
 * OPERATOR — the §4 write catch-all is its floor.
 */
export async function POST() {
	try {
		const ctx = await getServerContext();
		const requestedAt = new Date().toISOString();
		await ctx.prisma.appSetting.upsert({
			where: { key: WEBHOOK_RECONCILE_REQUEST_KEY },
			create: { key: WEBHOOK_RECONCILE_REQUEST_KEY, value: { requestedAt } },
			update: { value: { requestedAt } },
		});
		return NextResponse.json({
			requestedAt,
			appliesWithinMs: REGISTRATION_RECONCILE_INTERVAL_MS,
		});
	} catch (err) {
		return routeError(err);
	}
}
