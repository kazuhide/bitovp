import {
	HEARTBEAT_FUTURE_SKEW_TOLERANCE_MS,
	INGEST_CONNECTED_MAX_AGE_MS,
} from "@bitovp/core";
import type { HeartbeatReception } from "../live-shared";

export type ReceptionState =
	| "unavailable"
	| "never"
	| "fresh"
	| "stale"
	| "clock-skew"
	| "ended";
export type ReceptionSampleState =
	| "fresh"
	| "stale"
	| "unknown"
	| "clock-skew"
	| "historical";
function parsed(value: string | null | undefined): number | null {
	const n = value ? Date.parse(value) : Number.NaN;
	return Number.isFinite(n) ? n : null;
}
function freshness(
	at: number,
	now: number,
	maxAge: number,
): "fresh" | "stale" | "clock-skew" {
	const age = now - at;
	return age < -HEARTBEAT_FUTURE_SKEW_TOLERANCE_MS
		? "clock-skew"
		: age > maxAge
			? "stale"
			: "fresh";
}

/**
 * Freshness of the displayed distinct sample's FIRST receipt, not latest HTTP
 * activity. Current settings cannot change this bound: a running encoder may
 * have inherited another cadence. Provider sample freshness remains separate.
 */
export function heartbeatReceptionView(
	reception: HeartbeatReception | undefined,
	runId: string | null,
	nowMs: number,
	mode: "live" | "finished",
) {
	const empty = {
		state: "unavailable" as ReceptionState,
		sampleState: "unknown" as ReceptionSampleState,
		latest: null as Extract<
			HeartbeatReception,
			{ state: "available" }
		>["latest"],
		cadenceSeconds: null as number | null,
		configuredIntervalS: null as number | null,
	};
	if (
		reception?.state !== "available" ||
		reception.runId !== runId ||
		(reception.latest !== null && runId === null) ||
		!Number.isFinite(nowMs)
	)
		return empty;
	const interval = reception.configuredIntervalS;
	const configuredIntervalS =
		typeof interval === "number" && Number.isFinite(interval) && interval >= 0
			? interval
			: null;
	if (!reception.latest)
		return { ...empty, state: "never" as const, configuredIntervalS };
	const received = parsed(reception.latest.receivedAt);
	if (received === null) return empty;
	const sampled = parsed(reception.latest.sampledAt);
	const previous = parsed(reception.previousReceivedAt);
	return {
		state:
			mode === "finished"
				? ("ended" as const)
				: freshness(received, nowMs, INGEST_CONNECTED_MAX_AGE_MS),
		sampleState:
			mode === "finished"
				? ("historical" as const)
				: sampled === null
					? ("unknown" as const)
					: freshness(sampled, nowMs, INGEST_CONNECTED_MAX_AGE_MS),
		latest: reception.latest,
		cadenceSeconds:
			previous !== null && received > previous
				? (received - previous) / 1_000
				: null,
		configuredIntervalS,
	};
}
