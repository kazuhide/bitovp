import { ALERT_METRICS } from "@bitovp/core";
import { describe, expect, it } from "vitest";
import { en } from "@/lib/i18n/messages/en";
import { ja } from "@/lib/i18n/messages/ja";
import { alertMetricLabelKey, metricProvenance } from "./alert-metric-label";

/**
 * : the population is the UNION, not a hand list — every metric
 * must resolve to a real key present in BOTH catalogues, so a metric can
 * never again render as its raw enum string (PROGRAM_START_NO_INGEST did,
 * in two panels and two locales, from #94 until this row).
 */
describe("alertMetricLabelKey (ledger #163)", () => {
	it("labels EVERY member of ALERT_METRICS in both catalogues", () => {
		expect(ALERT_METRICS.length).toBeGreaterThanOrEqual(5);
		for (const metric of ALERT_METRICS) {
			const key = alertMetricLabelKey(metric);
			expect(key, metric).not.toBeNull();
			const [ns, leaf] = (key as string).split(".");
			const enValue = (en as Record<string, Record<string, unknown>>)[
				ns as string
			]?.[leaf as string];
			const jaValue = (ja as Record<string, Record<string, unknown>>)[
				ns as string
			]?.[leaf as string];
			expect(typeof enValue, `${metric} → ${key} (en)`).toBe("string");
			expect(typeof jaValue, `${metric} → ${key} (ja)`).toBe("string");
			expect(enValue, metric).not.toBe(metric);
		}
	});

	it("answers null for an unknown value — the caller falls back to the raw string visibly", () => {
		expect(alertMetricLabelKey("NOT_A_METRIC")).toBeNull();
	});
});

describe("metricProvenance customer copy", () => {
	it("names product-side measurements with the localized output-monitoring label, never the repository name", () => {
		const provenance = metricProvenance("ORIGIN_MANIFEST_STALE");
		expect(provenance).toEqual({
			sourceKey: "origin.title",
			subjectKey: "alerts.subjectDelivery",
		});
		for (const messages of [en, ja]) {
			const label = messages.origin.title;
			expect(label).not.toMatch(/bitovp/i);
			expect(label.length).toBeGreaterThan(0);
		}
	});

	it("keeps the provider proper name for encoder self-report signals", () => {
		expect(metricProvenance("INPUT_DISCONNECTED")).toEqual({
			sourceName: "Bitmovin",
			subjectKey: "alerts.subjectIngest",
		});
	});

	it("uses output terminology familiar from AWS MediaLive for delivery alerts", () => {
		expect(ja.alerts.metricOriginManifestStale).toBe("出力マニフェストの停滞");
		expect(ja.alerts.metricOriginEdgeDelayAbove).toBe(
			"出力遅延がしきい値を超過",
		);
		expect(en.alerts.metricOriginManifestStale).toBe("Output manifest stale");
		expect(en.alerts.metricOriginEdgeDelayAbove).toBe(
			"Output delay above threshold",
		);
		expect(ja.live.list.filterErrorHint).toContain("更新が止まった出力");
		expect(ja.live.list.filterErrorHint).not.toContain("オリジン");
		expect(en.live.list.filterErrorHint).toContain(
			"an output that stopped advancing",
		);
	});
});
