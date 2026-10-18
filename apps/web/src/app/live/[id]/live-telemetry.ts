import {
	heartbeatSampleFresh,
	INGEST_CONNECTED_MAX_AGE_MS,
	outputFlowingAt,
} from "@bitovp/core";
import type { HeartbeatReception } from "../live-shared";
import { summarizeOrigin } from "./delivery-status";
import { heartbeatReceptionView } from "./heartbeat-reception";

function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}
type Sample = { at: string; raw: unknown; deltas: unknown };
function pollSample(value: unknown): Sample | null {
	const row = record(value);
	return typeof row?.at === "string" &&
		Number.isFinite(Date.parse(row.at)) &&
		record(row.raw)
		? { at: row.at, raw: row.raw, deltas: row.deltas ?? {} }
		: null;
}
function sampleFresh(sample: Sample, nowMs: number): boolean {
	const timestamp = record(sample.raw)?.timestamp;
	return (
		heartbeatSampleFresh(sample, nowMs) &&
		(timestamp === undefined || heartbeatSampleFresh({ at: timestamp }, nowMs))
	);
}

/** Display-only selection. It does not write Poll mirrors or authorize lifecycle actions. */
export function selectLiveTelemetry(input: {
	reception?: HeartbeatReception;
	runId: string | null;
	poll: unknown;
	nowMs: number;
	mode: "live" | "finished";
}) {
	const reception = heartbeatReceptionView(
		input.reception,
		input.runId,
		input.nowMs,
		input.mode,
	);
	const historical = input.mode === "finished";
	const pushCurrent =
		reception.state === "fresh" && reception.sampleState === "fresh";
	const push = reception.latest;
	const poll = pollSample(input.poll);
	const source: "push" | "poll" | "none" =
		push?.sampledAt &&
		Number.isFinite(Date.parse(push.sampledAt)) &&
		(pushCurrent || historical)
			? "push"
			: poll && (historical || sampleFresh(poll, input.nowMs))
				? "poll"
				: "none";
	const sample: Sample | null =
		source === "push" && push?.sampledAt
			? { at: push.sampledAt, raw: push.raw, deltas: {} }
			: source === "poll"
				? poll
				: null;
	const previous =
		source === "push" && input.reception?.state === "available"
			? input.reception.previous
			: null;
	const previousMs = previous?.sampledAt
		? Date.parse(previous.sampledAt)
		: Number.NaN;
	const sampleMs = sample ? Date.parse(sample.at) : Number.NaN;
	const providerTimestamp =
		source === "push" ? sample?.at : record(sample?.raw)?.timestamp;
	const providerMs =
		typeof providerTimestamp === "string"
			? Date.parse(providerTimestamp)
			: Number.NaN;
	const previousUsable =
		Number.isFinite(previousMs) &&
		Number.isFinite(sampleMs) &&
		sampleMs > previousMs &&
		sampleMs - previousMs <= INGEST_CONNECTED_MAX_AGE_MS;
	return {
		source,
		sample,
		reception,
		historical,
		current: !historical && sample !== null,
		providerSampleAtMs: Number.isFinite(providerMs) ? providerMs : undefined,
		previousRaw: previousUsable ? previous?.raw : null,
		previousSampleAtMs: previousUsable ? previousMs : undefined,
	};
}

export type LiveTelemetry = ReturnType<typeof selectLiveTelemetry>;
export type DeliveryNotice =
	| "ENDED"
	| "UNKNOWN"
	| "INPUT_WAITING"
	| "INPUT_LOST"
	| "OUTPUT_STALLED"
	| "OUTPUT_UNKNOWN"
	| "PUSH_UNAVAILABLE"
	| "HEALTHY";
export type DeliveryInput =
	| "CONNECTED"
	| "WAITING_FOR_FIRST_CONNECT"
	| "DISCONNECTED"
	| "ERROR"
	| "UNKNOWN";

/** The core reader expects arrays; signed provider JSON still needs shape/size checks. */
function observedOutput(raw: unknown, atMs: number): boolean | null {
	const manifests = record(record(record(raw)?.output)?.manifests);
	const hls = manifests?.hls;
	if (!Array.isArray(hls) || hls.length > 100) return null;
	for (const value of hls) {
		const manifest = record(value);
		if (!manifest) return null;
		const updates = manifest.manifestUpdates ?? [];
		if (!Array.isArray(updates) || updates.length > 1000) return null;
		for (const value of updates) {
			const update = record(value);
			if (
				!update ||
				(update.manifestUpdateWallClockTime != null &&
					typeof update.manifestUpdateWallClockTime !== "string")
			)
				return null;
		}
	}
	return outputFlowingAt(raw, atMs);
}

/** Independently fresh origin evidence wins for output; a missing observer is not a failure. */
export function deliveryDiagnosis(
	telemetry: LiveTelemetry,
	observation: unknown,
	nowMs: number,
) {
	const origin = summarizeOrigin(observation);
	const originFresh =
		origin.lastFetchAtMs !== null &&
		heartbeatSampleFresh(
			{ at: new Date(origin.lastFetchAtMs).toISOString() },
			nowMs,
		);
	const originKnown =
		originFresh && (origin.state === "advancing" || origin.state === "stale");
	const ingest = record(record(telemetry.sample?.raw)?.ingest);
	const statuses: readonly unknown[] = [
		"CONNECTED",
		"WAITING_FOR_FIRST_CONNECT",
		"DISCONNECTED",
		"ERROR",
	];
	const input: DeliveryInput =
		telemetry.current && statuses.includes(ingest?.status)
			? ingest?.status === "CONNECTED" && ingest.healthy === false
				? "ERROR"
				: (ingest?.status as DeliveryInput)
			: "UNKNOWN";
	const reportedOutput =
		telemetry.current && telemetry.sample
			? observedOutput(
					telemetry.sample.raw,
					telemetry.providerSampleAtMs ?? Date.parse(telemetry.sample.at),
				)
			: null;
	const output: "advancing" | "stalled" | "unknown" = telemetry.historical
		? "unknown"
		: originKnown
			? origin.state === "advancing"
				? "advancing"
				: "stalled"
			: reportedOutput === null
				? "unknown"
				: reportedOutput
					? "advancing"
					: "stalled";
	const outputSource = telemetry.historical
		? "none"
		: originKnown
			? "origin"
			: reportedOutput !== null
				? telemetry.source
				: "none";
	const notice: DeliveryNotice = telemetry.historical
		? "ENDED"
		: input === "DISCONNECTED" || input === "ERROR"
			? "INPUT_LOST"
			: input === "WAITING_FOR_FIRST_CONNECT"
				? "INPUT_WAITING"
				: output === "stalled"
					? "OUTPUT_STALLED"
					: !telemetry.current || input === "UNKNOWN"
						? "UNKNOWN"
						: telemetry.source === "poll"
							? "PUSH_UNAVAILABLE"
							: output === "unknown"
								? "OUTPUT_UNKNOWN"
								: "HEALTHY";
	return { input, output, outputSource, notice };
}
