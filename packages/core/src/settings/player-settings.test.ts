import { describe, expect, it } from "vitest";
import {
	DEFAULT_PLAYER_SETTINGS,
	parsePlayerSettings,
	playerSettingsPatchSchema,
	playerSettingsSchema,
	toPlayerClientConfig,
} from "./player-settings";

/**
 * : same contract as feature-flags — defaults in CODE, absent row
 * = fresh install = deleted row, malformed degrades. Plus the boundary
 * builder's two rules: empty keys cross as ABSENT, and `bitmovin` without a
 * player key degrades to `native` in ONE place.
 */
describe("player settings (ledger #59)", () => {
	it("defaults to the native player with no keys — the pre-#59 behaviour", () => {
		expect(DEFAULT_PLAYER_SETTINGS).toEqual({
			provider: "native",
			playerLicenseKey: "",
			analyticsLicenseKey: "",
		});
	});

	it("absent, empty and malformed values all read as the defaults", () => {
		for (const value of [
			undefined,
			null,
			{},
			{ provider: "flash" },
			"not an object",
			7,
			[],
		]) {
			expect(parsePlayerSettings(value)).toEqual(DEFAULT_PLAYER_SETTINGS);
		}
	});

	it("a configured row survives, unknown keys are dropped not rejected", () => {
		expect(
			parsePlayerSettings({
				provider: "bitmovin",
				playerLicenseKey: "pk",
				analyticsLicenseKey: "ak",
				fromANewerBuild: true,
			}),
		).toEqual({
			provider: "bitmovin",
			playerLicenseKey: "pk",
			analyticsLicenseKey: "ak",
		});
	});
});

describe("the patch schema (the review-265 131-A6 rule)", () => {
	it("describes the SAME fields as the full schema", () => {
		expect(Object.keys(playerSettingsPatchSchema.shape).sort()).toEqual(
			Object.keys(playerSettingsSchema.shape).sort(),
		);
	});

	it("an empty patch names nothing — no field resets through defaults", () => {
		expect(playerSettingsPatchSchema.parse({})).toEqual({});
	});
});

describe("toPlayerClientConfig — the RSC boundary object (design §4.2)", () => {
	it("empty keys cross as ABSENT, not as empty strings", () => {
		const config = toPlayerClientConfig(DEFAULT_PLAYER_SETTINGS);
		expect(config).toEqual({ provider: "native" });
		expect("playerLicenseKey" in config).toBe(false);
		expect("analyticsLicenseKey" in config).toBe(false);
	});

	it("bitmovin WITHOUT a player key degrades to native and withholds Analytics", () => {
		expect(
			toPlayerClientConfig({
				provider: "bitmovin",
				playerLicenseKey: "",
				analyticsLicenseKey: "ak",
			}),
		).toEqual({ provider: "native" });
	});

	it("a fully configured bitmovin row crosses with exactly three fields", () => {
		const config = toPlayerClientConfig({
			provider: "bitmovin",
			playerLicenseKey: "pk",
			analyticsLicenseKey: "ak",
		});
		expect(config).toEqual({
			provider: "bitmovin",
			playerLicenseKey: "pk",
			analyticsLicenseKey: "ak",
		});
		// The BOUNDARY PIN (design §4.2): exactly these fields may cross the
		// serialization boundary. A field added to the settings row must not
		// ship to the browser without showing up in this list.
		expect(Object.keys(config).sort()).toEqual([
			"analyticsLicenseKey",
			"playerLicenseKey",
			"provider",
		]);
	});

	it("native is the open-source mode and never crosses an Analytics key", () => {
		expect(
			toPlayerClientConfig({
				provider: "native",
				playerLicenseKey: "",
				analyticsLicenseKey: "ak",
			}),
		).toEqual({ provider: "native" });
	});
});
