import { act, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";
import { DashboardInsights } from "./dashboard-insights";
import { DASHBOARD_PANEL_IDS } from "./dashboard-panels";
import { DashboardUsage } from "./dashboard-usage";

const metric = {
	billableEncodingMinutes: 1,
	billableMinutes: 1,
	timeEncodedS: 60,
	bytesEncoded: 1,
	bytesEgress: 1,
	billableFeatureMinutes: 0,
	billableTransmuxingMinutes: 0,
};
const usage = {
	from: "2026-09-08",
	to: "2026-09-08",
	days: [{ date: "2026-09-08", VOD: metric, LIVE: metric }],
	totals: { VOD: metric, LIVE: metric },
	liveHd: {
		totalUnits: 1,
		missingDays: 0,
		days: [{ date: "2026-09-08", units: 1 }],
	},
	breakdown: {
		buckets: {
			VOD: { SD: 0, HD: 0, UHD: 0, AUDIO: 0, UNKNOWN: 0 },
			LIVE: { SD: 0, HD: 0, UHD: 0, AUDIO: 0, UNKNOWN: 0 },
		},
		codecResolution: [],
		egress: [],
	},
	accounts: [],
	pendingDays: 0,
	refreshedAt: "2026-09-08T00:00:00Z",
};
let observers: { callback: ResizeObserverCallback; target: Element }[];
let width: number;
beforeEach(() => {
	width = 0;
	observers = [];
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
		() => new DOMRect(0, 0, width, 176),
	);
	vi.stubGlobal(
		"ResizeObserver",
		class {
			constructor(private callback: ResizeObserverCallback) {}
			observe(target: Element) {
				observers.push({ callback: this.callback, target });
			}
			unobserve() {}
			disconnect() {
				observers = observers.filter(
					({ callback }) => callback !== this.callback,
				);
			}
		},
	);
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function panels(hidden = false) {
	const hiddenPanels = hidden ? new Set(DASHBOARD_PANEL_IDS) : new Set<never>();
	return (
		<>
			<DashboardUsage hiddenPanels={hiddenPanels} data={usage} />
			<DashboardInsights hiddenPanels={hiddenPanels} data={usage} />
		</>
	);
}
function resize(nextWidth: number) {
	width = nextWidth;
	act(() => {
		for (const { callback, target } of observers)
			callback(
				[
					{
						target,
						contentRect: new DOMRect(0, 0, width, 176),
					} as ResizeObserverEntry,
				],
				{} as ResizeObserver,
			);
	});
}

it("waits for measured width without negative-size warnings, then follows resize", async () => {
	const warn = vi.spyOn(console, "warn");
	const { container } = renderWithQuery(panels());
	await waitFor(() =>
		expect(
			container.querySelectorAll(".recharts-responsive-container"),
		).toHaveLength(4),
	);
	expect(container.querySelectorAll("svg.recharts-surface")).toHaveLength(0);
	expect(warn).not.toHaveBeenCalled();
	resize(600);
	await waitFor(() =>
		expect(
			container.querySelectorAll(
				"svg.recharts-surface[width='600'][height='176']",
			),
		).toHaveLength(4),
	);
	resize(320);
	await waitFor(() =>
		expect(
			container.querySelectorAll(
				"svg.recharts-surface[width='320'][height='176']",
			),
		).toHaveLength(4),
	);
	expect(warn).not.toHaveBeenCalled();
});

it("unmounts hidden panels and safely measures them again when shown", async () => {
	const warn = vi.spyOn(console, "warn");
	const { container, rerender } = renderWithQuery(panels(true));
	expect(
		container.querySelectorAll(".recharts-responsive-container"),
	).toHaveLength(0);
	rerender(panels());
	await waitFor(() =>
		expect(
			container.querySelectorAll(".recharts-responsive-container"),
		).toHaveLength(4),
	);
	resize(480);
	await waitFor(() =>
		expect(
			container.querySelectorAll("svg.recharts-surface[width='480']"),
		).toHaveLength(4),
	);
	rerender(panels(true));
	expect(
		container.querySelectorAll(".recharts-responsive-container"),
	).toHaveLength(0);
	width = 0;
	rerender(panels());
	await waitFor(() =>
		expect(
			container.querySelectorAll(".recharts-responsive-container"),
		).toHaveLength(4),
	);
	expect(container.querySelectorAll("svg.recharts-surface")).toHaveLength(0);
	resize(320);
	await waitFor(() =>
		expect(
			container.querySelectorAll("svg.recharts-surface[width='320']"),
		).toHaveLength(4),
	);
	expect(warn).not.toHaveBeenCalled();
});
