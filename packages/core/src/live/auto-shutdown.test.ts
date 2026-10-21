import { describe, expect, it } from "vitest";
import {
	liveAutoShutdownFingerprint,
	liveAutoShutdownUpdateParamsSchema,
	readLiveAutoShutdownUpdate,
} from "./auto-shutdown";

describe("running Live automatic stop configuration", () => {
	it("requires a complete replacement object, including an explicit empty object", () => {
		expect(
			liveAutoShutdownUpdateParamsSchema.parse({ configuration: {} }),
		).toEqual({ configuration: {} });
		expect(liveAutoShutdownUpdateParamsSchema.safeParse({}).success).toBe(
			false,
		);
	});

	it.each([
		{ bytesReadTimeoutSeconds: 29 },
		{ streamTimeoutMinutes: 4 },
		{ waitingForFirstConnectTimeoutMinutes: 4 },
		{ streamTimeoutMinutes: 5.5 },
		{ streamTimeoutMinutes: null },
		{ streamTimeoutMinutes: "5" },
		{ unknownTimer: 5 },
	])("refuses invalid or unknown timer values: %j", (configuration) => {
		expect(
			liveAutoShutdownUpdateParamsSchema.safeParse({ configuration }).success,
		).toBe(false);
	});

	it("binds the normalized complete configuration to the exact run", () => {
		const a = { bytesReadTimeoutSeconds: 30, streamTimeoutMinutes: 5 };
		const b = { streamTimeoutMinutes: 5, bytesReadTimeoutSeconds: 30 };
		expect(liveAutoShutdownFingerprint("run-a", a)).toBe(
			liveAutoShutdownFingerprint("run-a", b),
		);
		expect(liveAutoShutdownFingerprint("run-a", a)).not.toBe(
			liveAutoShutdownFingerprint("run-b", a),
		);
		expect(liveAutoShutdownFingerprint("run-a", a)).not.toBe(
			liveAutoShutdownFingerprint("run-a", {}),
		);
	});

	it("reads only successful, valid updates and retains an explicit all-disabled configuration", () => {
		const payload = {
			configuration: {},
			appliedAt: "2026-10-21T00:00:00.000Z",
			scheduledShutdownAt: null,
			requestId: "request-1",
		};
		expect(
			readLiveAutoShutdownUpdate([
				{ kind: "LIVE_AUTO_SHUTDOWN_UPDATE", status: "DONE", payload },
				{
					kind: "LIVE_AUTO_SHUTDOWN_UPDATE",
					status: "FAILED",
					payload: { ...payload, configuration: { streamTimeoutMinutes: 5 } },
				},
			]),
		).toEqual(payload);
		expect(
			readLiveAutoShutdownUpdate([
				{
					kind: "LIVE_AUTO_SHUTDOWN_UPDATE",
					status: "DONE",
					payload: { ...payload, appliedAt: "invalid" },
				},
			]),
		).toBeNull();
	});
});
