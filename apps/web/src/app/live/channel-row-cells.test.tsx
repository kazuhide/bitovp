import { describe, expect, it } from "vitest";
import { renderLocalized } from "@/test/render";
import { readChannelHealth } from "./channel-health";
import { HealthCell } from "./channel-row-cells";
import type { LiveChannelListItem } from "./live-shared";

const now = Date.parse("2026-09-07T16:54:12Z");
type Origin = NonNullable<LiveChannelListItem["health"]>["origin"];
const advancing: Origin = {
	observed: 2,
	stale: 0,
	endlist: 0,
	unavailableReason: null,
};
function reading(status: LiveChannelListItem["status"], origin: Origin) {
	return readChannelHealth(
		{
			id: "channel",
			name: "Run21",
			status,
			error: null,
			bitmovinAccountId: null,
			bitmovinEncodingId: "encoding",
			createdAt: "2026-09-07T16:40:27Z",
			updatedAt: "2026-09-07T16:53:33Z",
			health: {
				heartbeat: null,
				openAlerts: 0,
				activeFeeders: 0,
				erroredFeeders: 0,
				origin,
				runningSince: null,
				endedAt: null,
				maxRunMinutes: null,
			},
		},
		now,
	);
}
describe("Live list output history", () => {
	for (const locale of ["ja", "en"] as const) {
		it.each([
			"STOPPED",
			"ERROR",
		] as const)(`${locale}: %s retains final progression without claiming ongoing output`, (status) => {
			const { container } = renderLocalized(
				<HealthCell health={reading(status, advancing)} />,
				locale,
			);
			const facet = container.querySelector('[data-health-facet="output"]');
			expect(facet).toHaveTextContent(
				locale === "ja"
					? "最終出力 進行を確認"
					: "Last output Advancement observed",
			);
			expect(facet).not.toHaveTextContent(
				locale === "ja" ? "進行中" : "Advancing",
			);
			expect(facet?.querySelector(".text-emerald-400")).toBeNull();
		});
	}
	it.each([
		"RUNNING",
		"STOPPING",
	] as const)("%s retains active output reading", (status) => {
		const { container } = renderLocalized(
			<HealthCell health={reading(status, advancing)} />,
		);
		const facet = container.querySelector('[data-health-facet="output"]');
		expect(facet).toHaveTextContent("Output Advancing");
		expect(facet).not.toHaveTextContent("Last output");
		expect(facet?.querySelector(".text-emerald-400")).not.toBeNull();
	});
	it.each([
		[{ ...advancing, stale: 1 }, "Stalled"],
		[{ ...advancing, endlist: 1 }, "Ended"],
	] as const)("keeps historical output failure/end verdict visible", (origin, expected) => {
		const health = reading("ERROR", origin);
		const { container } = renderLocalized(<HealthCell health={health} />);
		const facet = container.querySelector('[data-health-facet="output"]');
		expect(facet).toHaveTextContent(`Last output ${expected}`);
		expect(health.anomalies).toContain("ERROR");
		expect(facet?.querySelector(".text-red-400")).toBeNull();
	});
	it("missing observation remains unknown, not a manufactured historical success", () => {
		const { container } = renderLocalized(
			<HealthCell health={reading("STOPPED", null)} />,
		);
		const facet = container.querySelector('[data-health-facet="output"]');
		expect(facet).toHaveTextContent("Output unknown");
		expect(facet).not.toHaveTextContent("Advancement observed");
	});
});
