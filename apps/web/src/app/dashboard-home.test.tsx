import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PageContextSlot } from "@/components/page-context";
import { renderWithQuery } from "@/test/render";
import { DashboardHome } from "./dashboard-home";
import {
	DASHBOARD_HIDDEN_PANELS_KEY,
	DASHBOARD_PANEL_IDS,
} from "./dashboard-panels";

const apiFetch = vi.fn();
const usageProps = vi.fn();
const insightProps = vi.fn();
const backfillProps = vi.fn();
vi.mock("@/lib/api", () => ({
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));
vi.mock("./dashboard-usage", () => ({
	DashboardUsage: (props: unknown) => {
		usageProps(props);
		return <div data-testid="usage" />;
	},
}));
vi.mock("./dashboard-insights", () => ({
	DashboardInsights: (props: unknown) => {
		insightProps(props);
		return <div data-testid="trends" />;
	},
}));
vi.mock("./dashboard-backfill", () => ({
	DashboardBackfill: (props: unknown) => {
		backfillProps(props);
		return null;
	},
}));
const snapshot = { days: [], marker: "external-provider-usage" };
beforeEach(() => {
	vi.clearAllMocks();
	window.localStorage.clear();
	apiFetch.mockImplementation(async (url: string) =>
		url === "/api/bitmovin-accounts"
			? [{ id: "a1", label: "Only account" }]
			: snapshot,
	);
});
describe("Account-scoped dashboard", () => {
	it("places the account in the shell context while preserving account switching", async () => {
		apiFetch.mockImplementation(async (url: string) =>
			url === "/api/bitmovin-accounts"
				? [
						{ id: "a1", label: "One" },
						{ id: "a2", label: "Two" },
					]
				: snapshot,
		);
		const slot = document.createElement("div");
		document.body.append(slot);
		const view = renderWithQuery(
			<PageContextSlot.Provider value={slot}>
				<DashboardHome />
			</PageContextSlot.Provider>,
		);
		try {
			await screen.findByRole("option", { name: "Two" });
			const account = screen.getByRole("combobox", {
				name: "Bitmovin account",
			});
			expect(slot).toContainElement(account);
			expect(view.container).not.toContainElement(account);
			fireEvent.change(account, { target: { value: "a2" } });
			await waitFor(() =>
				expect(apiFetch).toHaveBeenCalledWith(
					expect.stringContaining("/api/dashboard/usage?accountId=a2&"),
					{ signal: expect.any(AbortSignal) },
				),
			);
		} finally {
			view.unmount();
			slot.remove();
		}
	});
	it("shows and auto-selects the sole account every visit, sharing one provider snapshot", async () => {
		const view = renderWithQuery(<DashboardHome />);
		await screen.findByText("Only account");
		const scopeHelp = screen.getByRole("button", {
			name: "Dashboard — more information",
		});
		const scope = document.getElementById(
			scopeHelp.getAttribute("aria-describedby") ?? "",
		);
		expect(scope).not.toBeVisible();
		fireEvent.mouseEnter(scopeHelp);
		const openScope = await screen.findByRole("tooltip");
		expect(openScope).toBeVisible();
		expect(openScope).toHaveAttribute(
			"id",
			scopeHelp.getAttribute("aria-describedby"),
		);
		expect(openScope).toHaveTextContent(
			"including jobs run outside this application",
		);
		fireEvent.mouseLeave(scopeHelp);
		expect(
			screen.queryByRole("combobox", { name: "Bitmovin account" }),
		).toBeNull();
		await waitFor(() =>
			expect(usageProps).toHaveBeenLastCalledWith(
				expect.objectContaining({ data: snapshot }),
			),
		);
		expect(insightProps).toHaveBeenLastCalledWith(
			expect.objectContaining({ data: snapshot }),
		);
		expect(
			apiFetch.mock.calls.filter(([url]) =>
				String(url).includes("/api/dashboard/usage?"),
			),
		).toHaveLength(1);
		expect(
			apiFetch.mock.calls.every(([url]) => !String(url).includes("/insights")),
		).toBe(true);
		view.unmount();
		renderWithQuery(<DashboardHome />);
		await screen.findByText("Only account");
		expect(
			screen.queryByRole("combobox", { name: "Bitmovin account" }),
		).toBeNull();
	});
	it("filters both views by the account and applied historical dates", async () => {
		apiFetch.mockImplementation(async (url: string) =>
			url === "/api/bitmovin-accounts"
				? [
						{ id: "a1", label: "One" },
						{ id: "a2", label: "Two" },
					]
				: snapshot,
		);
		renderWithQuery(<DashboardHome />);
		await screen.findByRole("option", { name: "Two" });
		fireEvent.change(
			screen.getByRole("combobox", { name: "Bitmovin account" }),
			{ target: { value: "a2" } },
		);
		fireEvent.change(screen.getByLabelText("From (UTC)"), {
			target: { value: "2020-01-01" },
		});
		fireEvent.change(screen.getByLabelText("To (UTC)"), {
			target: { value: "2020-12-31" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Show range" }));
		await waitFor(() =>
			expect(apiFetch).toHaveBeenCalledWith(
				"/api/dashboard/usage?accountId=a2&from=2020-01-01&to=2020-12-31",
				{ signal: expect.any(AbortSignal) },
			),
		);
		expect(
			screen.getByText("Selected period: 2020-01-01 — 2020-12-31 (UTC)"),
		).toBeInTheDocument();
	});
	it("applies only changed valid dates and prevents duplicate or invalid range requests", async () => {
		renderWithQuery(<DashboardHome />);
		await screen.findByTestId("usage");
		const apply = screen.getByRole("button", { name: "Show range" });
		expect(apply).toBeDisabled();
		fireEvent.change(screen.getByLabelText("From (UTC)"), {
			target: { value: "2020-01-01" },
		});
		fireEvent.change(screen.getByLabelText("To (UTC)"), {
			target: { value: "2019-12-31" },
		});
		expect(apply).toBeDisabled();
		fireEvent.change(screen.getByLabelText("To (UTC)"), {
			target: { value: "2020-12-31" },
		});
		expect(apply).toBeEnabled();
		fireEvent.click(apply);
		await waitFor(() =>
			expect(apiFetch).toHaveBeenCalledWith(
				"/api/dashboard/usage?accountId=a1&from=2020-01-01&to=2020-12-31",
				{ signal: expect.any(AbortSignal) },
			),
		);
		expect(apply).toBeDisabled();
		fireEvent.change(screen.getByLabelText("To (UTC)"), {
			target: { value: "" },
		});
		expect(apply).toBeDisabled();
	});
	it("does not fetch statistics when every panel is hidden", async () => {
		window.localStorage.setItem(
			DASHBOARD_HIDDEN_PANELS_KEY,
			JSON.stringify(DASHBOARD_PANEL_IDS),
		);
		renderWithQuery(<DashboardHome />);
		await screen.findByText("Only account");
		expect(apiFetch).toHaveBeenCalledTimes(1);
		expect(screen.queryByTestId("usage")).toBeNull();
	});
	it("uses accurate statistics labels in the panel picker", () => {
		renderWithQuery(<DashboardHome />);
		fireEvent.click(screen.getByRole("button", { name: /Panels/ }));
		expect(screen.getAllByRole("checkbox")).toHaveLength(4);
		expect(
			screen.getByRole("checkbox", { name: "Encoded data per day (GiB)" }),
		).toBeInTheDocument();
	});
	it("shows a load failure and no invented empty data", async () => {
		apiFetch.mockRejectedValue(new Error("Unavailable"));
		renderWithQuery(<DashboardHome />);
		expect(await screen.findByRole("alert")).toHaveTextContent("Unavailable");
		expect(screen.queryByText("No usage in this period")).toBeNull();
	});
});

it("retries account retrieval without reloading the page", async () => {
	apiFetch.mockRejectedValueOnce(new Error("offline"));
	renderWithQuery(<DashboardHome />);
	await screen.findByRole("alert");
	fireEvent.click(screen.getByRole("button", { name: "Retry" }));
	await screen.findByText("Only account");
});
it("does not present missing statistics as an empty chart and can retry", async () => {
	apiFetch.mockImplementation(async (url: string) => {
		if (url === "/api/bitmovin-accounts")
			return [{ id: "a1", label: "Only account" }];
		if (url.includes("/usage/labels?")) return { labels: [] };
		throw new Error("statistics unavailable");
	});
	renderWithQuery(<DashboardHome />);
	await screen.findByRole("alert");
	expect(screen.queryByTestId("usage")).toBeNull();
	expect(screen.queryByTestId("trends")).toBeNull();
	apiFetch.mockResolvedValue(snapshot);
	fireEvent.click(screen.getByRole("button", { name: "Retry" }));
	await screen.findByTestId("usage");
});
it("offers restoration when all panels were hidden", async () => {
	window.localStorage.setItem(
		DASHBOARD_HIDDEN_PANELS_KEY,
		JSON.stringify(DASHBOARD_PANEL_IDS),
	);
	renderWithQuery(<DashboardHome />);
	await screen.findByText("Only account");
	fireEvent.click(screen.getByRole("button", { name: "Show all panels" }));
	await screen.findByTestId("usage");
});

it("enables automatic latest refresh only when preferences and visible panels permit it", async () => {
	const view = renderWithQuery(<DashboardHome />);
	await screen.findByText("Only account");
	expect(backfillProps).toHaveBeenLastCalledWith(
		expect.objectContaining({ accountId: "a1", automatic: true }),
	);
	view.unmount();
	backfillProps.mockClear();
	window.localStorage.setItem(
		DASHBOARD_HIDDEN_PANELS_KEY,
		JSON.stringify(DASHBOARD_PANEL_IDS),
	);
	renderWithQuery(<DashboardHome />);
	await screen.findByText("Only account");
	expect(backfillProps).toHaveBeenLastCalledWith(
		expect.objectContaining({ automatic: false }),
	);
});
