import { describe, expect, it } from "vitest";
import type { HeartbeatReception } from "../live-shared";
import { heartbeatReceptionView } from "./heartbeat-reception";

const now = Date.parse("2026-09-07T08:00:00Z");
const stamp = (ago: number) => new Date(now - ago).toISOString();
function received(): HeartbeatReception {
	return {
		state: "available",
		runId: "run-1",
		configuredIntervalS: 20,
		latest: {
			receivedAt: stamp(10_000),
			sampledAt: stamp(12_000),
			raw: { ingest: { status: "CONNECTED" } },
		},
		previousReceivedAt: stamp(30_000),
	};
}
describe("heartbeatReceptionView", () => {
	it("uses the fixed 90-second displayed-sample boundary", () => {
		for (const [age, expected] of [
			[90_000, "fresh"],
			[90_001, "stale"],
		] as const) {
			const data = received();
			if (data.state === "available" && data.latest)
				data.latest.receivedAt = stamp(age);
			expect(heartbeatReceptionView(data, "run-1", now, "live").state).toBe(
				expected,
			);
		}
	});
	it("changing the current interval cannot revive a five-minute-old displayed sample", () => {
		for (const intervalS of [20, 3600]) {
			const data = received();
			if (data.state === "available" && data.latest) {
				data.configuredIntervalS = intervalS;
				data.latest.receivedAt = stamp(300_000);
				data.latest.sampledAt = stamp(300_000);
			}
			const view = heartbeatReceptionView(data, "run-1", now, "live");
			expect(view.state).toBe("stale");
			expect(view.sampleState).toBe("stale");
			expect(view.configuredIntervalS).toBe(intervalS);
		}
	});
	it("cannot attribute telemetry when no current run exists", () => {
		const data = { ...received(), runId: null };
		expect(heartbeatReceptionView(data, null, now, "live").state).toBe(
			"unavailable",
		);
	});
	it("distinguishes a verified receipt from configured cadence and sample freshness", () => {
		const view = heartbeatReceptionView(received(), "run-1", now, "live");
		expect(view.state).toBe("fresh");
		expect(view.sampleState).toBe("fresh");
		expect(view.cadenceSeconds).toBe(20);
		expect(view.configuredIntervalS).toBe(20);
	});
	it("does not call absent, failed, or another run's projection never received", () => {
		for (const value of [
			undefined,
			{ state: "unavailable", runId: "run-1" } as const,
			received(),
		])
			expect(heartbeatReceptionView(value, "other", now, "live").state).toBe(
				"unavailable",
			);
		const data = received();
		if (data.state === "available") data.latest = null;
		expect(heartbeatReceptionView(data, "run-1", now, "live").state).toBe(
			"never",
		);
	});
	it("fresh receipt cannot make an old provider sample fresh", () => {
		const data = received();
		if (data.state === "available" && data.latest)
			data.latest.sampledAt = stamp(300_000);
		const view = heartbeatReceptionView(data, "run-1", now, "live");
		expect(view.state).toBe("fresh");
		expect(view.sampleState).toBe("stale");
	});
	it("missing and future sample timestamps are not trusted as current input", () => {
		for (const [sampledAt, expected] of [
			[null, "unknown"],
			[stamp(-60_000), "clock-skew"],
		] as const) {
			const data = received();
			if (data.state === "available" && data.latest)
				data.latest.sampledAt = sampledAt;
			expect(
				heartbeatReceptionView(data, "run-1", now, "live").sampleState,
			).toBe(expected);
		}
	});
	it("marks old receipts stale and finished runs historical", () => {
		const data = received();
		if (data.state === "available" && data.latest)
			data.latest.receivedAt = stamp(300_000);
		expect(heartbeatReceptionView(data, "run-1", now, "live").state).toBe(
			"stale",
		);
		const ended = heartbeatReceptionView(data, "run-1", now, "finished");
		expect(ended.state).toBe("ended");
		expect(ended.sampleState).toBe("historical");
	});
	it("does not invent cadence from one receipt, duplicates, or reversed time", () => {
		for (const previous of [null, stamp(10_000), stamp(5_000), "bad"]) {
			const data = received();
			if (data.state === "available") data.previousReceivedAt = previous;
			expect(
				heartbeatReceptionView(data, "run-1", now, "live").cadenceSeconds,
			).toBeNull();
		}
	});
});
