import type { RunTimelineEvent } from "@bitovp/core";
import { describe, expect, it } from "vitest";
import type { HeartbeatReception, PushTimelineEvent } from "../live-shared";
import { mergePushTimeline } from "./push-timeline";

const iso = (seconds: number) => new Date(seconds * 1_000).toISOString();
const event = (
	kind: PushTimelineEvent["kind"],
	seconds: number,
): PushTimelineEvent => ({
	kind,
	eventAt: iso(seconds),
	observedReceivedAt: iso(500),
});
const reception = (events: PushTimelineEvent[]): HeartbeatReception => ({
	state: "available",
	runId: "run",
	configuredIntervalS: 20,
	latest: null,
	previousReceivedAt: null,
	timeline: { events, coverage: "recent-receipts", truncated: false },
});
const poll = (
	kind: RunTimelineEvent["kind"],
	seconds: number,
): RunTimelineEvent => ({ kind, atMs: seconds * 1_000, source: "heartbeat" });
const merge = (r: HeartbeatReception, events: RunTimelineEvent[] = []) =>
	mergePushTimeline(events, r, "run", { startMs: 0, endMs: 600_000 }, 600_000);

describe("Push timeline overlay", () => {
	it("prefers explicit event time for one matching Poll mark, preserving other polls and lifecycle", () => {
		const result = merge(reception([event("FIRST_CONNECT", 100)]), [
			poll("INPUT_CONNECTED", 120),
			poll("INPUT_CONNECTED", 130),
			poll("INPUT_DISCONNECTED", 400),
			poll("OUTPUT_ACTIVE", 120),
		]);
		expect(result.map((e) => [e.kind, e.atMs, e.source])).toEqual([
			["INPUT_CONNECTED", 100_000, "push"],
			["OUTPUT_ACTIVE", 120_000, "heartbeat"],
			["INPUT_CONNECTED", 130_000, "heartbeat"],
			["INPUT_DISCONNECTED", 400_000, "heartbeat"],
		]);
	});
	it("never hides a Poll mark across an opposite Push transition or invents disconnects from gaps", () => {
		const result = merge(
			reception([
				event("FIRST_CONNECT", 100),
				event("DISCONNECT", 110),
				event("RECONNECT", 120),
			]),
			[poll("INPUT_CONNECTED", 115), poll("INPUT_DISCONNECTED", 125)],
		);
		expect(
			result.filter((e) => e.source === "push").map((e) => e.kind),
		).toEqual(["INPUT_CONNECTED", "INPUT_DISCONNECTED", "INPUT_RECONNECTED"]);
		expect(result).toContainEqual(poll("INPUT_DISCONNECTED", 125));
		expect(
			merge(
				reception([event("FIRST_CONNECT", 100), event("RECONNECT", 500)]),
			).filter((e) => e.kind === "INPUT_DISCONNECTED"),
		).toEqual([]);
	});
	it("rejects other runs, future events/receipts, out-of-run events and duplicate cumulative entries", () => {
		const r = reception([
			event("FIRST_CONNECT", 100),
			event("FIRST_CONNECT", 100),
			event("DISCONNECT", -1),
			event("DISCONNECT", 601),
			{ ...event("DISCONNECT", 300), observedReceivedAt: iso(601) },
		]);
		expect(merge(r)).toHaveLength(1);
		expect(merge({ ...r, runId: "old" })).toEqual([]);
		expect(
			merge({ state: "unavailable", runId: "run" }, [
				poll("INPUT_CONNECTED", 100),
			]),
		).toEqual([poll("INPUT_CONNECTED", 100)]);
	});
});
