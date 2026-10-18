import type { RunTimelineEvent, RunTimelineWindow } from "@bitovp/core";
import type { HeartbeatReception } from "../live-shared";

export type DisplayTimelineEvent = Omit<RunTimelineEvent, "kind" | "source"> & {
	kind: RunTimelineEvent["kind"] | "INPUT_RECONNECTED";
	source: RunTimelineEvent["source"] | "push";
};

/** Overlay explicit Push history only; receipt gaps never create state transitions. */
export function mergePushTimeline(
	poll: RunTimelineEvent[],
	reception: HeartbeatReception | undefined,
	runId: string,
	window: RunTimelineWindow,
	nowMs: number,
): DisplayTimelineEvent[] {
	if (
		reception?.state !== "available" ||
		reception.runId !== runId ||
		!reception.timeline
	)
		return poll;
	const endMs = Math.min(window.endMs ?? nowMs, nowMs);
	const seen = new Set<string>();
	const push: DisplayTimelineEvent[] = [];
	for (const event of reception.timeline.events.slice(0, 100)) {
		const atMs = Date.parse(event.eventAt);
		const receivedMs = Date.parse(event.observedReceivedAt);
		if (
			!Number.isFinite(atMs) ||
			!Number.isFinite(receivedMs) ||
			atMs < window.startMs ||
			atMs > endMs ||
			receivedMs < window.startMs ||
			receivedMs > nowMs
		)
			continue;
		const kind =
			event.kind === "FIRST_CONNECT"
				? "INPUT_CONNECTED"
				: event.kind === "RECONNECT"
					? "INPUT_RECONNECTED"
					: event.kind === "DISCONNECT"
						? "INPUT_DISCONNECTED"
						: null;
		const key = `${kind}:${atMs}`;
		if (!kind || seen.has(key)) continue;
		seen.add(key);
		push.push({ kind, atMs, source: "push" });
	}
	push.sort((a, b) => a.atMs - b.atMs);
	const omitted = new Set<number>();
	// One-to-one nearest match, never across an opposite explicit transition.
	// This suppresses duplicate marks, not the independently observed Poll lines.
	for (const event of push) {
		const disconnected = event.kind === "INPUT_DISCONNECTED";
		const candidates = poll
			.map((p, i) => ({ p, i }))
			.filter(
				({ p, i }) =>
					!omitted.has(i) &&
					p.source === "heartbeat" &&
					p.kind ===
						(disconnected ? "INPUT_DISCONNECTED" : "INPUT_CONNECTED") &&
					Math.abs(p.atMs - event.atMs) <= 90_000 &&
					!push.some(
						(other) =>
							(other.kind === "INPUT_DISCONNECTED") !== disconnected &&
							other.atMs > Math.min(event.atMs, p.atMs) &&
							other.atMs < Math.max(event.atMs, p.atMs),
					),
			)
			.sort(
				(a, b) =>
					Math.abs(a.p.atMs - event.atMs) - Math.abs(b.p.atMs - event.atMs),
			);
		if (candidates[0]) omitted.add(candidates[0].i);
	}
	return [...poll.filter((_, i) => !omitted.has(i)), ...push].sort(
		(a, b) => a.atMs - b.atMs,
	);
}
