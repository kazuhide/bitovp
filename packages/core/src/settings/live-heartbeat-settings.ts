import { z } from "zod";
import {
	HEARTBEAT_WEBHOOK_DEFAULT_IDLE_MINUTES,
	HEARTBEAT_WEBHOOK_DEFAULT_INTERVAL_S,
	HEARTBEAT_WEBHOOK_MIN_INTERVAL_S,
	heartbeatWebhookIdleMs,
	heartbeatWebhookIntervalS,
} from "../webhooks/registration";

/**
 * Settings → Live: per-encoding Live Encoding Heartbeat cadence
 * (C37, WP-G G-3), stored as ONE `AppSetting` row under
 * `LIVE_HEARTBEAT_SETTINGS_KEY` and read by the worker's registrar AT USE
 * (every tick), so a change applies without a restart.
 *
 * Precedence, in the order an operator reasons about it:
 *   1. the stored row, when it parses — the GUI value ("gui");
 *   2. else the deployment's `HEARTBEAT_WEBHOOK_INTERVAL_S` /
 *      `HEARTBEAT_WEBHOOK_IDLE_MINUTES` ("env") — the deployer's default;
 *   3. else the code defaults, 20 s / 60 min ("default").
 * Deleting the row is a valid "back to the deployment default", which is why
 * the env value is the fallback and not merged field-by-field: a half-set
 * GUI value would otherwise borrow one field from the environment and the
 * screen could not say where the effective value came from.
 *
 * `intervalS` 0 is the OFF switch (no hook is registered; an existing one
 * retires) — the same meaning `0`/`off` carries in the env.
 */
export const LIVE_HEARTBEAT_SETTINGS_KEY = "live:heartbeat-webhook";

/** Our bound, not the provider's (C37 documents only the 1 s minimum). */
export const HEARTBEAT_WEBHOOK_MAX_INTERVAL_S = 3600;
/** Seven days — longer than any idle window a hook should outlive. */
export const HEARTBEAT_WEBHOOK_MAX_IDLE_MINUTES = 7 * 24 * 60;

export const liveHeartbeatSettingsSchema = z.strictObject({
	/** Old request/stored aliases remain readable but cannot enable account hooks. */
	mode: z
		.enum(["PER_ENCODING", "AUTO", "LEGACY_ACCOUNT"])
		.optional()
		.transform(() => "PER_ENCODING" as const),
	/** Seconds between pushes; `0` = no hook. */
	intervalS: z.union([
		z.literal(0),
		z
			.number()
			.int()
			.min(HEARTBEAT_WEBHOOK_MIN_INTERVAL_S)
			.max(HEARTBEAT_WEBHOOK_MAX_INTERVAL_S),
	]),
	/** Retained for stored/API compatibility; per-encoding hooks retire with their run. */
	idleMinutes: z.number().int().min(1).max(HEARTBEAT_WEBHOOK_MAX_IDLE_MINUTES),
});

export type LiveHeartbeatSettings = z.infer<typeof liveHeartbeatSettingsSchema>;
export type LiveHeartbeatSource = "gui" | "env" | "default";

export type LiveHeartbeatEnv = {
	HEARTBEAT_WEBHOOK_INTERVAL_S?: string;
	HEARTBEAT_WEBHOOK_IDLE_MINUTES?: string;
};

export type ResolvedLiveHeartbeatSettings = {
	effective: LiveHeartbeatSettings;
	source: LiveHeartbeatSource;
	/** The parsed row, or null when absent or unusable. */
	stored: LiveHeartbeatSettings | null;
	/** What deleting the row would fall back to. */
	envDefault: LiveHeartbeatSettings;
	envSource: Exclude<LiveHeartbeatSource, "gui">;
};

/**
 * Parse a stored value; `null` when absent or malformed. Never throws — the
 * callers are a settings render and a worker tick, and a hand-edited row must
 * take neither down (it falls back to the deployment default instead).
 */
export function parseLiveHeartbeatSettings(
	value: unknown,
): LiveHeartbeatSettings | null {
	const parsed = liveHeartbeatSettingsSchema.safeParse(value);
	return parsed.success ? parsed.data : null;
}

function isSet(raw: string | undefined): boolean {
	return raw !== undefined && raw.trim() !== "";
}

/**
 * The deployment's default, read through the same parsers the worker used
 * before the setting existed — so it is NOT clamped to the GUI schema's bounds
 * (an env interval above 3600 s or a fractional idle minute is honoured as it
 * always was, and only displayed by the screen, never written back).
 */
export function envLiveHeartbeatSettings(env: LiveHeartbeatEnv): {
	settings: LiveHeartbeatSettings;
	source: Exclude<LiveHeartbeatSource, "gui">;
} {
	const intervalS = heartbeatWebhookIntervalS(env.HEARTBEAT_WEBHOOK_INTERVAL_S);
	const idleMinutes =
		heartbeatWebhookIdleMs(env.HEARTBEAT_WEBHOOK_IDLE_MINUTES) / 60_000;
	// The preserved idle value no longer determines the active cadence.
	const source = isSet(env.HEARTBEAT_WEBHOOK_INTERVAL_S) ? "env" : "default";
	return { settings: { mode: "PER_ENCODING", intervalS, idleMinutes }, source };
}

export function resolveLiveHeartbeatSettings(
	stored: unknown,
	env: LiveHeartbeatEnv,
): ResolvedLiveHeartbeatSettings {
	const fromEnv = envLiveHeartbeatSettings(env);
	const parsed = parseLiveHeartbeatSettings(stored);
	return {
		effective: parsed ?? fromEnv.settings,
		source: parsed ? "gui" : fromEnv.source,
		stored: parsed,
		envDefault: fromEnv.settings,
		envSource: fromEnv.source,
	};
}

/** The registrar's shape: `null` = no hook (the OFF switch). */
export function heartbeatConfigOf(settings: LiveHeartbeatSettings): {
	intervalS: number;
	idleMs: number;
	mode: "PER_ENCODING";
} | null {
	if (settings.intervalS <= 0) {
		return null;
	}
	return {
		intervalS: settings.intervalS,
		idleMs: Math.round(settings.idleMinutes * 60_000),
		mode: "PER_ENCODING",
	};
}

/** The code defaults — the meaning of an absent row in an env that sets nothing. */
export const DEFAULT_LIVE_HEARTBEAT_SETTINGS: LiveHeartbeatSettings = {
	mode: "PER_ENCODING",
	intervalS: HEARTBEAT_WEBHOOK_DEFAULT_INTERVAL_S,
	idleMinutes: HEARTBEAT_WEBHOOK_DEFAULT_IDLE_MINUTES,
};
