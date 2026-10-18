import {
	heartbeatConfigOf,
	LIVE_HEARTBEAT_SETTINGS_KEY,
	type LiveHeartbeatEnv,
	resolveLiveHeartbeatSettings,
} from "@bitovp/core";
import type { AppPrismaClient } from "@bitovp/db";

/**
 * The registrar's read of Settings → Live's heartbeat cadence — AT USE, once
 * per tick, never cached at startup, so an operator's change applies on the
 * next tick without a worker restart (the same discipline as the feature
 * flags, ).
 *
 * A row that cannot be READ (database error) falls back to the deployment's
 * env/default, never to "off": `null` here retires live heartbeat hooks,
 * and a transient read failure must not do that. A row that reads but does
 * not parse is the deployment default by the core contract.
 */
export async function readLiveHeartbeatConfig(
	prisma: AppPrismaClient,
	env: LiveHeartbeatEnv,
): Promise<ReturnType<typeof heartbeatConfigOf>> {
	let stored: unknown = null;
	try {
		const row = await prisma.appSetting.findUnique({
			where: { key: LIVE_HEARTBEAT_SETTINGS_KEY },
			select: { value: true },
		});
		stored = row?.value ?? null;
	} catch {
		stored = null;
	}
	return heartbeatConfigOf(resolveLiveHeartbeatSettings(stored, env).effective);
}
