import {
	HEARTBEAT_WEBHOOK_MAX_IDLE_MINUTES,
	HEARTBEAT_WEBHOOK_MAX_INTERVAL_S,
	LIVE_HEARTBEAT_SETTINGS_KEY,
	liveHeartbeatSettingsSchema,
} from "@bitovp/core";
import { NextResponse } from "next/server";
import { writeAuditLog } from "@/lib/server/audit";
import { getServerContext } from "@/lib/server/context";
import { readJson, routeError, validationError } from "@/lib/server/http";
import { readLiveHeartbeatSettings } from "@/lib/server/live-heartbeat-settings";

/** Per-encoding heartbeat settings. The legacy idle value is retained for API compatibility.
 * GET resolves the current source; PUT validates and normalizes old mode aliases;
 * DELETE returns to deployment defaults. Writes are ADMIN and audited.
 */
const BOUNDS = {
	minIntervalS: 1,
	maxIntervalS: HEARTBEAT_WEBHOOK_MAX_INTERVAL_S,
	maxIdleMinutes: HEARTBEAT_WEBHOOK_MAX_IDLE_MINUTES,
} as const;

export async function GET() {
	try {
		const ctx = await getServerContext();
		const resolved = await readLiveHeartbeatSettings(ctx.prisma);
		return NextResponse.json({ ...resolved, bounds: BOUNDS });
	} catch (err) {
		return routeError(err);
	}
}

export async function PUT(req: Request) {
	const parsed = liveHeartbeatSettingsSchema.safeParse(await readJson(req));
	if (!parsed.success) {
		return validationError(parsed.error);
	}
	const value = parsed.data;
	try {
		const ctx = await getServerContext();
		await ctx.prisma.appSetting.upsert({
			where: { key: LIVE_HEARTBEAT_SETTINGS_KEY },
			create: { key: LIVE_HEARTBEAT_SETTINGS_KEY, value },
			update: { value },
		});
		await writeAuditLog(
			ctx,
			{
				method: "PUT",
				path: "/api/settings/live-heartbeat",
				statusCode: 200,
				response: value,
			},
			req,
		);
		const resolved = await readLiveHeartbeatSettings(ctx.prisma);
		return NextResponse.json({ ...resolved, bounds: BOUNDS });
	} catch (err) {
		return routeError(err);
	}
}

export async function DELETE(req: Request) {
	try {
		const ctx = await getServerContext();
		const removed = await ctx.prisma.appSetting.deleteMany({
			where: { key: LIVE_HEARTBEAT_SETTINGS_KEY },
		});
		await writeAuditLog(
			ctx,
			{
				method: "DELETE",
				path: "/api/settings/live-heartbeat",
				statusCode: 200,
				response: { removed: removed.count },
			},
			req,
		);
		const resolved = await readLiveHeartbeatSettings(ctx.prisma);
		return NextResponse.json({ ...resolved, bounds: BOUNDS });
	} catch (err) {
		return routeError(err);
	}
}
