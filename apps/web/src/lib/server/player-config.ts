import "server-only";
import {
	DEFAULT_PLAYER_SETTINGS,
	PLAYER_SETTINGS_KEY,
	type PlayerClientConfig,
	type PlayerSettings,
	parsePlayerSettings,
	toPlayerClientConfig,
} from "@bitovp/core";
import type { AppPrismaClient } from "@bitovp/db";
import { getServerContext } from "./context";

/**
 *  . Same read contract as
 * feature-flags: one primary-key read, not cached, every failure degrades to
 * defaults — a malformed row must not take a job-detail render down, and the
 * default (`native`, no keys) selects hls.js for HLS and Shaka Player for
 * DASH without exposing an Analytics key to the browser.
 */
export async function readPlayerSettings(
	prisma?: AppPrismaClient,
): Promise<PlayerSettings> {
	try {
		const client = prisma ?? (await getServerContext()).prisma;
		const row = await client.appSetting.findUnique({
			where: { key: PLAYER_SETTINGS_KEY },
			select: { value: true },
		});
		return parsePlayerSettings(row?.value);
	} catch {
		return DEFAULT_PLAYER_SETTINGS;
	}
}

/**
 * The ONLY thing pages may hand to client components (design §4.2): the
 * narrow, explicitly-constructed object — never the settings row. Props are
 * an implicit serialization boundary and widen silently; the boundary-pin
 * test enumerates exactly these fields.
 */
export async function readPlayerClientConfig(
	prisma?: AppPrismaClient,
): Promise<PlayerClientConfig> {
	return toPlayerClientConfig(await readPlayerSettings(prisma));
}
