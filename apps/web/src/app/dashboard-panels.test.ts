import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	DASHBOARD_HIDDEN_PANELS_KEY,
	DASHBOARD_PANEL_IDS,
	dashboardPanelIsVisible,
	readHiddenDashboardPanels,
	writeHiddenDashboardPanels,
} from "./dashboard-panels";

let localStorageAtStart: Storage;

beforeEach(() => {
	localStorageAtStart = window.localStorage;
	window.localStorage.clear();
});

afterEach(() => {
	vi.restoreAllMocks();
	expect(window.localStorage).toBe(localStorageAtStart);
	window.localStorage.clear();
});

describe("dashboard panel preferences", () => {
	it("uses jsdom Storage so prototype-level failure injection is effective", () => {
		expect(Object.getPrototypeOf(window.localStorage)).toBe(Storage.prototype);
		const getItem = vi
			.spyOn(Storage.prototype, "getItem")
			.mockImplementation(() => {
				throw new Error("site data blocked");
			});

		expect(readHiddenDashboardPanels()).toEqual(new Set());
		expect(getItem).toHaveBeenCalledWith(DASHBOARD_HIDDEN_PANELS_KEY);
	});

	it("defines usage and trend panels without egress", () => {
		expect(DASHBOARD_PANEL_IDS).toEqual([
			"usage-minutes",
			"usage-breakdown",
			"jobs-by-day",
			"live-airtime",
		]);
	});

	it("preserves current hidden ids and drops retired and unknown ids", () => {
		window.localStorage.setItem(
			DASHBOARD_HIDDEN_PANELS_KEY,
			JSON.stringify([
				"usage-egress",
				"future-panel",
				"format-mix",
				"minutes-by-day",
				"jobs-by-day",
			]),
		);

		expect([...readHiddenDashboardPanels()]).toEqual(["jobs-by-day"]);
	});

	it.each([
		null,
		"not-json",
		"{}",
		"42",
	])("treats absent or malformed storage as all visible: %s", (raw) => {
		if (raw !== null) {
			window.localStorage.setItem(DASHBOARD_HIDDEN_PANELS_KEY, raw);
		}

		const hidden = readHiddenDashboardPanels();
		expect(hidden.size).toBe(0);
		for (const id of DASHBOARD_PANEL_IDS) {
			expect(dashboardPanelIsVisible(hidden, id)).toBe(true);
		}
	});

	it("makes a panel introduced after an old preference visible by default", () => {
		window.localStorage.setItem(
			DASHBOARD_HIDDEN_PANELS_KEY,
			JSON.stringify(["usage-egress"]),
		);

		const hidden = readHiddenDashboardPanels();
		expect(dashboardPanelIsVisible(hidden, "live-airtime")).toBe(true);
	});

	it("allows every known panel to be hidden", () => {
		writeHiddenDashboardPanels(new Set(DASHBOARD_PANEL_IDS));

		expect(
			JSON.parse(
				window.localStorage.getItem(DASHBOARD_HIDDEN_PANELS_KEY) ?? "[]",
			),
		).toEqual(DASHBOARD_PANEL_IDS);
	});

	it("degrades storage read and write errors without throwing", () => {
		const getItem = vi
			.spyOn(window.localStorage, "getItem")
			.mockImplementation(() => {
				throw new Error("site data blocked");
			});
		expect(readHiddenDashboardPanels()).toEqual(new Set());
		getItem.mockRestore();

		vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
			throw new Error("site data blocked");
		});
		expect(() =>
			writeHiddenDashboardPanels(new Set(["usage-minutes"])),
		).not.toThrow();
	});
});
