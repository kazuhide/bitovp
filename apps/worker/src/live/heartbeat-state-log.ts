import {
	describeHeartbeatStateChange,
	type HeartbeatSampleRef,
	heartbeatStateChanges,
} from "@bitovp/core";

/**
 * One `console.info` line per heartbeat STATE CHANGE, never one per poll.
 *
 * Two slate failures on 2026-09-02 produced ZERO worker lines while the
 * provider's heartbeat carried `WARNING`/`DISCONNECT` entries inside each
 * raw row — the only record was a Json column nobody tails. The sweep now
 * says what changed between consecutive samples: the ingest status word,
 * every provider event that appeared, and the output lane flipping between
 * flowing and stalled (the run-health derivation). A healthy poll — same
 * word, same list, output still flowing — logs nothing, so the log stays a
 * record of transitions an operator can grep by channel id.
 *
 * Pure derivation in core (`heartbeatStateChanges`); this is the sink.
 */
export function logHeartbeatStateChanges(
	liveChannelId: string,
	previous: HeartbeatSampleRef | null,
	current: HeartbeatSampleRef,
	sink: (line: string) => void = (line) => console.info(line),
): number {
	const changes = heartbeatStateChanges(previous, current);
	for (const change of changes) {
		sink(
			`[live-channel] ${liveChannelId} heartbeat ${describeHeartbeatStateChange(change)}`,
		);
	}
	return changes.length;
}

/**
 * The persisted `lastHeartbeat` column as a sample reference — `{ at, raw }`
 * of the worker's `PersistedHeartbeat` wrapper; null when absent or when the
 * column does not carry a parseable poll time (a re-air clears it).
 */
export function heartbeatSampleRef(column: unknown): HeartbeatSampleRef | null {
	if (typeof column !== "object" || column === null) {
		return null;
	}
	const { at, raw } = column as { at?: unknown; raw?: unknown };
	if (typeof at !== "string" || !Number.isFinite(Date.parse(at))) {
		return null;
	}
	return { at, raw };
}
