import type { UsageSeries } from "@bitovp/core";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { cloneElement, isValidElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";
import { DashboardUsage as UsageView } from "./dashboard-usage";

const snapshot = vi.fn();
function DashboardUsage(props: React.ComponentProps<typeof UsageView>) {
	return <UsageView {...props} data={snapshot() as UsageSeries | undefined} />;
}

beforeEach(() => {
	vi.clearAllMocks();
});

// jsdom measures 0 for every container, so the size must reach the chart as
// props or every data-driven assertion tests nothing (see
// dashboard-insights.test.tsx, review-259 116-A7).
vi.mock("recharts", async () => {
	const actual = await vi.importActual<typeof import("recharts")>("recharts");
	return {
		...actual,
		ResponsiveContainer: ({ children }: { children: ReactNode }) =>
			isValidElement(children)
				? cloneElement(
						children as React.ReactElement<{
							width?: number;
							height?: number;
						}>,
						{ width: 800, height: 176 },
					)
				: children,
	};
});

const zero = {
	bytesEncoded: 0,
	timeEncodedS: 0,
	bytesEgress: 0,
	billableMinutes: 0,
	billableEncodingMinutes: 0,
	billableFeatureMinutes: 0,
	billableTransmuxingMinutes: 0,
};
const emptyBuckets = { SD: 0, HD: 0, UHD: 0, AUDIO: 0, UNKNOWN: 0 };

const series = {
	liveHd: {
		totalUnits: 56,
		missingDays: 0,
		days: [
			{ date: "2026-09-04", units: 0 },
			{ date: "2026-09-05", units: 56 },
			{ date: "2026-09-06", units: 0 },
		],
	},
	from: "2026-09-04",
	to: "2026-09-06",
	days: [
		{ date: "2026-09-04", VOD: { ...zero }, LIVE: { ...zero } },
		{
			date: "2026-09-05",
			VOD: {
				...zero,
				bytesEncoded: 10,
				timeEncodedS: 7200,
				bytesEgress: 2048,
				billableMinutes: 12.5,
				billableEncodingMinutes: 12.5,
			},
			LIVE: {
				...zero,
				bytesEncoded: 5,
				timeEncodedS: 3600,
				bytesEgress: 1024,
				billableMinutes: 60,
				billableEncodingMinutes: 60,
			},
		},
		{ date: "2026-09-06", VOD: { ...zero }, LIVE: { ...zero } },
	],
	totals: {
		VOD: {
			...zero,
			bytesEncoded: 10,
			timeEncodedS: 7200,
			bytesEgress: 2048,
			billableMinutes: 12.5,
			billableEncodingMinutes: 12.5,
		},
		LIVE: {
			...zero,
			bytesEncoded: 5,
			timeEncodedS: 3600,
			bytesEgress: 1024,
			billableMinutes: 60,
			billableEncodingMinutes: 60,
		},
	},
	breakdown: {
		buckets: {
			VOD: { ...emptyBuckets, HD: 12.5 },
			LIVE: { ...emptyBuckets, HD: 60 },
		},
		codecResolution: [
			{
				kind: "VOD",
				codec: "H264",
				resolution: "1920x1080",
				billableMinutes: 12.5,
				encodedSeconds: 7200,
			},
			{
				kind: "LIVE",
				codec: "H265",
				resolution: "1280x720",
				billableMinutes: 60,
				encodedSeconds: 3600,
			},
		],
		egress: [{ category: "ENCODING", region: "EU", bytes: 3072 }],
	},
	accounts: [
		{ id: "acc-1", label: "Primary" },
		{ id: "acc-2", label: "Secondary" },
	],
	refreshedAt: "2026-09-06T01:00:00.000Z",
	pendingDays: 1,
};

/**
 * : the usage panels read one series per (period, account);
 * totals, the stacked VOD/Live legend, the bucket and codec × resolution
 * tables render from it; the period buttons and the
 * account filter re-query; the freshness note names pending days; an error
 * names itself; and all-hidden after preferences load renders nothing and
 * issues no query.
 */
describe("DashboardUsage", () => {
	it("charts actual Live HD units by default without relabeling daily minutes as Custom Live", async () => {
		snapshot.mockReturnValue({
			...series,
			liveHd: {
				totalUnits: 56,
				missingDays: 0,
				days: series.days.map((day) => ({
					date: day.date,
					units: day.date === "2026-09-05" ? 56 : 0,
				})),
			},
		});
		const user = userEvent.setup();
		renderWithQuery(<DashboardUsage />);
		await screen.findByText(/Statistics as of/);
		const live = screen.getByRole("region", { name: "Live" });
		const vod = screen.getByRole("region", { name: "VOD" });
		const metric = within(live).getByRole("combobox", {
			name: "Live chart metric",
		});
		expect(within(vod).queryByRole("combobox")).toBeNull();
		expect(
			within(live).getByRole("heading", { name: "Live", level: 3 })
				.parentElement,
		).toContainElement(metric);
		expect(
			within(live).getByRole("heading", { name: "Live HD units per day" }),
		).toBeInTheDocument();
		expect(within(live).getByText("56")).toBeInTheDocument();
		expect(within(live).queryByText("Custom Live minutes")).toBeNull();
		await user.selectOptions(metric, "MINUTES");
		expect(
			within(live).getByRole("heading", {
				name: "Encoding minutes per day (billable)",
			}),
		).toBeInTheDocument();
		expect(
			within(vod).getByRole("heading", {
				name: "Encoding minutes per day (billable)",
			}),
		).toBeInTheDocument();
		await user.selectOptions(metric, "UNITS");
		expect(
			within(live).getByRole("heading", { name: "Live HD units per day" }),
		).toBeInTheDocument();
	});
	it("does not present an unverified raw timeEncoded value as output hours", async () => {
		snapshot.mockReturnValue({
			...series,
			totals: {
				...series.totals,
				VOD: { ...series.totals.VOD, timeEncodedS: 155778120 },
			},
		});
		renderWithQuery(<DashboardUsage />);
		await screen.findByText(/Statistics as of/);
		expect(screen.queryByText("43,271.7 h")).toBeNull();
		expect(
			screen.getByText("155,778,120").closest("details"),
		).not.toHaveAttribute("open");
		expect(
			screen.getAllByText(/unit and aggregation meaning are unverified/i),
		).toHaveLength(2);
	});
	it("keeps negative feature minutes out of the encoding KPI and chart", async () => {
		const data = structuredClone(series);
		data.totals.LIVE.billableFeatureMinutes = -1000;
		data.totals.LIVE.billableMinutes = -940;
		data.days = data.days.map((day) => ({
			...day,
			LIVE: {
				...day.LIVE,
				billableFeatureMinutes: -1000,
				billableMinutes: -940,
			},
		}));
		snapshot.mockReturnValue(data);
		renderWithQuery(<DashboardUsage />);
		await screen.findByText(/Statistics as of/);
		const live = screen.getByRole("region", { name: "Live" });
		expect(within(live).queryByText("-940")).toBeNull();
		expect(within(live).getAllByText("60").length).toBeGreaterThan(0);
		expect(
			within(live).getByText("-1,000").closest("details"),
		).not.toHaveAttribute("open");
		expect(
			within(live).getByText(/not added to encoding minutes/i),
		).toBeInTheDocument();
	});
	it("shows provider codec classes without inventing output time or hiding missing records", async () => {
		snapshot.mockReturnValue({
			...series,
			breakdown: {
				...series.breakdown,
				codecResolution: [
					{
						kind: "LIVE",
						codec: "H264",
						resolution: "HD",
						billableMinutes: 60,
						encodedSeconds: null,
						source: "ENCODING_CLASS",
					},
				],
				codecResolutionMissingRows: { VOD: 0, LIVE: 2 },
			},
		});
		renderWithQuery(<DashboardUsage />);
		await screen.findByText(/Statistics as of/);
		const live = screen.getByRole("region", { name: "Live" });
		expect(within(live).getByRole("table")).toHaveTextContent("HD");
		expect(within(live).getByText(/2 records lack/i)).toBeInTheDocument();
		expect(within(live).getByText(/resolution classes/i)).toBeInTheDocument();
	});
	it("lays out VOD then Live as shrinkable wide columns and narrow stacked sections", async () => {
		snapshot.mockReturnValue(series);
		renderWithQuery(<DashboardUsage />);
		await screen.findByText(/Statistics as of/);
		const vod = screen.getByRole("region", { name: "VOD" });
		const live = screen.getByRole("region", { name: "Live" });
		const grid = vod.parentElement;
		expect(grid).toHaveClass("grid", "grid-cols-1", "lg:grid-cols-2");
		expect(grid?.children).toHaveLength(2);
		expect(grid?.children[0]).toBe(vod);
		expect(grid?.children[1]).toBe(live);
		for (const section of [vod, live]) {
			expect(section).toHaveClass("min-w-0");
			expect(section.querySelectorAll(".recharts-wrapper")).toHaveLength(1);
			const table = within(section).getByRole("table");
			expect(table.parentElement).toHaveClass("min-w-0", "overflow-x-auto");
			for (const title of within(section).getAllByRole("heading", {
				level: 4,
			})) {
				expect(title.parentElement).toHaveClass("min-w-0");
			}
		}
	});

	it("separates VOD and Live totals, charts and codec tables without combining billing units", async () => {
		snapshot.mockReturnValue(series);
		renderWithQuery(<DashboardUsage />);

		await screen.findByText(/Statistics as of/);
		const vod = screen.getByRole("region", { name: "VOD" });
		const live = screen.getByRole("region", { name: "Live" });
		expect(within(vod).queryByText("Live")).toBeNull();
		expect(within(live).queryByText("VOD")).toBeNull();
		expect(within(vod).getAllByText("12.5").length).toBeGreaterThan(0);
		expect(within(live).getAllByText("60").length).toBeGreaterThan(0);
		expect(screen.queryByText("72.5")).toBeNull();
		expect(screen.queryByText("3.0 KB")).toBeNull();
		expect(screen.queryByText(/Egress/)).toBeNull();
		expect(within(vod).getByRole("table")).toHaveTextContent("H264");
		expect(within(vod).getByRole("table")).not.toHaveTextContent("H265");
		expect(within(live).getByRole("table")).toHaveTextContent("H265");
		expect(within(live).getByRole("table")).not.toHaveTextContent("H264");
		expect(vod.querySelectorAll(".recharts-wrapper")).toHaveLength(1);
		expect(live.querySelectorAll(".recharts-wrapper")).toHaveLength(1);
		expect(screen.queryByText("Bucket")).toBeNull();
		expect(screen.queryByText("HD")).toBeNull();
		expect(
			within(live).getByText("Live Units", { selector: "dt" }).closest("div"),
		).toHaveTextContent("56");
		await userEvent.click(
			within(live).getByRole("button", {
				name: "Live Units — more information",
			}),
		);
		const liveNote = screen.getByRole("note");
		expect(liveNote).toHaveTextContent(/Custom Live/);
		const liveChart = live.querySelector(".recharts-wrapper");
		expect(liveChart).not.toBeNull();
		expect(liveChart?.compareDocumentPosition(liveNote)).toBe(
			Node.DOCUMENT_POSITION_FOLLOWING,
		);
		expect(screen.queryByText("ENCODING")).toBeNull();
		expect(
			screen.getByText(/1 day\(s\) in this range are newer than the last read/),
		).toBeInTheDocument();
		expect(screen.getByText(/Statistics as of/)).toBeInTheDocument();
	});

	it("shows the never-refreshed note and the empty states on a blank series", async () => {
		snapshot.mockReturnValue({
			...series,
			liveHd: {
				totalUnits: 0,
				missingDays: 0,
				days: series.liveHd.days.map((day) => ({ ...day, units: 0 })),
			},
			days: series.days.map((d) => ({
				date: d.date,
				VOD: { ...zero },
				LIVE: { ...zero },
			})),
			totals: { VOD: { ...zero }, LIVE: { ...zero } },
			breakdown: {
				buckets: { VOD: { ...emptyBuckets }, LIVE: { ...emptyBuckets } },
				codecResolution: [],
				egress: [],
			},
			accounts: [],
			refreshedAt: null,
			pendingDays: 0,
		});
		renderWithQuery(<DashboardUsage />);

		expect(
			await screen.findByText(
				/Statistics have not been read yet for every account/,
			),
		).toBeInTheDocument();
		expect(screen.getAllByText("No usage in this period")).toHaveLength(2);
		expect(
			screen.getAllByText(
				"No codec × resolution breakdown was returned for this period",
			),
		).toHaveLength(2);
		expect(screen.queryByRole("combobox", { name: "All accounts" })).toBeNull();
	});

	it("keeps totals unknown while the shared request is pending", () => {
		snapshot.mockReturnValue(undefined);
		renderWithQuery(<DashboardUsage />);
		expect(screen.getAllByText("Unknown")).toHaveLength(3);
		expect(screen.queryByText("0")).toBeNull();
	});

	it("preserves negative reported minutes and flags the anomaly instead of clamping", async () => {
		snapshot.mockReturnValue({
			...series,
			totals: {
				VOD: {
					...series.totals.VOD,
					billableEncodingMinutes: 57857.648333333345,
				},
				LIVE: { ...series.totals.LIVE, billableEncodingMinutes: -241132.75 },
			},
		});
		renderWithQuery(<DashboardUsage />);
		expect(await screen.findByText("-241,132.8")).toBeInTheDocument();
		expect(screen.getByText("57,857.6")).toBeInTheDocument();
		expect(screen.getByRole("alert")).toHaveTextContent(/negative/i);
	});

	it.each([
		"day",
		"bucket",
		"codec",
	])("warns about negative %s minutes even when the overall total is positive", async (part) => {
		const data = structuredClone(series);
		if (part === "day") {
			data.days = data.days.map((day) => ({
				...day,
				LIVE: { ...day.LIVE, billableEncodingMinutes: -5 },
			}));
		}
		if (part === "bucket") data.breakdown.buckets.LIVE.HD = -5;
		if (part === "codec") {
			data.breakdown.codecResolution = data.breakdown.codecResolution.map(
				(row) => ({ ...row, billableMinutes: -5 }),
			);
		}
		snapshot.mockReturnValue(data);
		renderWithQuery(<DashboardUsage />);
		expect(await screen.findByText(/Statistics as of/)).toBeInTheDocument();
		expect(screen.getByRole("alert")).toHaveTextContent(/negative/i);
	});

	it("renders nothing and issues no query once preferences hide every usage panel", () => {
		snapshot.mockReturnValue(series);
		const { container } = renderWithQuery(
			<DashboardUsage
				hiddenPanels={new Set(["usage-minutes", "usage-breakdown"] as const)}
			/>,
		);

		expect(container).toBeEmptyDOMElement();
	});

	it("keeps a hidden panel out while the others render", async () => {
		snapshot.mockReturnValue(series);
		renderWithQuery(
			<DashboardUsage hiddenPanels={new Set(["usage-minutes"] as const)} />,
		);

		await screen.findByText(/Statistics as of/);
		expect(document.querySelectorAll(".recharts-wrapper")).toHaveLength(0);
		expect(screen.getAllByRole("table")).toHaveLength(2);
	});

	it("keeps the Live empty state independent of VOD usage", async () => {
		snapshot.mockReturnValue({
			...series,
			liveHd: {
				totalUnits: 0,
				missingDays: 0,
				days: series.liveHd.days.map((day) => ({ ...day, units: 0 })),
			},
			days: series.days.map((d) => ({ ...d, LIVE: { ...zero } })),
			totals: { ...series.totals, LIVE: { ...zero } },
			breakdown: {
				...series.breakdown,
				codecResolution: series.breakdown.codecResolution.filter(
					(r) => r.kind === "VOD",
				),
			},
		});
		renderWithQuery(<DashboardUsage />);
		await screen.findByText(/Statistics as of/);
		const live = screen.getByRole("region", { name: "Live" });
		expect(
			within(live).getByText("No usage in this period"),
		).toBeInTheDocument();
		expect(
			within(live).getByText(
				"No codec × resolution breakdown was returned for this period",
			),
		).toBeInTheDocument();
		expect(within(live).queryByRole("table")).toBeNull();
		expect(
			within(screen.getByRole("region", { name: "VOD" })).getByRole("table"),
		).toHaveTextContent("H264");
	});

	it("one breakdown preference hides both kind tables but keeps both charts", async () => {
		snapshot.mockReturnValue(series);
		renderWithQuery(
			<DashboardUsage hiddenPanels={new Set(["usage-breakdown"] as const)} />,
		);
		await screen.findByText(/Statistics as of/);
		expect(screen.queryByRole("table")).toBeNull();
		expect(document.querySelectorAll(".recharts-wrapper")).toHaveLength(2);
	});

	it("labels API-reported values and unavailable Live Units in Japanese", async () => {
		snapshot.mockReturnValue({ ...series, liveHd: undefined });
		renderWithQuery(<DashboardUsage />, "ja");
		await screen.findByText(/統計の取得時刻/);
		const live = screen.getByRole("region", { name: "ライブ" });
		expect(
			within(live).getAllByText("課金換算分（API報告）").length,
		).toBeGreaterThan(0);
		expect(
			within(live).getByText("Live Units").closest("div"),
		).toHaveTextContent("未取得");
		expect(screen.queryByText("バケット")).toBeNull();
		await userEvent.click(
			within(live).getByRole("button", { name: "「Live Units」の説明" }),
		);
		expect(screen.getByRole("note")).toHaveTextContent(
			/分数から Units へ換算しません/,
		);
		expect(
			within(live)
				.getAllByText("未取得")
				.some((node) => node.parentElement?.classList.contains("h-44")),
		).toBe(true);
	});

	it("keeps matching codec and resolution rows attributed to their own kind", async () => {
		snapshot.mockReturnValue({
			...series,
			breakdown: {
				...series.breakdown,
				codecResolution: [
					series.breakdown.codecResolution[0],
					{
						...series.breakdown.codecResolution[0],
						kind: "LIVE",
						billableMinutes: 60,
						encodedSeconds: 3600,
					},
				],
			},
		});
		renderWithQuery(<DashboardUsage />);
		await screen.findByText(/Statistics as of/);
		const vod = within(screen.getByRole("region", { name: "VOD" })).getByRole(
			"table",
		);
		const live = within(screen.getByRole("region", { name: "Live" })).getByRole(
			"table",
		);
		for (const table of [vod, live])
			expect(table).toHaveTextContent("H2641920x1080");
		expect(within(vod).getByText("12.5")).toBeInTheDocument();
		expect(within(vod).queryByText("60")).toBeNull();
		expect(within(live).getByText("60")).toBeInTheDocument();
		expect(within(live).queryByText("12.5")).toBeNull();
	});

	it.each([
		"en",
		"ja",
	] as const)("does not claim zero usage when nonzero %s totals lack a codec breakdown", async (locale) => {
		snapshot.mockReturnValue({
			...series,
			breakdown: { ...series.breakdown, codecResolution: [] },
		});
		renderWithQuery(<DashboardUsage />, locale);
		await screen.findByText(
			locale === "en" ? /Statistics as of/ : /統計の取得時刻/,
		);
		const message =
			locale === "en"
				? "No codec × resolution breakdown was returned for this period"
				: "この期間のコーデック×解像度の内訳は返されていません";
		expect(screen.getAllByText(message)).toHaveLength(2);
		expect(
			screen.queryByText(
				locale === "en"
					? "No usage in this period"
					: "この期間の使用量はありません",
			),
		).toBeNull();
		expect(screen.getByText("12.5")).toBeInTheDocument();
		expect(screen.getByText("60", { selector: "dd" })).toBeInTheDocument();
		expect(document.querySelectorAll(".recharts-wrapper")).toHaveLength(2);
		expect(screen.queryByRole("table")).toBeNull();
	});
});
