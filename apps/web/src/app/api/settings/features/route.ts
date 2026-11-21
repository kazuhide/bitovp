import {
	FEATURE_FLAGS_KEY,
	featureFlagsPatchSchema,
	featureFlagsSchema,
} from "@bitovp/core";
import { NextResponse } from "next/server";
import { roleAtLeast } from "@/lib/auth/roles";
import { writeAuditLog } from "@/lib/server/audit";
import { getServerContext } from "@/lib/server/context";
import {
	lockFeatureFlags,
	readFeatureFlags,
	readStoredFeatureFlags,
} from "@/lib/server/feature-flags";
import {
	jsonError,
	readJson,
	routeError,
	validationError,
} from "@/lib/server/http";

/**
 * Organization-wide feature flags. GET is the current state (defaults
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
		const { tenant } = ctx;
		if (
			!tenant ||
			tenant.isImpersonating ||
			!roleAtLeast(tenant.role, "ADMIN")
		) {
			return jsonError(
				403,
				"Changing feature settings requires an administrator",
			);
		}
		const next = await ctx.prisma.$transaction(async (tx) => {
			// The row may not exist yet. Serialize patches so concurrent changes
			// to separate flags merge against the latest committed value.
			await lockFeatureFlags(tx, tenant.organizationId);
			const value = featureFlagsSchema.parse({
				...(await readStoredFeatureFlags(tx)),
				...body.data,
			});
			await tx.appSetting.upsert({
				where: { key: FEATURE_FLAGS_KEY },
				create: { key: FEATURE_FLAGS_KEY, value },
				update: { value },
			});
			return value;
		});
		// Changing collection or QC affects the entire organization.
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
