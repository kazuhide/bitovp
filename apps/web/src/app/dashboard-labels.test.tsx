import { buildLabelUsageSeries } from "@bitovp/core";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import { renderWithQuery } from "@/test/render";
import { DashboardHome } from "./dashboard-home";

const apiFetch = vi.fn();
const insights = vi.fn();
vi.mock("@/lib/api", async (original) => ({
	...(await original<object>()),
	apiFetch: (url: string, init?: RequestInit) => apiFetch(url, init),
}));
vi.mock("./dashboard-usage", () => ({
	DashboardUsage: () => <div>Account totals</div>,
}));
vi.mock("./dashboard-insights", () => ({
	DashboardInsights: (props: unknown) => {
		insights(props);
		return null;
	},
}));
vi.mock("./dashboard-backfill", () => ({
	DashboardBackfill: () => <div>Account import</div>,
}));
const page = (labels: string[], offset = 0, totalCount = labels.length) => ({
	labels,
	offset,
	totalCount,
	nextOffset:
		offset + labels.length < totalCount ? offset + labels.length : null,
	readAt: "2026-10-04T00:00:00Z",
	source: "PROVIDER" as const,
});
const data = buildLabelUsageSeries({
	account: { id: "a1", label: "Main" },
	label: "customer-a",
	from: "2026-10-01",
	to: "2026-10-01",
	readAt: new Date("2026-10-02T00:00:00Z"),
	rows: [
		{
			date: "2026-10-01",
			labels: [
				{
					label: "customer-a",
					bytesEncoded: 0,
					billableEncodingMinutes: [],
					billableEgressBytes: [],
				},
			],
		},
	],
});
beforeEach(() => {
	vi.clearAllMocks();
	window.localStorage.clear();
	apiFetch.mockImplementation(async (url: string) => {
		if (url === "/api/bitmovin-accounts")
			return [
				{ id: "a1", label: "Main" },
				{ id: "a2", label: "Second" },
			];
		if (url.includes("/usage/labels?"))
			return page(["customer-a", "customer-b", "a,b"]);
		if (new URL(url, "http://test").searchParams.has("label")) return data;
		return { days: [] };
	});
});

describe("dashboard label selection", () => {
	it("uses the sanitized restart hint and preserves old choices and selection if fresh metadata fails", async () => {
		let failRefresh = true;
		apiFetch.mockImplementation(async (url: string) => {
			if (url === "/api/bitmovin-accounts")
				return [{ id: "a1", label: "Main" }];
			const params = new URL(url, "http://test").searchParams;
			if (url.includes("/usage/labels?")) {
				if (params.get("refresh") === "1") {
					if (failRefresh)
						throw new ApiError(502, "fresh metadata unavailable");
					return page(["customer-a", "new-label"]);
				}
				if (params.get("offset") === "1")
					throw new ApiError(502, "Statistics labels unavailable", {
						restart: true,
					});
				return page(["customer-a"], 0, 2);
			}
			return params.has("label") ? data : { days: [] };
		});
		renderWithQuery(<DashboardHome />);
		await screen.findByText("Account totals");
		fireEvent.click(screen.getByRole("button", { name: "Panels" }));
		await screen.findByRole("alert");
		fireEvent.change(screen.getByRole("combobox", { name: "Encoding label" }), {
			target: { value: "customer-a" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Retry labels" }));
		await waitFor(() =>
			expect(screen.getByRole("alert")).toHaveTextContent(
				"fresh metadata unavailable",
			),
		);
		expect(
			screen.getByRole("option", { name: "customer-a" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("combobox", { name: "Encoding label" }),
		).toHaveValue("customer-a");
		failRefresh = false;
		fireEvent.click(screen.getByRole("button", { name: "Retry labels" }));
		await screen.findByRole("option", { name: "new-label" });
		expect(screen.queryByRole("alert")).toBeNull();
		expect(
			apiFetch.mock.calls.filter(
				([url]) =>
					url.includes("/usage/labels?") &&
					new URL(url, "http://test").searchParams.get("offset") === "1",
			),
		).toHaveLength(1);
	});
	it("restarts a drifted count at fresh offset zero while preserving the selected label and search", async () => {
		let restarted = false;
		apiFetch.mockImplementation(async (url: string) => {
			if (url === "/api/bitmovin-accounts")
				return [{ id: "a1", label: "Main" }];
			const params = new URL(url, "http://test").searchParams;
			if (url.includes("/usage/labels?")) {
				if (params.get("refresh") === "1") restarted = true;
				return params.get("offset") === "1"
					? page(["new-label", "last-label"], 1, 3)
					: page(["customer-a"], 0, restarted ? 3 : 2);
			}
			return params.has("label") ? data : { days: [] };
		});
		renderWithQuery(<DashboardHome />);
		await screen.findByText("Account totals");
		fireEvent.click(screen.getByRole("button", { name: "Panels" }));
		await screen.findByRole("alert");
		fireEvent.change(screen.getByRole("combobox", { name: "Encoding label" }), {
			target: { value: "customer-a" },
		});
		fireEvent.change(screen.getByRole("searchbox", { name: "Find a label" }), {
			target: { value: "label" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Retry labels" }));
		await screen.findByText("3 / 3 labels loaded");
		expect(
			screen.getByRole("combobox", { name: "Encoding label" }),
		).toHaveValue("customer-a");
		expect(screen.getByRole("searchbox", { name: "Find a label" })).toHaveValue(
			"label",
		);
		const fresh = apiFetch.mock.calls.filter(
			([url]) =>
				new URL(url, "http://test").searchParams.get("refresh") === "1",
		);
		expect(fresh).toHaveLength(1);
		expect(
			new URL(fresh[0]?.[0], "http://test").searchParams.has("totalCount"),
		).toBe(false);
	});
	it("resets the exhausted twenty-short-page cursor instead of retrying the same local limit", async () => {
		let restarted = false;
		apiFetch.mockImplementation(async (url: string) => {
			if (url === "/api/bitmovin-accounts")
				return [{ id: "a1", label: "Main" }];
			if (url.includes("/usage/labels?")) {
				const params = new URL(url, "http://test").searchParams;
				if (params.get("refresh") === "1") restarted = true;
				const offset = Number(params.get("offset"));
				return restarted
					? page(["finished"])
					: page([`label-${offset}`], offset, 30);
			}
			return { days: [] };
		});
		renderWithQuery(<DashboardHome />);
		await screen.findByText("Account totals");
		fireEvent.click(screen.getByRole("button", { name: "Panels" }));
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"page limit reached",
		);
		expect(
			apiFetch.mock.calls.filter(([url]) => url.includes("/usage/labels?")),
		).toHaveLength(20);
		fireEvent.click(screen.getByRole("button", { name: "Retry labels" }));
		await screen.findByRole("option", { name: "finished" });
		expect(screen.queryByRole("alert")).toBeNull();
		expect(
			apiFetch.mock.calls.filter(([url]) => url.includes("/usage/labels?")),
		).toHaveLength(21);
	});
	it("keeps the first page selectable while later pages load, with explicit partial search and exact lookup", async () => {
		let finish!: (value: ReturnType<typeof page>) => void;
		const pending = new Promise<ReturnType<typeof page>>((resolve) => {
			finish = resolve;
		});
		const first = [
			"customer-a",
			...Array.from({ length: 99 }, (_, i) => `label-${i}`),
		];
		apiFetch.mockImplementation(async (url: string) => {
			if (url === "/api/bitmovin-accounts")
				return [{ id: "a1", label: "Main" }];
			const params = new URL(url, "http://test").searchParams;
			if (url.includes("/usage/labels?")) {
				if (params.get("label") === "last-label") return page(["last-label"]);
				return params.get("offset") === "100" ? pending : page(first, 0, 101);
			}
			return params.has("label") ? data : { days: [] };
		});
		renderWithQuery(<DashboardHome />);
		await screen.findByText("Account totals");
		fireEvent.click(screen.getByRole("button", { name: "Panels" }));
		await screen.findByRole("option", { name: "customer-a" });
		expect(screen.getByText("100 / 101 labels loaded")).toBeInTheDocument();
		const select = screen.getByRole("combobox", { name: "Encoding label" });
		expect(select).not.toBeDisabled();
		fireEvent.change(select, { target: { value: "customer-a" } });
		await screen.findByRole("heading", { name: "VOD + Live" });
		const search = screen.getByRole("searchbox", { name: "Find a label" });
		fireEvent.change(search, { target: { value: "last-label" } });
		expect(screen.queryByText("No labels match your search.")).toBeNull();
		expect(
			screen.getByText(
				"Search filters loaded labels. More labels are loading.",
			),
		).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Find exact label" }));
		await screen.findByRole("option", { name: "last-label" });
		expect(search).toHaveValue("last-label");
		await act(async () => {
			finish(page(["last-label"], 100, 101));
			await pending;
		});
		await screen.findByText("101 / 101 labels loaded");
	});
	it("retains usable pages on a later-page failure and retries only the failed offset", async () => {
		let fail = true;
		apiFetch.mockImplementation(async (url: string) => {
			if (url === "/api/bitmovin-accounts")
				return [{ id: "a1", label: "Main" }];
			if (url.includes("/usage/labels?")) {
				if (new URL(url, "http://test").searchParams.get("offset") === "1") {
					if (fail) throw new Error("later page unavailable");
					return page(["last-label"], 1, 2);
				}
				return page(["customer-a"], 0, 2);
			}
			return { days: [] };
		});
		renderWithQuery(<DashboardHome />);
		await screen.findByText("Account totals");
		fireEvent.click(screen.getByRole("button", { name: "Panels" }));
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"later page unavailable",
		);
		expect(
			screen.getByRole("option", { name: "customer-a" }),
		).toBeInTheDocument();
		fail = false;
		fireEvent.click(screen.getByRole("button", { name: "Retry labels" }));
		await screen.findByRole("option", { name: "last-label" });
		expect(
			apiFetch.mock.calls.filter(
				([url]) =>
					url.includes("/usage/labels?") &&
					new URL(url, "http://test").searchParams.get("offset") === "0",
			),
		).toHaveLength(1);
	});
	it("aborts pending catalog pagination when Display panels closes", async () => {
		let signal: AbortSignal | undefined;
		apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
			if (url === "/api/bitmovin-accounts")
				return [{ id: "a1", label: "Main" }];
			if (url.includes("/usage/labels?")) {
				if (new URL(url, "http://test").searchParams.get("offset") === "1") {
					signal = init?.signal ?? undefined;
					return new Promise(() => {});
				}
				return page(["customer-a"], 0, 2);
			}
			return { days: [] };
		});
		renderWithQuery(<DashboardHome />);
		await screen.findByText("Account totals");
		const panels = screen.getByRole("button", { name: "Panels" });
		fireEvent.click(panels);
		await waitFor(() => expect(signal).toBeInstanceOf(AbortSignal));
		fireEvent.click(panels);
		expect(signal?.aborted).toBe(true);
	});
	it("does not fetch labels until Display panels opens, and renders filtering inside that panel", async () => {
		renderWithQuery(<DashboardHome />);
		await screen.findByText("Account totals");
		expect(
			apiFetch.mock.calls.some(([url]) => url.includes("/usage/labels?")),
		).toBe(false);
		expect(
			screen.queryByRole("combobox", { name: "Encoding label" }),
		).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Panels" }));
		await screen.findByRole("option", { name: "customer-a" });
		expect(
			apiFetch.mock.calls.filter(([url]) => url.includes("/usage/labels?")),
		).toHaveLength(1);
		expect(
			screen
				.getByRole("combobox", { name: "Encoding label" })
				.closest("#dashboard-panel-picker"),
		).not.toBeNull();
	});
	it("uses one label and the same combined series for usage and insights", async () => {
		renderWithQuery(<DashboardHome />);
		await screen.findByText("Account totals");
		fireEvent.click(screen.getByRole("button", { name: "Panels" }));
		await screen.findByRole("option", { name: "customer-a" });
		const labels = screen.getByRole("combobox", { name: "Encoding label" });
		fireEvent.change(labels, { target: { value: "customer-a" } });
		await screen.findByRole("heading", { name: "VOD + Live" });
		expect(screen.queryByText("Account totals")).toBeNull();
		expect(screen.queryByText("Account import")).toBeNull();
		await waitFor(() =>
			expect(insights).toHaveBeenLastCalledWith(
				expect.objectContaining({ data }),
			),
		);
		expect(
			apiFetch.mock.calls.some(
				([url]) =>
					new URL(url, "http://test").searchParams.get("label") ===
					"customer-a",
			),
		).toBe(true);
		expect(screen.getByRole("option", { name: "a,b" })).toBeDisabled();
	});
	it("clears a previous account's label before fetching another account", async () => {
		renderWithQuery(<DashboardHome />);
		await screen.findByText("Account totals");
		fireEvent.click(screen.getByRole("button", { name: "Panels" }));
		await screen.findByRole("option", { name: "customer-a" });
		fireEvent.change(screen.getByRole("combobox", { name: "Encoding label" }), {
			target: { value: "customer-a" },
		});
		await screen.findByRole("heading", { name: "VOD + Live" });
		fireEvent.change(
			screen.getByRole("combobox", { name: "Bitmovin account" }),
			{ target: { value: "a2" } },
		);
		await screen.findByText("Account totals");
		expect(
			screen.queryByRole("combobox", { name: "Encoding label" }),
		).toBeNull();
		expect(screen.getByRole("button", { name: "Panels" })).toHaveAttribute(
			"aria-expanded",
			"false",
		);
		expect(
			apiFetch.mock.calls
				.filter(
					([url]) =>
						new URL(url, "http://test").searchParams.get("accountId") === "a2",
				)
				.every(
					([url]) => !new URL(url, "http://test").searchParams.has("label"),
				),
		).toBe(true);
	});
	it("shows label retrieval failure with a retry while preserving account totals", async () => {
		apiFetch.mockImplementation(async (url: string) => {
			if (url === "/api/bitmovin-accounts")
				return [{ id: "a1", label: "Main" }];
			if (url.includes("/usage/labels?")) throw new Error("labels unavailable");
			return { days: [] };
		});
		renderWithQuery(<DashboardHome />);
		await screen.findByText("Account totals");
		fireEvent.click(screen.getByRole("button", { name: "Panels" }));
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"labels unavailable",
		);
		apiFetch.mockImplementation(async (url: string) =>
			url.includes("/usage/labels?") ? page(["customer-a"]) : { days: [] },
		);
		fireEvent.click(screen.getByRole("button", { name: "Retry labels" }));
		await screen.findByRole("option", { name: "customer-a" });
	});
	it("retains an active filter while Display panels is collapsed and can clear it without reopening", async () => {
		renderWithQuery(<DashboardHome />);
		await screen.findByText("Account totals");
		const disclosure = screen.getByRole("button", { name: "Panels" });
		fireEvent.click(disclosure);
		await screen.findByRole("option", { name: "customer-a" });
		fireEvent.change(screen.getByRole("combobox", { name: "Encoding label" }), {
			target: { value: "customer-a" },
		});
		await screen.findByRole("heading", { name: "VOD + Live" });
		fireEvent.click(disclosure);
		expect(disclosure).toHaveAttribute("aria-expanded", "false");
		expect(
			screen.queryByRole("combobox", { name: "Encoding label" }),
		).toBeNull();
		expect(
			screen.getByRole("heading", { name: "VOD + Live" }),
		).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Clear label filter" }));
		await screen.findByText("Account totals");
		expect(screen.queryByRole("heading", { name: "VOD + Live" })).toBeNull();
		expect(screen.getByText("Account import")).toBeInTheDocument();
	});
	it("searches labels locally without refetching and preserves the active selection", async () => {
		renderWithQuery(<DashboardHome />);
		await screen.findByText("Account totals");
		fireEvent.click(screen.getByRole("button", { name: "Panels" }));
		await screen.findByRole("option", { name: "customer-a" });
		fireEvent.change(screen.getByRole("combobox", { name: "Encoding label" }), {
			target: { value: "customer-a" },
		});
		fireEvent.change(screen.getByRole("searchbox", { name: "Find a label" }), {
			target: { value: "CUSTOMER-B" },
		});
		expect(
			screen.getByRole("option", { name: "customer-b" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("combobox", { name: "Encoding label" }),
		).toHaveValue("customer-a");
		expect(screen.queryByRole("option", { name: "a,b" })).toBeNull();
		fireEvent.change(screen.getByRole("searchbox", { name: "Find a label" }), {
			target: { value: "missing" },
		});
		expect(
			screen.getByText("No labels match your search."),
		).toBeInTheDocument();
		expect(
			apiFetch.mock.calls.filter(([url]) => url.includes("/usage/labels?")),
		).toHaveLength(1);
	});
	it("ignores a late label catalog from the previous account", async () => {
		let finishOld!: (value: ReturnType<typeof page>) => void;
		const old = new Promise<ReturnType<typeof page>>((resolve) => {
			finishOld = resolve;
		});
		apiFetch.mockImplementation(async (url: string) => {
			if (url === "/api/bitmovin-accounts")
				return [
					{ id: "a1", label: "Main" },
					{ id: "a2", label: "Second" },
				];
			if (url.includes("/usage/labels?"))
				return url.includes("accountId=a1") ? old : page(["second-only"]);
			return { days: [] };
		});
		renderWithQuery(<DashboardHome />);
		await screen.findByText("Account totals");
		fireEvent.click(screen.getByRole("button", { name: "Panels" }));
		await waitFor(() =>
			expect(
				apiFetch.mock.calls.some(([url]) =>
					url.includes("/usage/labels?accountId=a1"),
				),
			).toBe(true),
		);
		fireEvent.change(
			screen.getByRole("combobox", { name: "Bitmovin account" }),
			{ target: { value: "a2" } },
		);
		expect(
			screen.queryByRole("combobox", { name: "Encoding label" }),
		).toBeNull();
		expect(
			apiFetch.mock.calls.some(([url]) =>
				url.includes("/usage/labels?accountId=a2"),
			),
		).toBe(false);
		fireEvent.click(screen.getByRole("button", { name: "Panels" }));
		await screen.findByRole("option", { name: "second-only" });
		await act(async () => {
			finishOld(page(["old-account-only"]));
			await old;
		});
		expect(
			screen.queryByRole("option", { name: "old-account-only" }),
		).toBeNull();
		expect(
			screen.getByRole("option", { name: "second-only" }),
		).toBeInTheDocument();
	});
	it("explains an empty catalog without changing account totals", async () => {
		apiFetch.mockImplementation(async (url: string) => {
			if (url === "/api/bitmovin-accounts")
				return [{ id: "a1", label: "Main" }];
			if (url.includes("/usage/labels?")) return page([]);
			return { days: [] };
		});
		renderWithQuery(<DashboardHome />);
		await screen.findByText("Account totals");
		fireEvent.click(screen.getByRole("button", { name: "Panels" }));
		await screen.findByText("No labels available to select.");
		expect(
			screen.getByRole("combobox", { name: "Encoding label" }),
		).toBeDisabled();
		expect(screen.getByText("Account totals")).toBeInTheDocument();
	});
});
