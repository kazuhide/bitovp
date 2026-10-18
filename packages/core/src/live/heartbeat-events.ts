import { outputFlowingAt } from "./run-health";

/**
 * The live heartbeat's `events[]` — the provider's own event log for the
 * encoding — and the STATE CHANGES between two consecutive samples.
 *
 * Measured against persisted rows (2026-09-02, 214 samples of one run and
 * five older runs): `events[]` is CUMULATIVE for the encoding. A
 * `FIRST_CONNECT` and the `WARNING: At least one input video stream
 * key-frame interval is larger than the threshold…` stamped at 07:49 were
 * still the whole list at 09:31, and the provider even repeats an identical
 * entry (the AV-sync WARNING appeared twice with the same `time` and
 * `message` in one sample). So "an event happened" can only be read as a
 * DIFFERENCE between samples — an entry present now that the previous sample
 * did not carry — never as presence, and two entries with the same time, type
 * and message are one event.
 *
 * Wire shape (SDK `LiveEncodingHeartbeatEvent`, JSON round-tripped by the
 * worker): `{ time: ISO, details: { eventType, message } }` with
 * `eventType ∈ FIRST_CONNECT | DISCONNECT | RECONNECT | WARNING | ERROR` and
 * `message` null for the connect family. Everything here is defensive
 * against shape drift: an entry that is not an object still becomes an event
 * (its JSON as the message) rather than being dropped, because a dropped
 * event is exactly the thing an operator would never learn about.
 */

export const PROVIDER_EVENT_TYPES = [
	"FIRST_CONNECT",
	"DISCONNECT",
	"RECONNECT",
	"WARNING",
	"ERROR",
] as const;
export type ProviderEventType = (typeof PROVIDER_EVENT_TYPES)[number];

export type ProviderHeartbeatEvent = {
	/** The provider's stamp (ISO) — null when absent or unparseable. */
	time: string | null;
	/** The wire word; an unknown word is kept verbatim, never normalized away. */
	eventType: string;
	message: string | null;
	/** Identity for set difference: `time|eventType|message`. */
	key: string;
};

/** WARNING and ERROR — the two event types that describe a fault. */
export function isProviderFault(event: { eventType: string }): boolean {
	return event.eventType === "WARNING" || event.eventType === "ERROR";
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function isoOrNull(value: unknown): string | null {
	if (typeof value !== "string" || value === "") {
		return null;
	}
	return Number.isFinite(Date.parse(value)) ? value : null;
}

function parseEvent(entry: unknown): ProviderHeartbeatEvent {
	const record = asRecord(entry);
	if (!record) {
		const text = entry === undefined ? "undefined" : JSON.stringify(entry);
		return { time: null, eventType: "UNKNOWN", message: text, key: text };
	}
	const details = asRecord(record.details) ?? record;
	const time = isoOrNull(record.time) ?? isoOrNull(record.timestamp);
	const eventType =
		typeof details.eventType === "string" && details.eventType !== ""
			? details.eventType
			: typeof record.type === "string" && record.type !== ""
				? record.type
				: "UNKNOWN";
	const message =
		typeof details.message === "string" && details.message !== ""
			? details.message
			: null;
	return {
		time,
		eventType,
		message,
		key: `${time ?? ""}|${eventType}|${message ?? ""}`,
	};
}

/**
 * The sample's event list, parsed and DEDUPLICATED by identity, in list
 * order. Reads `raw.events`; anything else — no list, a non-array — is an
 * empty list, never a throw.
 */
export function providerHeartbeatEvents(
	raw: unknown,
): ProviderHeartbeatEvent[] {
	const events = asRecord(raw)?.events;
	if (!Array.isArray(events)) {
		return [];
	}
	const seen = new Set<string>();
	const out: ProviderHeartbeatEvent[] = [];
	for (const entry of events) {
		const event = parseEvent(entry);
		if (seen.has(event.key)) {
			continue;
		}
		seen.add(event.key);
		out.push(event);
	}
	return out;
}

/**
 * Events the current sample carries that the previous one did not — the only
 * reading of "an event happened between these polls" a cumulative list
 * supports. A `null`/absent previous sample means every current event is new
 * (the run's first sample), which is exactly right for a fresh encoding and
 * exactly wrong for a window whose predecessor merely was not fetched — that
 * distinction belongs to the caller (`evaluateAlertRules`' PROVIDER_WARNING
 * arm says how it decides).
 */
export function newProviderEvents(
	previousRaw: unknown,
	currentRaw: unknown,
): ProviderHeartbeatEvent[] {
	const before = new Set(
		providerHeartbeatEvents(previousRaw).map((event) => event.key),
	);
	return providerHeartbeatEvents(currentRaw).filter(
		(event) => !before.has(event.key),
	);
}

/** One persisted sample, as the worker writes it (`{ at, raw }`). */
export type HeartbeatSampleRef = {
	/** Poll time (ours), ISO. */
	at: string;
	raw: unknown;
};

export type OutputState = "FLOWING" | "STALLED" | "UNOBSERVABLE";

/**
 * The output lane's word for one sample — `outputFlowingAt` with its
 * three-way answer named: no manifest update at all is UNOBSERVABLE (a
 * DASH-only plan, or an encoder that has not produced output yet), never
 * "stalled".
 */
export function outputStateOf(sample: HeartbeatSampleRef): OutputState {
	const atMs = Date.parse(sample.at);
	if (!Number.isFinite(atMs)) {
		return "UNOBSERVABLE";
	}
	const flowing = outputFlowingAt(sample.raw, atMs);
	if (flowing === null) {
		return "UNOBSERVABLE";
	}
	return flowing ? "FLOWING" : "STALLED";
}

function ingestStatusOf(raw: unknown): string | null {
	const status = asRecord(asRecord(raw)?.ingest)?.status;
	return typeof status === "string" && status !== "" ? status : null;
}

export type HeartbeatStateChange =
	| { kind: "INGEST_STATUS"; from: string | null; to: string }
	| { kind: "PROVIDER_EVENT"; event: ProviderHeartbeatEvent }
	| { kind: "OUTPUT"; from: OutputState | null; to: OutputState };

/**
 * What CHANGED between the previous persisted sample and this one — the
 * worker logs exactly these, one line each, and nothing per poll:
 *
 *  - the ingest status word moved (null → first word counts: the run's first
 *    sample says what state the encoder started in);
 *  - a provider event appeared that the previous sample did not carry
 *    (`newProviderEvents`), every type, so a FIRST_CONNECT/DISCONNECT/
 *    RECONNECT is one line beside the WARNING/ERROR ones;
 *  - the output lane flipped between FLOWING and STALLED (the existing
 *    run-health derivation), or first became FLOWING. UNOBSERVABLE is never
 *    a transition target and an initial STALLED is not one either: an
 *    encoder that has produced nothing yet is not an output that stopped.
 *
 * A `null` previous sample is the run's first poll (or a channel whose column
 * was cleared by a re-air); it reports the initial ingest word and the first
 * sample's events, which are new by definition.
 */
export function heartbeatStateChanges(
	previous: HeartbeatSampleRef | null,
	current: HeartbeatSampleRef,
): HeartbeatStateChange[] {
	const changes: HeartbeatStateChange[] = [];
	const fromStatus = previous ? ingestStatusOf(previous.raw) : null;
	const toStatus = ingestStatusOf(current.raw);
	if (toStatus !== null && toStatus !== fromStatus) {
		changes.push({ kind: "INGEST_STATUS", from: fromStatus, to: toStatus });
	}
	for (const event of newProviderEvents(previous?.raw, current.raw)) {
		changes.push({ kind: "PROVIDER_EVENT", event });
	}
	const fromOutput = previous ? outputStateOf(previous) : null;
	const toOutput = outputStateOf(current);
	const flipped =
		toOutput !== "UNOBSERVABLE" &&
		toOutput !== fromOutput &&
		(toOutput === "FLOWING" || fromOutput === "FLOWING");
	if (flipped) {
		changes.push({ kind: "OUTPUT", from: fromOutput, to: toOutput });
	}
	return changes;
}

/**
 * One log line per change — the worker's `console.info` text. Stable,
 * grep-able prefixes (`ingest`, `event`, `output`) and the provider's own
 * words after them; the message is passed through verbatim because it is the
 * diagnosis (the 2167 ms ≥ 2000 ms figure is the whole finding).
 */
export function describeHeartbeatStateChange(
	change: HeartbeatStateChange,
): string {
	switch (change.kind) {
		case "INGEST_STATUS":
			return `ingest ${change.from ?? "(none)"} → ${change.to}`;
		case "PROVIDER_EVENT": {
			const { event } = change;
			const stamp = event.time ? ` @${event.time}` : "";
			return event.message
				? `event ${event.eventType}${stamp}: ${event.message}`
				: `event ${event.eventType}${stamp}`;
		}
		case "OUTPUT":
			return change.to === "FLOWING"
				? `output ${change.from === "STALLED" ? "unstalled" : "flowing"}`
				: "output stalled";
	}
}
