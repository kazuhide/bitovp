import "server-only";
import { BRANDING_SETTINGS_KEY, parseBrandingSettings } from "@bitovp/core";
import type { AppPrismaClient } from "@bitovp/db";

/** Tenant client is mandatory; database failures remain visible to Settings. */
export async function readBrandingSettings(prisma: AppPrismaClient) {
	const row = await prisma.appSetting.findUnique({
		where: { key: BRANDING_SETTINGS_KEY },
		select: { value: true },
	});
	return parseBrandingSettings(row?.value);
}
