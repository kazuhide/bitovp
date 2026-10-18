"use client";

import { type DashboardUsageSeries, isLabelUsageSeries } from "@bitovp/core";
import {
	Bar,
	BarChart,
	CartesianGrid,
	Legend,
	ResponsiveContainer,
	Tooltip,
	XAxis,
	YAxis,
} from "recharts";
import { useT } from "@/lib/i18n/context";
import {
	type DashboardPanelId,
	dashboardPanelIsVisible,
} from "./dashboard-panels";

const NO_HIDDEN_PANELS: ReadonlySet<DashboardPanelId> = new Set();

/** Both trends use the same account, dates and provider snapshot as usage. */
export function DashboardInsights({
	data,
	hiddenPanels = NO_HIDDEN_PANELS,
}: {
	data?: DashboardUsageSeries;
	hiddenPanels?: ReadonlySet<DashboardPanelId>;
}) {
	const { t, locale } = useT();
	if (!data) return null;
	const combined = isLabelUsageSeries(data);
	const coverage = new Map(
		!combined ? data.coverage?.days.map((day) => [day.date, day]) : [],
	);
	return (
		<div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
			{(
				[
					["jobs-by-day", "bytesEncoded", "insights.encodedVolume"],
					["live-airtime", "bytesEgress", "insights.egressVolume"],
				] as const
			).map(([id, metric, title]) => {
				if (!dashboardPanelIsVisible(hiddenPanels, id)) return null;
				const rows: {
					day: string;
					COMBINED?: number | null;
					VOD?: number | null;
					LIVE?: number | null;
				}[] = combined
					? data.days.map((day) => {
							const value =
								metric === "bytesEncoded"
									? day.bytesEncoded
									: day.billableEgressBytes;
							return {
								day: day.date,
								COMBINED: value === null ? null : value / 2 ** 30,
							};
						})
					: data.days.map((day) => ({
							day: day.date,
							VOD:
								coverage.get(day.date)?.VOD === false
									? null
									: day.VOD[metric] / 2 ** 30,
							LIVE:
								coverage.get(day.date)?.LIVE === false
									? null
									: day.LIVE[metric] / 2 ** 30,
						}));
				const empty = rows.every((day) =>
					"COMBINED" in day ? !day.COMBINED : !day.VOD && !day.LIVE,
				);
				const missing = combined
					? rows.some((day) => "COMBINED" in day && day.COMBINED === null)
					: !!data.coverage?.missingDays;
				return (
					<section
						key={id}
						className="min-w-0 rounded-lg border border-zinc-800 bg-zinc-950/40 p-4"
					>
						<h3 className="font-medium text-sm text-zinc-200">
							{t(
								combined && metric === "bytesEgress"
									? "usage.billableEgressTitle"
									: title,
							)}
						</h3>
						<div className="mt-3 h-44 min-w-0">
							{empty ? (
								<p className="text-xs text-zinc-400">
									{t(missing ? "usage.notRetrieved" : "usage.empty")}
								</p>
							) : (
								<ResponsiveContainer
									width="100%"
									height="100%"
									initialDimension={{ width: 0, height: 176 }}
								>
									<BarChart data={rows}>
										<CartesianGrid
											stroke="var(--color-zinc-800)"
											vertical={false}
										/>
										<XAxis
											dataKey="day"
											tickFormatter={(day: string) => day.slice(5)}
											stroke="var(--color-zinc-500)"
											fontSize={10}
										/>
										<YAxis
											stroke="var(--color-zinc-500)"
											fontSize={10}
											width={45}
										/>
										<Tooltip
											formatter={(value: unknown) =>
												`${new Intl.NumberFormat(locale, { maximumFractionDigits: 3 }).format(Number(value))} GiB`
											}
											contentStyle={{
												background: "var(--color-zinc-900)",
												border: "1px solid var(--color-zinc-700)",
												fontSize: 12,
											}}
										/>
										<Legend wrapperStyle={{ fontSize: 11 }} />
										{combined ? (
											<Bar
												dataKey="COMBINED"
												name={t("usage.combined")}
												fill="#60a5fa"
											/>
										) : (
											<>
												<Bar
													dataKey="VOD"
													name={t("usage.vod")}
													fill="#60a5fa"
												/>
												<Bar
													dataKey="LIVE"
													name={t("usage.live")}
													fill="#f472b6"
												/>
											</>
										)}
									</BarChart>
								</ResponsiveContainer>
							)}
						</div>
					</section>
				);
			})}
		</div>
	);
}
