import {
	INGRESS_SETTING_KEY,
	type IngressSnapshot,
	parseIngressSnapshot,
} from "@bitovp/core";
import type { Prisma } from "../generated/client";
import type { AppPrismaClient } from "./client";
import { getIdentityPrisma } from "./identity-client";
import { tenantOrganizationId } from "./tenant-client";

/**
 * The persisted ingress snapshot (WP-G G-1): ONE `AppSetting` row, written
 * by the worker's monitor every tick and read by everything in the web app
 * that needs the public base URL — registration, the proxy's Host
 * allowlist, the settings screen. Reading the env there instead would fork
 * the value the moment a tunnel rotated.
 */

/** Absent or malformed ⇒ null; never throws on the row's CONTENT (a DB fault still rejects). */
export async function readIngressSnapshot(
	prisma: AppPrismaClient,
): Promise<IngressSnapshot | null> {
	const settings = tenantOrganizationId(prisma)
		? getIdentityPrisma().platformSetting
		: (prisma.platformSetting ?? prisma.appSetting);
	const row = await settings.findUnique({
		where: { key: INGRESS_SETTING_KEY },
		select: { value: true },
	});
	return row ? parseIngressSnapshot(row.value) : null;
}

export async function writeIngressSnapshot(
	prisma: AppPrismaClient,
	snapshot: IngressSnapshot,
): Promise<void> {
	const value = snapshot as unknown as Prisma.InputJsonValue;
	const settings = tenantOrganizationId(prisma)
		? getIdentityPrisma().platformSetting
		: (prisma.platformSetting ?? prisma.appSetting);
	await settings.upsert({
		where: { key: INGRESS_SETTING_KEY },
		create: { key: INGRESS_SETTING_KEY, value },
		update: { value },
	});
}
