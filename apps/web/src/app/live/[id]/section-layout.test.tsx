import { cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { renderLocalized } from "@/test/render";
import {
	LIVE_PHASES,
	LIVE_SECTION_TITLE_KEYS,
	type LivePhase,
	type LiveSectionId,
	liveBodyLayers,
	liveSectionOrder,
} from "./section-layout";
import { LiveSectionNav } from "./section-nav";

afterEach(cleanup);

const ORDINARY_BODY = [
	"sec-alerts",
	"sec-manifests",
	"sec-slate",
	"sec-insertion",
	"sec-schedule",
	"sec-insertion-stop",
	"sec-cue",
	"sec-esam",
	"sec-ingest",
	"sec-feeders",
	"sec-dvr",
	"sec-dns",
	"sec-live-to-vod",
	"sec-vmaf",
	"sec-heartbeat-log",
	"sec-alert-rules",
	"sec-runs",
	"sec-steps",
	"sec-ladder",
	"sec-runtime-cap",
	"sec-advanced",
	"sec-danger",
] as const;

const BODY_WITH_INGEST_LEAD = ORDINARY_BODY.filter((id) => id !== "sec-ingest");
const ORDINARY_ORDER: Record<LivePhase, readonly LiveSectionId[]> = {
	prepare: ["sec-actions", "sec-ingest", ...BODY_WITH_INGEST_LEAD],
	starting: [
		"sec-actions",
		"sec-ingest",
		"sec-heartbeat",
		"sec-origin",
		...BODY_WITH_INGEST_LEAD,
	],
	onair: ["sec-actions", "sec-heartbeat", "sec-origin", ...ORDINARY_BODY],
	finished: [
		"sec-actions",
		"sec-last-run",
		"sec-heartbeat",
		"sec-origin",
		...ORDINARY_BODY,
	],
};

describe("optional key moments in the normal live layout", () => {
	it.each(LIVE_PHASES)("preserves the complete ordinary %s order", (phase) => {
		expect(liveSectionOrder(phase)).toEqual(ORDINARY_ORDER[phase]);
		expect(liveSectionOrder(phase, [], { keyMoments: false })).toEqual(
			ORDINARY_ORDER[phase],
		);
		expect(liveBodyLayers(phase).flatMap((layer) => layer.sections)).toEqual(
			phase === "prepare" || phase === "starting"
				? BODY_WITH_INGEST_LEAD
				: ORDINARY_BODY,
		);
	});

	it.each(
		LIVE_PHASES,
	)("adds key moments once after manifests in enabled %s layout and order", (phase) => {
		const layers = liveBodyLayers(phase, [], { keyMoments: true });
		expect(
			layers.find((layer) => layer.id === "layer-operations")?.sections,
		).toEqual(["sec-alerts", "sec-manifests", "sec-analysis", "sec-slate"]);
		expect(
			layers
				.flatMap((layer) => layer.sections)
				.filter((id) => id === "sec-analysis"),
		).toHaveLength(1);

		const order = liveSectionOrder(phase, [], { keyMoments: true });
		expect(order.filter((id) => id === "sec-analysis")).toHaveLength(1);
		expect(order[order.indexOf("sec-manifests") + 1]).toBe("sec-analysis");
		expect(order.filter((id) => id !== "sec-analysis")).toEqual(
			ORDINARY_ORDER[phase],
		);
	});

	it.each(
		LIVE_PHASES,
	)("honors explicit omission in enabled %s layout", (phase) => {
		const omit: LiveSectionId[] = ["sec-analysis", "sec-vmaf"];
		const sections = liveBodyLayers(phase, omit, { keyMoments: true }).flatMap(
			(layer) => layer.sections,
		);
		expect(sections).not.toContain("sec-analysis");
		expect(sections).not.toContain("sec-vmaf");
		expect(liveSectionOrder(phase, omit, { keyMoments: true })).toEqual(
			ORDINARY_ORDER[phase].filter((id) => id !== "sec-vmaf"),
		);
	});

	it("keeps the ordinary navigation free of a key-moments link", () => {
		const { container } = renderLocalized(
			<LiveSectionNav layers={liveBodyLayers("onair")} />,
		);
		expect(container.querySelector('a[href="#sec-analysis"]')).toBeNull();
	});

	it("renders one key-moments navigation link using its shared title", () => {
		const { container } = renderLocalized(
			<LiveSectionNav
				layers={liveBodyLayers("onair", [], { keyMoments: true })}
			/>,
		);
		expect(LIVE_SECTION_TITLE_KEYS["sec-analysis"]).toBe("aisaLive.keyMoments");
		const links = container.querySelectorAll('a[href="#sec-analysis"]');
		expect(links).toHaveLength(1);
		expect(links.item(0)).toHaveTextContent(/key moments/i);
	});

	it("omits the key-moments navigation link even when enabled", () => {
		const { container } = renderLocalized(
			<LiveSectionNav
				layers={liveBodyLayers("onair", ["sec-analysis"], { keyMoments: true })}
			/>,
		);
		expect(container.querySelector('a[href="#sec-analysis"]')).toBeNull();
	});
});
