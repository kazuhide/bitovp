import { describe, expect, it } from "vitest";
import {
	heartbeatConfigOf,
	parseLiveHeartbeatSettings,
} from "../settings/live-heartbeat-settings";
import {
	heartbeatCustomData,
	parseHeartbeatRegistrationConfig,
	resolveHeartbeatMode,
} from "./heartbeat-registration";

describe("per-encoding heartbeat capability", () => {
	it.each([
		["BETA", "2.285.0", "PER_ENCODING"],
		["STABLE", "2.286.1", "PER_ENCODING"],
		["2.285.0", null, "PENDING_VERSION"],
		["BETA", null, "PENDING_VERSION"],
		["STABLE", "2.284.0", "POLL_ONLY"],
		["2.284.0", null, "POLL_ONLY"],
		["2.99.0", null, "POLL_ONLY"],
		["BETA", "3.0.0", "PENDING_VERSION"],
		["BETA", "2.285.0-rc.1", "PENDING_VERSION"],
		[null, "garbage", "PENDING_VERSION"],
	])("%s resolved to %s selects %s", (requested, resolved, expected) => {
		expect(resolveHeartbeatMode(requested, resolved)).toBe(expected);
	});
	it("normalizes legacy policy and preserves OFF", () => {
		expect(resolveHeartbeatMode("BETA", "2.285.0", "LEGACY_ACCOUNT")).toBe(
			"PER_ENCODING",
		);
		expect(
			parseLiveHeartbeatSettings({
				intervalS: 20,
				idleMinutes: 60,
				mode: "AUTO",
			}),
		).toMatchObject({ mode: "PER_ENCODING" });
		expect(
			parseLiveHeartbeatSettings({
				intervalS: 20,
				idleMinutes: 60,
				mode: "unsafe",
			}),
		).toBeNull();
		expect(
			heartbeatConfigOf({
				intervalS: 0,
				idleMinutes: 60,
				mode: "PER_ENCODING",
			}),
		).toBeNull();
		expect(
			heartbeatConfigOf({
				intervalS: 20,
				idleMinutes: 60,
				mode: "PER_ENCODING",
			}),
		).toMatchObject({ mode: "PER_ENCODING" });
	});
});

describe("heartbeat correlation snapshot", () => {
	const config = {
		v: 1,
		mode: "PER_ENCODING",
		requestedEncoderVersion: "BETA",
		resolvedEncoderVersion: "2.285.0",
		intervalS: 20,
		registrationId: "a65fc906-7704-4fdd-b6bf-e1a69c50790a",
		channelId: "85741999-6bfd-4783-9bf6-7ac5f0c62f1d",
		runId: "5123a1bc-7f67-4325-9624-2d1a4b334bcb",
		createAttempted: false,
	} as const;
	it("accepts the immutable snapshot, treats legacy null as absent", () => {
		expect(parseHeartbeatRegistrationConfig(config)).toEqual(config);
		expect(
			parseHeartbeatRegistrationConfig({ ...config, mode: "LEGACY_ACCOUNT" })
				?.mode,
		).toBe("LEGACY_ACCOUNT");
		expect(
			parseHeartbeatRegistrationConfig({ ...config, mode: "POLL_ONLY" })?.mode,
		).toBe("POLL_ONLY");
		expect(parseHeartbeatRegistrationConfig(null)).toBeNull();
		expect(parseHeartbeatRegistrationConfig({ ...config, v: 2 })).toBeNull();
		expect(
			parseHeartbeatRegistrationConfig({ ...config, runId: "" }),
		).toBeNull();
	});
	it("projects only minimal nonsecret correlation into customData", () => {
		expect(heartbeatCustomData(config)).toEqual({
			bitOvp: {
				v: 1,
				registrationId: config.registrationId,
				channelId: config.channelId,
				runId: config.runId,
			},
		});
		expect(
			Buffer.byteLength(JSON.stringify(heartbeatCustomData(config))),
		).toBeLessThan(1024);
	});
});
