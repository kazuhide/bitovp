import {
	PLAYER_SETTINGS_KEY,
	playerSettingsPatchSchema,
	playerSettingsSchema,
} from "@bitovp/core";
import { NextResponse } from "next/server";
import { writeAuditLog } from "@/lib/server/audit";
import { getServerContext } from "@/lib/server/context";
import { readJson, routeError, validationError } from "@/lib/server/http";
import { readPlayerSettings } from "@/lib/server/player-config";

/**
 * : player & Analytics settings — the #131 AppSetting mechanism,
 * the features route's exact shape. The licence keys are PUBLIC CLIENT keys
 * (C26): deliberately readable in GET and visible in forms — calling a
 * browser-bound key write-only would misrepresent it.
 */
export async function GET() {
	try {
		const ctx = await getServerContext();
		return NextResponse.json(await readPlayerSettings(ctx.prisma));
	} catch (err) {
		return routeError(err);
	}
}

export async function PATCH(req: Request) {
	// NOT .partial on the value schema — that keeps inner defaults and an
	// empty patch would reset every untouched field (review-265 131-A6).
	const body = playerSettingsPatchSchema.safeParse(await readJson(req));
	if (!body.success) {
		return validationError(body.error);
	}
	try {
		const ctx = await getServerContext();
		// Merge onto the CURRENT value: a PATCH naming one field must not
		// silently reset the others.
		const next = playerSettingsSchema.parse({
			...(await readPlayerSettings(ctx.prisma)),
			...body.data,
		});
		await ctx.prisma.appSetting.upsert({
			where: { key: PLAYER_SETTINGS_KEY },
			create: { key: PLAYER_SETTINGS_KEY, value: next },
			update: { value: next },
		});
		await writeAuditLog(
			ctx,
			{
				method: "PATCH",
				path: "/api/settings/player",
				statusCode: 200,
				response: next,
			},
			req,
		);
		return NextResponse.json(next);
	} catch (err) {
		return routeError(err);
	}
}
