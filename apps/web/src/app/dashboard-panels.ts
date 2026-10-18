export const DASHBOARD_HIDDEN_PANELS_KEY = "ovp-dashboard-hidden-panels";

/**
 *  (owner, 2026-09-06): the seven operational cards (attention, on
 * air, upcoming, recent failures, running encodings, VMAF reports, system
 * health) are gone — every one of them is a list screen's job. The landing
 * page is Bitmovin usage now: billable minutes and the codec ×
 * resolution breakdown, from the worker's daily statistics snapshot.
 */
export const DASHBOARD_USAGE_PANEL_IDS = [
	"usage-minutes",
	"usage-breakdown",
] as const;

export const DASHBOARD_INSIGHT_PANEL_IDS = [
	"jobs-by-day",
	"live-airtime",
] as const;

export const DASHBOARD_PANEL_IDS = [
	...DASHBOARD_USAGE_PANEL_IDS,
	...DASHBOARD_INSIGHT_PANEL_IDS,
] as const;

export type DashboardPanelId = (typeof DASHBOARD_PANEL_IDS)[number];

const KNOWN_PANEL_IDS = new Set<string>(DASHBOARD_PANEL_IDS);

function isDashboardPanelId(value: unknown): value is DashboardPanelId {
	return typeof value === "string" && KNOWN_PANEL_IDS.has(value);
}

/**
 * Per-browser presentation preference. Hidden ids are stored instead of visible
 * ids so a panel introduced by a later build appears by default.
 */
export function readHiddenDashboardPanels(): Set<DashboardPanelId> {
	if (typeof window === "undefined") {
		return new Set();
	}
	try {
		const raw = window.localStorage.getItem(DASHBOARD_HIDDEN_PANELS_KEY);
		if (raw === null) {
			return new Set();
		}
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) {
			return new Set();
		}
		return new Set(parsed.filter(isDashboardPanelId));
	} catch {
		return new Set();
	}
}

/** Best-effort write: blocked site data loses the preference, not the page. */
export function writeHiddenDashboardPanels(
	hidden: ReadonlySet<DashboardPanelId>,
): void {
	if (typeof window === "undefined") {
		return;
	}
	try {
		window.localStorage.setItem(
			DASHBOARD_HIDDEN_PANELS_KEY,
			JSON.stringify(DASHBOARD_PANEL_IDS.filter((id) => hidden.has(id))),
		);
	} catch {
		// Private mode or blocked site data. The all-visible fallback remains usable.
	}
}

export function dashboardPanelIsVisible(
	hidden: ReadonlySet<DashboardPanelId>,
	id: DashboardPanelId,
): boolean {
	return !hidden.has(id);
}
