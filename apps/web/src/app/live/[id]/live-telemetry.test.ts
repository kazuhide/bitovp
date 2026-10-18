import { describe, expect, it } from "vitest";
import type { HeartbeatReception } from "../live-shared";
import { deliveryDiagnosis, selectLiveTelemetry } from "./live-telemetry";

const now = Date.parse("2026-09-07T12:00:00Z");
const iso = (age: number) => new Date(now - age).toISOString();
const raw = (status = "CONNECTED") => ({
	timestamp: iso(10_000),
	ingest: { status, healthy: status === "CONNECTED" },
	output: {
		manifests: {
			hls: [
				{ manifestUpdates: [{ manifestUpdateWallClockTime: iso(10_000) }] },
			],
		},
	},
});
const poll = { at: iso(5_000), raw: raw("DISCONNECTED"), deltas: {} };
function reception(age = 10_000): HeartbeatReception {
	return {
		state: "available",
		runId: "run",
		configuredIntervalS: 20,
		latest: { receivedAt: iso(age), sampledAt: iso(age), raw: raw() },
		previousReceivedAt: iso(age + 20_000),
	};
}
function selected(
	push: HeartbeatReception | undefined,
	value: unknown = poll,
	mode: "live" | "finished" = "live",
) {
	return selectLiveTelemetry({
		reception: push,
		runId: "run",
		poll: value,
		nowMs: now,
		mode,
	});
}
describe("Push-first display telemetry", () => {
	it.each([
		{},
		[null],
		[{ manifestUpdates: {} }],
		[{ manifestUpdates: [null] }],
	])("treats malformed signed output as unknown without losing independent origin (%j)", (hls) => {
		const push = reception();
		if (push.state === "available" && push.latest)
			push.latest.raw = { ...raw(), output: { manifests: { hls } } };
		const result = selected(push);
		expect(deliveryDiagnosis(result, null, now).output).toBe("unknown");
		expect(
			deliveryDiagnosis(
				result,
				{
					lastFetchAtMs: now,
					lastVerdicts: { a: { stale: true, endlist: false } },
				},
				now,
			).output,
		).toBe("stalled");
	});
	it("keeps provider sample clock separate from later Poll receipt for packet-age checks", () => {
		const result = selected(undefined, {
			at: iso(0),
			raw: { timestamp: iso(20_000), ingest: { status: "CONNECTED" } },
		});
		expect(result.providerSampleAtMs).toBe(now - 20_000);
		expect(
			selected(undefined, {
				at: iso(0),
				raw: { ingest: { status: "CONNECTED" } },
			}).providerSampleAtMs,
		).toBeUndefined();
	});
	it("uses fresh signed Push instead of a disagreeing poll", () => {
		const result = selected(reception());
		expect(result.source).toBe("push");
		expect(result.current).toBe(true);
		expect(result.sample?.raw).toEqual(raw());
		expect(deliveryDiagnosis(result, null, now).input).toBe("CONNECTED");
	});
	it.each([
		undefined,
		{ state: "unavailable", runId: "run" },
		{ ...reception(), runId: "other" },
		reception(100_000),
		reception(-10_000),
	] as (
		| HeartbeatReception
		| undefined
	)[])("falls back to fresh poll without treating Push loss as input loss (%j)", (push) => {
		const result = selected(push, { at: iso(5_000), raw: raw(), deltas: {} });
		expect(result.source).toBe("poll");
		expect(deliveryDiagnosis(result, null, now)).toMatchObject({
			input: "CONNECTED",
			notice: "PUSH_UNAVAILABLE",
		});
	});
	it("rejects a newly delivered old sample", () => {
		const push = reception();
		if (push.state === "available" && push.latest)
			push.latest.sampledAt = iso(120_000);
		expect(selected(push).source).toBe("poll");
	});
	it("does not resurrect old poll content with a new poll wrapper", () => {
		const result = selected(undefined, {
			at: iso(1_000),
			raw: { ...raw(), timestamp: iso(120_000) },
		});
		expect(result.current).toBe(false);
		expect(deliveryDiagnosis(result, null, now)).toMatchObject({
			input: "UNKNOWN",
			output: "unknown",
			notice: "UNKNOWN",
		});
	});
	it("treats no observation as unknown, not disconnected", () => {
		expect(deliveryDiagnosis(selected(undefined, null), null, now).input).toBe(
			"UNKNOWN",
		);
	});
	it("keeps stopped samples historical without live warnings", () => {
		const result = selected(reception(), poll, "finished");
		expect(result.source).toBe("push");
		expect(result.current).toBe(false);
		expect(deliveryDiagnosis(result, null, now).notice).toBe("ENDED");
	});
	it("prefers fresh independent origin failure to encoder-reported progress", () => {
		const result = deliveryDiagnosis(
			selected(reception()),
			{
				lastFetchAtMs: now - 1000,
				lastVerdicts: { a: { stale: true, endlist: false } },
			},
			now,
		);
		expect(result).toMatchObject({
			output: "stalled",
			outputSource: "origin",
			notice: "OUTPUT_STALLED",
		});
	});
	it("ignores stale or future origin failures and uses Push output", () => {
		for (const at of [now - 100_000, now + 20_000]) {
			expect(
				deliveryDiagnosis(
					selected(reception()),
					{
						lastFetchAtMs: at,
						lastVerdicts: { a: { stale: true, endlist: false } },
					},
					now,
				),
			).toMatchObject({ output: "advancing", outputSource: "push" });
		}
	});
	it("does not let absent or unavailable origin override valid Push", () => {
		expect(
			deliveryDiagnosis(
				selected(reception()),
				{
					lastFetchAtMs: now,
					unavailableReason: "unsupported",
					lastVerdicts: {},
				},
				now,
			),
		).toMatchObject({ output: "advancing", outputSource: "push" });
	});
	it("retains unknown when the selected sample has no output evidence", () => {
		const push = reception();
		if (push.state === "available" && push.latest)
			push.latest.raw = { ingest: { status: "CONNECTED" } };
		expect(deliveryDiagnosis(selected(push), null, now)).toMatchObject({
			output: "unknown",
			notice: "OUTPUT_UNKNOWN",
		});
	});
	it("distinguishes first-connect waiting from a disconnection", () => {
		for (const [status, notice] of [
			["WAITING_FOR_FIRST_CONNECT", "INPUT_WAITING"],
			["DISCONNECTED", "INPUT_LOST"],
			["ERROR", "INPUT_LOST"],
		]) {
			const push = reception();
			if (push.state === "available" && push.latest)
				push.latest.raw = raw(status);
			expect(deliveryDiagnosis(selected(push), null, now).notice).toBe(notice);
		}
	});
});
