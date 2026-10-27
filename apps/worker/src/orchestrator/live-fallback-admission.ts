import {
	LIVE_FALLBACK_REGIONS_UNSUPPORTED,
	type LiveChannelPlan,
	liveFallbackRegionIssues,
	type StepLogEntry,
} from "@bitovp/core";

/** Check only CREATE payloads this attempt will create or use for a pending START. */
export function liveFallbackAdmissionError(
	plan: LiveChannelPlan,
	entries: readonly StepLogEntry[] = [],
): string | undefined {
	const configured = liveFallbackRegionIssues(plan)[0];
	if (configured) return configured.message;
	const pendingStartTargets = new Set(
		entries.flatMap((entry) =>
			entry.kind === "START_LIVE_ENCODING" &&
			entry.status !== "DONE" &&
			typeof entry.refs.encodingId === "string"
				? [entry.refs.encodingId]
				: [],
		),
	);
	return entries.some(
		(entry) =>
			entry.kind === "CREATE_ENCODING" &&
			(entry.status !== "DONE" || pendingStartTargets.has(entry.step)) &&
			Array.isArray(entry.payload.fallbackCloudRegions) &&
			entry.payload.fallbackCloudRegions.length > 0,
	)
		? LIVE_FALLBACK_REGIONS_UNSUPPORTED
		: undefined;
}
