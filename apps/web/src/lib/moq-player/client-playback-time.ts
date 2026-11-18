import {
	MOQ_OBSERVATION_LIMITS,
	type MoqObservationSession,
} from "./observations";

function utcEpoch(value: string): number | null {
	if (typeof value !== "string") return null;
	const parts = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/.exec(
		value,
	);
	if (!parts) return null;
	const epoch = Date.parse(value);
	if (!Number.isFinite(epoch)) return null;
	const canonical = `${parts[1]}.${(parts[2] ?? "").padEnd(3, "0")}Z`;
	return new Date(epoch).toISOString() === canonical ? epoch : null;
}

function validEpoch(value: number): boolean {
	return Number.isFinite(value) && Number.isFinite(new Date(value).getTime());
}

/** Use the capture start as the estimated archive origin.
 * Older observations provide only first-frame time. */
export function moqArchiveClientOrigin(
	session: Pick<MoqObservationSession, "startedAt" | "events" | "archive">,
): number | null {
	if (!session?.archive || !Array.isArray(session.events)) return null;
	const startedAt = utcEpoch(session.startedAt);
	const recordingStarts = session.events.filter(
		(event) => event?.type === "recording-started",
	);
	const usesCaptureClock = session.events.some(
		(event) =>
			event?.type === "descriptor-ready" || event?.type === "observation-limit",
	);
	const anchors =
		recordingStarts.length || usesCaptureClock
			? recordingStarts
			: session.events.filter((event) => event?.type === "first-frame");
	const anchor = anchors[0];
	if (
		startedAt === null ||
		anchors.length !== 1 ||
		!anchor ||
		!Number.isSafeInteger(anchor.elapsedMs) ||
		anchor.elapsedMs < 0 ||
		anchor.elapsedMs > MOQ_OBSERVATION_LIMITS.durationMs
	)
		return null;
	const origin = startedAt + anchor.elapsedMs;
	return validEpoch(origin) ? origin : null;
}

/** Reconstruct the historical client clock from the native recording position.
 * This is not a per-packet observation; image, latency and today's clock are unused.
 */
export function moqArchiveClientTime(
	originUtcMs: number | null,
	positionSeconds: number,
	durationMs: number,
): number | null {
	if (
		originUtcMs === null ||
		!validEpoch(originUtcMs) ||
		!Number.isFinite(positionSeconds) ||
		positionSeconds < 0 ||
		!Number.isFinite(durationMs) ||
		durationMs < 1 ||
		durationMs > MOQ_OBSERVATION_LIMITS.archiveDurationMs
	)
		return null;
	const positionMs = positionSeconds * 1000;
	if (!Number.isFinite(positionMs) || positionMs > durationMs + 1) return null;
	// Native media duration/position conversion may overshoot by at most 1ms.
	const mapped = originUtcMs + Math.min(positionMs, durationMs);
	return validEpoch(mapped) ? mapped : null;
}
