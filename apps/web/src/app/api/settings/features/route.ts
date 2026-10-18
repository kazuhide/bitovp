import {
	FEATURE_FLAGS_KEY,
	featureFlagsPatchSchema,
	featureFlagsSchema,
} from "@bitovp/core";
import { NextResponse } from "next/server";
import { writeAuditLog } from "@/lib/server/audit";
import { getServerContext } from "@/lib/server/context";
import { readFeatureFlags } from "@/lib/server/feature-flags";
import { readJson, routeError, validationError } from "@/lib/server/http";

/**
 * : the app-wide feature flags. GET is the current state (defaults
 * when the row is absent); PATCH writes one row via upsert, so turning a flag
 * on for the first time and changing it later are the same code path.
 *
 * Deliberately NOT gated by any flag — this is the switch itself.
 */
export async function GET() {
	try {
		const ctx = await getServerContext();
		return NextResponse.json(await readFeatureFlags(ctx.prisma));
	} catch (err) {
		return routeError(err);
	}
}

export async function PATCH(req: Request) {
	// NOT featureFlagsSchema.partial: that keeps the inner .default(false),
	// so an empty patch turned the flag off (review-265 131-A6).
	const body = featureFlagsPatchSchema.safeParse(await readJson(req));
	if (!body.success) {
		return validationError(body.error);
	}
	try {
		const ctx = await getServerContext();
		// Merge onto the CURRENT value, not onto the defaults: a PATCH that
		// names one flag must not silently reset the others to default.
		const next = featureFlagsSchema.parse({
			...(await readFeatureFlags(ctx.prisma)),
			...body.data,
		});
		await ctx.prisma.appSetting.upsert({
			where: { key: FEATURE_FLAGS_KEY },
			create: { key: FEATURE_FLAGS_KEY, value: next },
			update: { value: next },
		});
		// An app-wide switch is exactly the kind of change the trail exists for
		// — turning QC off changes what every future encode does.
		await writeAuditLog(
			ctx,
			{
				method: "PATCH",
				path: "/api/settings/features",
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
