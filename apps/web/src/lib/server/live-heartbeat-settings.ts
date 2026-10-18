import "server-only";
import {
	LIVE_HEARTBEAT_SETTINGS_KEY,
	type ResolvedLiveHeartbeatSettings,
	resolveLiveHeartbeatSettings,
} from "@bitovp/core";
import type { AppPrismaClient } from "@bitovp/db";

/**
 * Settings → Live's heartbeat cadence as the worker will read it: the stored
 * row over the deployment's env over the code default, with the source named
 * so the screen can say where the effective value comes from. One primary-key
 * read, not cached — a save must show on the next request. A row that cannot
 * be read degrades to the deployment default, the same fallback the worker
 * takes (`apps/worker/src/settings/live-heartbeat.ts`).
 */
export async function readLiveHeartbeatSettings(
	prisma: AppPrismaClient,
	env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedLiveHeartbeatSettings & { hasRow: boolean }> {
	let stored: unknown = null;
	let hasRow = false;
	try {
		const row = await prisma.appSetting.findUnique({
			where: { key: LIVE_HEARTBEAT_SETTINGS_KEY },
			select: { value: true },
		});
		stored = row?.value ?? null;
		hasRow = row !== null;
	} catch {
		stored = null;
	}
	return {
		hasRow,
		...resolveLiveHeartbeatSettings(stored, {
			HEARTBEAT_WEBHOOK_INTERVAL_S: env.HEARTBEAT_WEBHOOK_INTERVAL_S,
			HEARTBEAT_WEBHOOK_IDLE_MINUTES: env.HEARTBEAT_WEBHOOK_IDLE_MINUTES,
		}),
	};
}
