import { type AlertMetric, METRIC_CLASS } from "@bitovp/core";
import type { MessageKey } from "@/lib/i18n";

/**
 * : both alert panels carried their own four-case label switch
 * with `default: return value` — so when #94 added PROGRAM_START_NO_INGEST
 * to the metric union, the rules editor and the channel-detail banner
 * rendered the raw enum string in BOTH locales, and no test noticed
 * (the settings <select> is populated from ALERT_METRICS, so the union
 * and the hand lists drifted silently). One map, `satisfies` the union:
 * the NEXT metric added without a label is a tsc error, not a raw string
 * in production (the same `METRIC_CLASS` exhaustiveness pattern, applied
 * retroactively).
 */
const METRIC_LABEL_KEY = {
	INPUT_DISCONNECTED: "alerts.metricInputDisconnected",
	HEARTBEAT_STALE: "alerts.metricHeartbeatStale",
	BITRATE_BELOW: "alerts.metricBitrateBelow",
	FPS_BELOW: "alerts.metricFpsBelow",
	PROGRAM_START_NO_INGEST: "alerts.metricProgramStartNoIngest",
	//  — the origin observer's BITOVP×DELIVERY trio.
	ORIGIN_MANIFEST_STALE: "alerts.metricOriginManifestStale",
	ORIGIN_ENDLIST_PRESENT: "alerts.metricOriginEndlistPresent",
	ORIGIN_EDGE_DELAY_ABOVE: "alerts.metricOriginEdgeDelayAbove",
	// The encoder's own WARNING/ERROR entries (heartbeat events[]).
	PROVIDER_WARNING: "alerts.metricProviderWarning",
} satisfies Record<AlertMetric, MessageKey>;

/**
 *  §2 — the pair rendered beside every alert signal. Source
 * stays a proper noun; subject translates. The sentence that matters (the
 * panel's help carries it): a BITMOVIN signal is Bitmovin's self-report
 * relayed by bitovp; a BITOVP signal is bitovp's own measurement and
 * stands even when the self-report disagrees.
 */
export function metricProvenance(value: string): {
	sourceName?: string;
	sourceKey?: MessageKey;
	subjectKey: MessageKey;
} | null {
	const cls = METRIC_CLASS[value as AlertMetric];
	if (!cls) {
		return null;
	}
	return {
		...(cls.source === "BITOVP"
			? { sourceKey: "origin.title" as const }
			: { sourceName: "Bitmovin" }),
		subjectKey:
			cls.subject === "DELIVERY"
				? "alerts.subjectDelivery"
				: "alerts.subjectIngest",
	};
}

export function alertMetricLabelKey(value: string): MessageKey | null {
	return value in METRIC_LABEL_KEY
		? METRIC_LABEL_KEY[value as AlertMetric]
		: null;
}
