import { describe, expect, it } from "vitest";
import {
	DEFAULT_LIVE_HEARTBEAT_SETTINGS,
	HEARTBEAT_WEBHOOK_MAX_IDLE_MINUTES,
	HEARTBEAT_WEBHOOK_MAX_INTERVAL_S,
	heartbeatConfigOf,
	LIVE_HEARTBEAT_SETTINGS_KEY,
	parseLiveHeartbeatSettings,
	resolveLiveHeartbeatSettings,
} from "./live-heartbeat-settings";

describe("live heartbeat settings — the stored row", () => {
	it("keys the AppSetting row like the other live settings", () => {
		expect(LIVE_HEARTBEAT_SETTINGS_KEY).toBe("live:heartbeat-webhook");
	});

	it("accepts the bounds and 0 as the OFF switch", () => {
		expect(
			parseLiveHeartbeatSettings({ intervalS: 0, idleMinutes: 1 }),
		).toEqual({ mode: "PER_ENCODING", intervalS: 0, idleMinutes: 1 });
		expect(
			parseLiveHeartbeatSettings({ intervalS: 1, idleMinutes: 60 }),
		).toEqual({ mode: "PER_ENCODING", intervalS: 1, idleMinutes: 60 });
		expect(
			parseLiveHeartbeatSettings({
				intervalS: HEARTBEAT_WEBHOOK_MAX_INTERVAL_S,
				idleMinutes: HEARTBEAT_WEBHOOK_MAX_IDLE_MINUTES,
			}),
		).toEqual({ mode: "PER_ENCODING", intervalS: 3600, idleMinutes: 10080 });
	});

	it("rejects (to null, never a throw) an absent, malformed, fractional, out-of-range or widened row", () => {
		expect(parseLiveHeartbeatSettings(null)).toBeNull();
		expect(parseLiveHeartbeatSettings(undefined)).toBeNull();
		expect(parseLiveHeartbeatSettings("20")).toBeNull();
		expect(parseLiveHeartbeatSettings({ intervalS: 20 })).toBeNull();
		expect(
			parseLiveHeartbeatSettings({ intervalS: 0.5, idleMinutes: 60 }),
		).toBeNull();
		expect(
			parseLiveHeartbeatSettings({ intervalS: -1, idleMinutes: 60 }),
		).toBeNull();
		expect(
			parseLiveHeartbeatSettings({ intervalS: 3601, idleMinutes: 60 }),
		).toBeNull();
		expect(
			parseLiveHeartbeatSettings({ intervalS: 20, idleMinutes: 0 }),
		).toBeNull();
		expect(
			parseLiveHeartbeatSettings({ intervalS: 20, idleMinutes: 10081 }),
		).toBeNull();
		expect(
			parseLiveHeartbeatSettings({ intervalS: "20", idleMinutes: 60 }),
		).toBeNull();
		expect(
			parseLiveHeartbeatSettings({
				intervalS: 20,
				idleMinutes: 60,
				extra: true,
			}),
		).toBeNull();
	});
});

describe("live heartbeat settings — precedence gui > env > default", () => {
	it("a parseable row wins over the environment and says so", () => {
		const r = resolveLiveHeartbeatSettings(
			{ intervalS: 30, idleMinutes: 120 },
			{
				HEARTBEAT_WEBHOOK_INTERVAL_S: "5",
				HEARTBEAT_WEBHOOK_IDLE_MINUTES: "10",
			},
		);
		expect(r.effective).toEqual({
			mode: "PER_ENCODING",
			intervalS: 30,
			idleMinutes: 120,
		});
		expect(r.source).toBe("gui");
		expect(r.stored).toEqual({
			mode: "PER_ENCODING",
			intervalS: 30,
			idleMinutes: 120,
		});
		expect(r.envDefault).toEqual({
			mode: "PER_ENCODING",
			intervalS: 5,
			idleMinutes: 10,
		});
		expect(r.envSource).toBe("env");
	});

	it("an absent or malformed row falls back to the environment, read through the worker's own parsers", () => {
		const env = {
			HEARTBEAT_WEBHOOK_INTERVAL_S: "off",
			HEARTBEAT_WEBHOOK_IDLE_MINUTES: "15",
		};
		expect(resolveLiveHeartbeatSettings(null, env)).toMatchObject({
			effective: { intervalS: 0, idleMinutes: 15 },
			source: "env",
			stored: null,
		});
		expect(resolveLiveHeartbeatSettings({ intervalS: "x" }, env)).toMatchObject(
			{
				effective: { intervalS: 0, idleMinutes: 15 },
				source: "env",
				stored: null,
			},
		);
		// garbage in the env is the provider default, as before the setting existed
		expect(
			resolveLiveHeartbeatSettings(null, {
				HEARTBEAT_WEBHOOK_INTERVAL_S: "abc",
			}),
		).toMatchObject({
			effective: { intervalS: 20, idleMinutes: 60 },
			source: "env",
		});
	});

	it("nothing set anywhere is the code default 20 s / 60 min, and blank env values do not count as set", () => {
		const r = resolveLiveHeartbeatSettings(null, {
			HEARTBEAT_WEBHOOK_INTERVAL_S: "  ",
			HEARTBEAT_WEBHOOK_IDLE_MINUTES: "",
		});
		expect(r.effective).toEqual(DEFAULT_LIVE_HEARTBEAT_SETTINGS);
		expect(r.source).toBe("default");
		expect(r.envSource).toBe("default");
	});
});

describe("heartbeatConfigOf — the registrar's shape", () => {
	it("0 is no hook; otherwise seconds and idle milliseconds", () => {
		expect(
			heartbeatConfigOf({
				mode: "PER_ENCODING",
				intervalS: 0,
				idleMinutes: 60,
			}),
		).toBeNull();
		expect(
			heartbeatConfigOf({
				mode: "PER_ENCODING",
				intervalS: 20,
				idleMinutes: 60,
			}),
		).toEqual({
			intervalS: 20,
			idleMs: 3_600_000,
			mode: "PER_ENCODING",
		});
		expect(
			heartbeatConfigOf({ mode: "PER_ENCODING", intervalS: 1, idleMinutes: 1 }),
		).toEqual({
			intervalS: 1,
			idleMs: 60_000,
			mode: "PER_ENCODING",
		});
	});
});

it.each([
	undefined,
	"AUTO",
	"LEGACY_ACCOUNT",
	"PER_ENCODING",
])("normalizes %s without losing saved cadence or OFF", (mode) => {
	for (const intervalS of [0, 2, 30]) {
		const result = resolveLiveHeartbeatSettings(
			{ mode, intervalS, idleMinutes: 17 },
			{},
		);
		expect(result.effective).toEqual({
			mode: "PER_ENCODING",
			intervalS,
			idleMinutes: 17,
		});
		expect(heartbeatConfigOf(result.effective)).toEqual(
			intervalS ? { mode: "PER_ENCODING", intervalS, idleMs: 1020000 } : null,
		);
	}
});

it("an obsolete idle-only env value does not claim to supply the active cadence", () => {
	const result = resolveLiveHeartbeatSettings(null, {
		HEARTBEAT_WEBHOOK_IDLE_MINUTES: "15",
	});
	expect(result.source).toBe("default");
	expect(result.envSource).toBe("default");
	expect(result.effective).toEqual({
		mode: "PER_ENCODING",
		intervalS: 20,
		idleMinutes: 15,
	});
});
