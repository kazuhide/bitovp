"use client";

import type { LabelUsageSeries } from "@bitovp/core";
import {
	Bar,
	BarChart,
	CartesianGrid,
	ResponsiveContainer,
	Tooltip,
	XAxis,
	YAxis,
} from "recharts";
import { InfoHint } from "@/components/ui/info-hint";
import { useT } from "@/lib/i18n/context";
import {
	type DashboardPanelId,
	dashboardPanelIsVisible,
} from "./dashboard-panels";

/** Label metrics are combined provider values, never copied into both VOD and Live. */
export function DashboardLabelUsage({
	data,
	hiddenPanels,
}: {
	data: LabelUsageSeries;
	hiddenPanels: ReadonlySet<DashboardPanelId>;
}) {
	const { t, locale } = useT();
	const minutes = dashboardPanelIsVisible(hiddenPanels, "usage-minutes");
	const breakdown = dashboardPanelIsVisible(hiddenPanels, "usage-breakdown");
	if (!minutes && !breakdown) return null;
	const format = (value: number | null) =>
		value === null
			? t("usage.notRetrieved")
			: new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(
					value,
				);
	const empty = data.days.every((day) => !day.billableEncodingMinutes);
	return (
		<section aria-labelledby="label-usage" className="mt-6 min-w-0 space-y-3">
			<div className="flex items-center gap-2">
				<h2 id="label-usage" className="font-medium text-zinc-100">
					{t("usage.combined")}
				</h2>
				<InfoHint
					text={t("usage.labelCombinedHint")}
					labelFor={t("usage.combined")}
				/>
			</div>
			<dl>
				<dt className="text-xs text-zinc-500">{t("usage.totalMinutes")}</dt>
				<dd className="font-medium text-sm text-zinc-100">
					{format(data.totals.billableEncodingMinutes)}
				</dd>
			</dl>
			{data.days.some((day) => (day.billableEncodingMinutes ?? 0) < 0) ? (
				<p role="alert" className="text-amber-400 text-xs">
					{t("usage.negativeMinutes")}
				</p>
			) : null}
			<div className="grid min-w-0 grid-cols-1 gap-6 lg:grid-cols-2">
				{minutes ? (
					<section className="min-w-0 rounded-lg border border-zinc-800 bg-zinc-950/40 p-4">
						<h3 className="font-medium text-sm text-zinc-200">
							{t("usage.minutesTitle")}
						</h3>
						<div className="mt-3 h-44 min-w-0">
							{empty ? (
								<p className="text-xs text-zinc-400">
									{t(
										data.days.some(
											(day) => day.billableEncodingMinutes === null,
										)
											? "usage.notRetrieved"
											: "usage.empty",
									)}
								</p>
							) : (
								<ResponsiveContainer
									width="100%"
									height="100%"
									initialDimension={{ width: 0, height: 176 }}
								>
									<BarChart data={data.days}>
										<CartesianGrid
											stroke="var(--color-zinc-800)"
											vertical={false}
										/>
										<XAxis
											dataKey="date"
											tickFormatter={(date: string) => date.slice(5)}
											stroke="var(--color-zinc-500)"
											fontSize={10}
										/>
										<YAxis
											stroke="var(--color-zinc-500)"
											fontSize={10}
											width={40}
										/>
										<Tooltip
											formatter={(value) =>
												format(value == null ? null : Number(value))
											}
											contentStyle={{
												background: "var(--color-zinc-900)",
												border: "1px solid var(--color-zinc-700)",
												fontSize: 12,
											}}
										/>
										<Bar
											dataKey="billableEncodingMinutes"
											name={t("usage.combined")}
											fill="#60a5fa"
										/>
									</BarChart>
								</ResponsiveContainer>
							)}
						</div>
					</section>
				) : null}
				{breakdown ? (
					<section className="min-w-0 rounded-lg border border-zinc-800 bg-zinc-950/40 p-4">
						<h3 className="font-medium text-sm text-zinc-200">
							{t("usage.breakdownTitle")}
						</h3>
						{data.breakdown.length === 0 ? (
							<p className="mt-3 text-xs text-zinc-400">
								{t("usage.emptyBreakdown")}
							</p>
						) : (
							<>
								<div className="mt-3 flex items-center gap-1 text-xs text-zinc-500">
									{t("usage.resolution")}
									<InfoHint
										text={t("usage.classBreakdownNote")}
										labelFor={t("usage.resolution")}
									/>
								</div>
								<div className="min-w-0 overflow-x-auto text-xs">
									<table className="w-full text-left">
										<thead className="text-zinc-500">
											<tr>
												<th className="py-1 font-normal">{t("usage.codec")}</th>
												<th className="py-1 font-normal">
													{t("usage.resolution")}
												</th>
												<th className="py-1 text-right font-normal">
													{t("usage.minutes")}
												</th>
											</tr>
										</thead>
										<tbody className="text-zinc-200">
											{data.breakdown.map((row) => (
												<tr
													key={`${row.codec}:${row.resolution}`}
													className="border-zinc-800 border-t"
												>
													<td className="py-1">{row.codec}</td>
													<td className="py-1">{row.resolution}</td>
													<td className="py-1 text-right tabular-nums">
														{format(row.billableMinutes)}
													</td>
												</tr>
											))}
										</tbody>
									</table>
								</div>
							</>
						)}
					</section>
				) : null}
			</div>
			<p className="text-xs text-zinc-500">
				{t("usage.refreshedAt", {
					time: new Date(data.refreshedAt).toLocaleString(locale),
				})}
			</p>
		</section>
	);
}
