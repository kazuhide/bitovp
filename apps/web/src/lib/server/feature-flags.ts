import "server-only";
import {
	DEFAULT_FEATURE_FLAGS,
	FEATURE_FLAGS_KEY,
	type FeatureFlags,
	parseFeatureFlags,
} from "@bitovp/core";
import type { AppPrismaClient } from "@bitovp/db";
import { NextResponse } from "next/server";
import { getServerContext } from "./context";

export async function readStoredFeatureFlags(
	prisma: Pick<AppPrismaClient, "appSetting">,
): Promise<FeatureFlags> {
	const row = await prisma.appSetting.findUnique({
		where: { key: FEATURE_FLAGS_KEY },
		select: { value: true },
	});
	return parseFeatureFlags(row?.value);
}

/** Serialize setting edits even before the organization has a settings row. */
export async function lockFeatureFlags(
	tx: Pick<AppPrismaClient, "$executeRaw">,
	organizationId: string,
): Promise<void> {
	const key = `${organizationId}:settings:${FEATURE_FLAGS_KEY}`;
	await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
}

/** Order a settings read with concurrent patches and settings reset. */
export async function readLockedFeatureFlags(
	tx: Pick<AppPrismaClient, "$queryRaw">,
	organizationId: string,
	access: "read" | "write" = "read",
): Promise<FeatureFlags> {
	const [row] =
		access === "read"
			? await tx.$queryRaw<{ value: unknown }[]>`
			SELECT "value" FROM "AppSetting"
			WHERE "organizationId" = ${organizationId}::uuid AND "key" = ${FEATURE_FLAGS_KEY}
			FOR SHARE
		`
			: await tx.$queryRaw<{ value: unknown }[]>`
			SELECT "value" FROM "AppSetting"
			WHERE "organizationId" = ${organizationId}::uuid AND "key" = ${FEATURE_FLAGS_KEY}
			FOR UPDATE
		`;
	return parseFeatureFlags(row?.value);
}

/**
 * One primary-key read, NOT cached: a flag flip must take effect
 * on the next request, and this is the cheapest query in the app. Any failure
 * — no row, malformed JSON, database unreachable — degrades to the defaults,
 * because `/login` has to render before the database is reachable and a
 * deployment whose DB is down has bigger problems than a hidden lab.
 */
export async function readFeatureFlags(
	// Optional, and resolved INSIDE the try (review-265 131-A3): as a default
	// parameter, `getServerContext` evaluated OUTSIDE this function's own
	// catch, so an env-validation failure (getPrisma → loadEnv) became a
	// rejected promise the root layout awaits — 500ing every page including
	// /login, the exact case this fallback exists to protect. Callers that
	// already have a client still pass it; the default is now a fallback, not
	// a parameter evaluation.
	prisma?: AppPrismaClient,
): Promise<FeatureFlags> {
	try {
		return await readStoredFeatureFlags(
			prisma ?? (await getServerContext()).prisma,
		);
	} catch {
		return DEFAULT_FEATURE_FLAGS;
	}
}

/**
 * The route-level gate. A disabled feature answers 404 rather than 403: with
 * the flag off the surface does not exist for this deployment, and a 403 would
 * advertise it.
 *
 * NOT used by the recovery pair (`qc-override`, `qc-report`) — those stay
 * reachable in both states so a job parked under a pre-existing gate can still
 * be released and evidenced .
 */
export async function requireQcVmafEnabled(
	prisma?: AppPrismaClient,
): Promise<NextResponse | null> {
	const flags = await readFeatureFlags(prisma);
	if (flags.qcVmaf) {
		return null;
	}
	return NextResponse.json(
		{ error: "QC/VMAF is turned off for this deployment" },
		{ status: 404 },
	);
}
