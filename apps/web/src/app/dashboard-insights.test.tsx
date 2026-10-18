import { buildLabelUsageSeries, type UsageSeries } from "@bitovp/core";
import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";
import { DashboardInsights } from "./dashboard-insights";

const chart = vi.fn();
vi.mock("recharts", () => ({
	ResponsiveContainer: ({ children }: { children: React.ReactNode }) =>
		children,
	BarChart: ({ data }: { data: unknown }) => {
		chart(data);
		return <div data-testid="chart" />;
	},
	Bar: () => null,
	CartesianGrid: () => null,
	Legend: () => null,
	Tooltip: () => null,
	XAxis: () => null,
	YAxis: () => null,
}));
const totals = {
	bytesEncoded: 2 ** 30,
	bytesEgress: 2 ** 31,
	billableEncodingMinutes: 3,
	billableFeatureMinutes: 0,
	billableTransmuxingMinutes: 0,
	billableMinutes: 3,
	timeEncodedS: 999,
};
const data: UsageSeries = {
	from: "2020-01-01",
	to: "2020-01-02",
	days: [
		{ date: "2020-01-01", VOD: totals, LIVE: totals },
		{ date: "2020-01-02", VOD: totals, LIVE: totals },
	],
	totals: { VOD: totals, LIVE: totals },
	accounts: [{ id: "outside-app", label: "Account" }],
	breakdown: {
		buckets: {
			VOD: { SD: 0, HD: 0, UHD: 0, AUDIO: 0, UNKNOWN: 0 },
			LIVE: { SD: 0, HD: 0, UHD: 0, AUDIO: 0, UNKNOWN: 0 },
		},
		codecResolution: [],
		egress: [],
	},
	refreshedAt: null,
	pendingDays: 0,
	coverage: {
		days: [
			{ date: "2020-01-01", VOD: true, LIVE: true },
			{ date: "2020-01-02", VOD: false, LIVE: true },
		],
		missingDays: 1,
	},
};
beforeEach(() => vi.clearAllMocks());
describe("Statistics-based trends", () => {
	it("plots a selected label once as combined usage with unavailable days left blank", () => {
		const label = buildLabelUsageSeries({
			account: { id: "account", label: "Main" },
			label: "customer-a",
			from: "2020-01-01",
			to: "2020-01-02",
			readAt: new Date(),
			rows: [
				{
					date: "2020-01-01",
					labels: [
						{
							label: "customer-a",
							bytesEncoded: 2 ** 30,
							billableEgressBytes: [{ bytes: 2 ** 31 }],
						},
					],
				},
			],
		});
		renderWithQuery(<DashboardInsights data={label} />);
		expect(chart).toHaveBeenCalledWith([
			{ day: "2020-01-01", COMBINED: 1 },
			{ day: "2020-01-02", COMBINED: null },
		]);
		expect(chart).toHaveBeenCalledWith([
			{ day: "2020-01-01", COMBINED: 2 },
			{ day: "2020-01-02", COMBINED: null },
		]);
		expect(
			screen.getByText("Billable transfer per day (GiB)"),
		).toBeInTheDocument();
	});
	it("plots provider-wide bytes in GiB and leaves missing snapshots as gaps", () => {
		renderWithQuery(<DashboardInsights data={data} />);
		expect(screen.getByText("Encoded data per day (GiB)")).toBeInTheDocument();
		expect(screen.getByText("Egress per day (GiB)")).toBeInTheDocument();
		expect(chart).toHaveBeenCalledWith([
			{ day: "2020-01-01", VOD: 1, LIVE: 1 },
			{ day: "2020-01-02", VOD: null, LIVE: 1 },
		]);
		expect(chart).toHaveBeenCalledWith([
			{ day: "2020-01-01", VOD: 2, LIVE: 2 },
			{ day: "2020-01-02", VOD: null, LIVE: 2 },
		]);
		expect(screen.queryByText(/Jobs per day|airtime/)).toBeNull();
	});
	it("retains per-browser hidden-panel choices", () => {
		renderWithQuery(
			<DashboardInsights data={data} hiddenPanels={new Set(["jobs-by-day"])} />,
		);
		expect(screen.queryByText("Encoded data per day (GiB)")).toBeNull();
		expect(screen.getAllByTestId("chart")).toHaveLength(1);
	});
	it("does not call missing statistics zero usage", () => {
		const blank = structuredClone(data);
		blank.days = blank.days.map((day) => ({
			...day,
			VOD: { ...totals, bytesEncoded: 0, bytesEgress: 0 },
			LIVE: { ...totals, bytesEncoded: 0, bytesEgress: 0 },
		}));
		renderWithQuery(<DashboardInsights data={blank} />);
		expect(screen.getAllByText("Not retrieved")).toHaveLength(2);
		expect(screen.queryByText("No usage in this period")).toBeNull();
	});
});
