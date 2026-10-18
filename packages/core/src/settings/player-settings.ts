import { z } from "zod";

/**
 * Player & Analytics settings .
 *
 * One `AppSetting` row under `PLAYER_SETTINGS_KEY` — the #131 key/value
 * mechanism, NOT the design's original dedicated table: the design predates
 * AppSetting, and a column-per-knob table was exactly what #131 replaced.
 * Same contract as feature-flags: defaults live HERE, an absent row and a
 * fresh install are the same state, deleting the row is "back to defaults",
 * and a malformed row degrades instead of crashing a render.
 *
 * KEY CLASS (C26): these are PUBLIC CLIENT keys — a Bitmovin Player/Analytics
 * licence key is designed to be sent to the browser and is domain-locked at
 * the vendor. They are deliberately NOT in the AES-256-GCM credential vault:
 * calling a browser-bound key write-only and redacted would misrepresent it
 * to the next reader. Plain storage, visible in forms.
 */
export const PLAYER_SETTINGS_KEY = "playerSettings";

export const playerProviderSchema = z.enum(["native", "bitmovin"]);
export type PlayerProvider = z.infer<typeof playerProviderSchema>;

export const playerSettingsSchema = z
	.object({
		/**
		 * `native` (hls.js/Shaka Player) is the default and the no-licence
		 * fallback — an install without a Bitmovin Player licence loses
		 * nothing it has today, and a closed-network deployment (whose
		 * licence check cannot reach Bitmovin) stays on it.
		 */
		provider: playerProviderSchema.default("native"),
		/** Bitmovin Player licence key — public client class (C26). */
		playerLicenseKey: z.string().trim().max(200).default(""),
		/**
		 * Bitmovin Analytics licence key — SEPARATE from any production
		 * Analytics licence, so internal QA impressions never mix into
		 * audience QoE data (UI-DESIGN §2). Used only by Bitmovin Player;
		 * the open-source preview never loads a Bitmovin Analytics adapter.
		 */
		analyticsLicenseKey: z.string().trim().max(200).default(""),
	})
	.strip();

export type PlayerSettings = z.infer<typeof playerSettingsSchema>;

/**
 * PATCH shape: every field optional and — the point — with NO defaults.
 * `.partial` would keep the inner defaults, so parsing `{}` would reset
 * every untouched field (the review-265 131-A6 class). Absent must mean
 * absent so the merge leaves untouched fields alone. The duplicated key
 * list is guarded by the same both-schemas-agree test as feature-flags.
 */
export const playerSettingsPatchSchema = z
	.object({
		provider: playerProviderSchema.optional(),
		playerLicenseKey: z.string().trim().max(200).optional(),
		analyticsLicenseKey: z.string().trim().max(200).optional(),
	})
	.strip();

export type PlayerSettingsPatch = z.infer<typeof playerSettingsPatchSchema>;

/** Every field at its default — the meaning of an absent or unusable row. */
export const DEFAULT_PLAYER_SETTINGS: PlayerSettings =
	playerSettingsSchema.parse({});

/** Never throws — the caller is a page render. */
export function parsePlayerSettings(value: unknown): PlayerSettings {
	const parsed = playerSettingsSchema.safeParse(value ?? {});
	return parsed.success ? parsed.data : DEFAULT_PLAYER_SETTINGS;
}

/**
 * The narrow object that crosses the RSC boundary (design §4.2): explicitly
 * constructed, never the settings row — a field added to the row later must
 * NOT ship to the browser without showing up here and in the boundary-pin
 * test. Empty licence keys cross as ABSENT so client code cannot mistake ""
 * for a configured key, and a `bitmovin` provider without a player key
 * degrades to `native` HERE — one place, not per consumer.
 */
export type PlayerClientConfig =
	| { provider: "native" }
	| {
			provider: "bitmovin";
			playerLicenseKey: string;
			analyticsLicenseKey?: string;
	  };

export function toPlayerClientConfig(
	settings: PlayerSettings,
): PlayerClientConfig {
	if (settings.provider !== "bitmovin" || settings.playerLicenseKey === "") {
		return { provider: "native" };
	}
	return {
		provider: "bitmovin",
		playerLicenseKey: settings.playerLicenseKey,
		...(settings.analyticsLicenseKey !== ""
			? { analyticsLicenseKey: settings.analyticsLicenseKey }
			: {}),
	};
}
