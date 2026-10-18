"use client";

import type { UsageSeries } from "@bitovp/core";
import { useState } from "react";
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
import { HelpOverlay } from "@/components/ui/help-overlay";
import { InfoHint } from "@/components/ui/info-hint";
import { useT } from "@/lib/i18n/context";
import {
	DASHBOARD_USAGE_PANEL_IDS,
	type DashboardPanelId,
	dashboardPanelIsVisible,
} from "./dashboard-panels";

const NO_HIDDEN_PANELS: ReadonlySet<DashboardPanelId> = new Set();
const VOD_FILL = "#60a5fa";
const LIVE_FILL = "#f472b6";

const shortDay = (day: string) => day.slice(5);

function formatMinutes(locale: string, minutes: number): string {
	return new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(
		minutes,
	);
}

function ChartCard({
	visible = true,
	title,
	help,
	empty,
	isEmpty,
	tall = false,
	children,
}: {
	visible?: boolean;
	title: string;
	help?: string;
	empty: string;
	isEmpty: boolean;
	tall?: boolean;
	children: React.ReactNode;
}) {
	if (!visible) {
		return null;
	}
	return (
		<div className="min-w-0 rounded-lg border border-zinc-800 bg-zinc-950/40 p-4">
			<div className="flex min-w-0 items-center gap-2">
				<h4 className="font-medium text-sm text-zinc-200">{title}</h4>
				{help ? <InfoHint text={help} labelFor={title} /> : null}
			</div>
			{isEmpty ? (
				<div
					className={
						tall
							? "mt-3 min-w-0"
							: "mt-3 flex h-44 min-w-0 items-center justify-center"
					}
				>
					<p className="text-center text-xs text-zinc-600">{empty}</p>
				</div>
			) : (
				<div className={tall ? "mt-3 min-w-0" : "mt-3 h-44 min-w-0"}>
					{children}
				</div>
			)}
		</div>
	);
}

function Stat({
	label,
	value,
	help,
}: {
	label: string;
	value: string;
	help?: string;
}) {
	return (
		<div className="min-w-0">
			<dt className="flex items-center gap-1 text-xs text-zinc-500">
				{label}
				{help ? <HelpOverlay labelFor={label}>{help}</HelpOverlay> : null}
			</dt>
			<dd className="mt-0.5 truncate font-medium text-sm text-zinc-100">
				{value}
			</dd>
		</div>
	);
}

export function DashboardUsage({
	hiddenPanels = NO_HIDDEN_PANELS,
	data,
}: {
	hiddenPanels?: ReadonlySet<DashboardPanelId>;
	data?: UsageSeries;
}) {
	const { t, locale } = useT();
	const [liveMetric, setLiveMetric] = useState<"UNITS" | "MINUTES">("UNITS");
	const visible = (id: DashboardPanelId) =>
		dashboardPanelIsVisible(hiddenPanels, id);
	if (!DASHBOARD_USAGE_PANEL_IDS.some(visible)) return null;
	const coverage = new Map(data?.coverage?.days.map((day) => [day.date, day]));
	const liveUnits = new Map(
		data?.liveHd?.days.map((day) => [day.date, day.units]) ?? [],
	);
	const unitsMissingDays = data?.liveHd?.missingDays ?? data?.days.length ?? 0;
	const dayRows =
		data?.days.map((d) => ({
			day: d.date,
			vod:
				coverage.get(d.date)?.VOD === false
					? null
					: d.VOD.billableEncodingMinutes,
			live:
				liveMetric === "UNITS"
					? (liveUnits.get(d.date) ?? null)
					: coverage.get(d.date)?.LIVE === false
						? null
						: d.LIVE.billableEncodingMinutes,
		})) ?? [];
	const minutesTooltip = (value: unknown) =>
		formatMinutes(locale, Number(value ?? 0));
	const hasNegativeMinutes =
		data &&
		[
			data.totals.VOD.billableEncodingMinutes,
			data.totals.LIVE.billableEncodingMinutes,
			...data.days.flatMap((d) => [
				d.VOD.billableEncodingMinutes,
				d.LIVE.billableEncodingMinutes,
			]),
			...Object.values(data.breakdown.buckets.VOD),
			...Object.values(data.breakdown.buckets.LIVE),
			...data.breakdown.codecResolution.map((row) => row.billableMinutes),
		].some((minutes) => minutes < 0);

	return (
		<section aria-labelledby="dashboard-usage" className="mt-3">
			<h2 id="dashboard-usage" className="sr-only">
				{t("dashboard.panelsUsage")}
			</h2>
			{hasNegativeMinutes ? (
				<p role="alert" className="mt-3 text-amber-400 text-xs">
					{t("usage.negativeMinutes")}
				</p>
			) : null}
			<div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
				{(["VOD", "LIVE"] as const).map((kind) => {
					const label = t(kind === "VOD" ? "usage.vod" : "usage.live");
					const key = kind === "VOD" ? "vod" : "live";
					const isUnits = kind === "LIVE" && liveMetric === "UNITS";
					const rows =
						data?.breakdown.codecResolution.filter(
							(row) => row.kind === kind,
						) ?? [];
					const missingRows =
						data?.breakdown.codecResolutionMissingRows?.[kind] ?? 0;
					const hasClasses = rows.some(
						(row) => row.source === "ENCODING_CLASS",
					);
					return (
						<section
							key={kind}
							aria-labelledby={`usage-${kind}`}
							className="min-w-0 space-y-3"
						>
							<div className="flex min-h-8 flex-wrap items-center justify-between gap-2">
								<h3 id={`usage-${kind}`} className="font-medium text-zinc-100">
									{label}
								</h3>
								{kind === "LIVE" && data && visible("usage-minutes") ? (
									<select
										aria-label={t("usage.liveMetric")}
										value={liveMetric}
										onChange={(event) =>
											setLiveMetric(
												event.target.value === "MINUTES" ? "MINUTES" : "UNITS",
											)
										}
										className="h-8 max-w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-200"
									>
										<option value="UNITS">{t("usage.liveUnitsTitle")}</option>
										<option value="MINUTES">
											{t("usage.liveMinutesMetric")}
										</option>
									</select>
								) : null}
							</div>
							<dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
								{kind === "LIVE" ? (
									<Stat
										label={t("usage.liveUnits")}
										help={t("usage.liveUnitsNote")}
										value={
											!data
												? t("common.unknown")
												: data.liveHd?.totalUnits == null
													? t("usage.notRetrieved")
													: formatMinutes(locale, data.liveHd.totalUnits)
										}
									/>
								) : null}
								<Stat
									label={t("usage.totalMinutes")}
									value={
										data?.coverage?.days.every((day) => !day[kind])
											? t("usage.notRetrieved")
											: data
												? formatMinutes(
														locale,
														data.totals[kind].billableEncodingMinutes,
													)
												: t("common.unknown")
									}
								/>
							</dl>
							{data ? (
								<div className="grid min-w-0 gap-4">
									<ChartCard
										visible={visible("usage-minutes")}
										title={t(
											isUnits ? "usage.liveUnitsTitle" : "usage.minutesTitle",
										)}
										empty={t(
											(isUnits && unitsMissingDays > 0) ||
												(!isUnits &&
													data.coverage?.days.some((day) => !day[kind]))
												? "usage.notRetrieved"
												: "usage.empty",
										)}
										isEmpty={dayRows.every(
											(day) => day[key] == null || day[key] === 0,
										)}
									>
										{/* h-44 parent; width stays unknown until measured. */}
										<ResponsiveContainer
											width="100%"
											height="100%"
											initialDimension={{ width: 0, height: 176 }}
										>
											<BarChart data={dayRows}>
												<CartesianGrid
													stroke="var(--color-zinc-800)"
													vertical={false}
												/>
												<XAxis
													dataKey="day"
													tickFormatter={shortDay}
													stroke="var(--color-zinc-500)"
													fontSize={10}
												/>
												<YAxis
													stroke="var(--color-zinc-500)"
													fontSize={10}
													width={40}
												/>
												<Tooltip
													formatter={minutesTooltip}
													labelStyle={{ color: "var(--color-zinc-200)" }}
													contentStyle={{
														background: "var(--color-zinc-900)",
														border: "1px solid var(--color-zinc-700)",
														fontSize: 12,
													}}
												/>
												<Legend wrapperStyle={{ fontSize: 11 }} />
												<Bar
													dataKey={key}
													name={isUnits ? t("usage.liveUnits") : label}
													fill={kind === "VOD" ? VOD_FILL : LIVE_FILL}
												/>
											</BarChart>
										</ResponsiveContainer>
									</ChartCard>
									<ChartCard
										visible={visible("usage-breakdown")}
										title={t("usage.breakdownTitle")}
										help={t(
											hasClasses
												? "usage.classBreakdownNote"
												: "usage.breakdownNote",
										)}
										empty={t("usage.emptyBreakdown")}
										isEmpty={rows.length === 0}
										tall
									>
										<div className="min-w-0 overflow-x-auto text-xs">
											<table className="w-full text-left">
												<thead className="text-zinc-500">
													<tr>
														<th className="py-1 font-normal">
															{t("usage.codec")}
														</th>
														<th className="py-1 font-normal">
															{t("usage.resolution")}
														</th>
														<th className="py-1 text-right font-normal">
															{t("usage.minutes")}
														</th>
													</tr>
												</thead>
												<tbody className="text-zinc-200">
													{rows.map((row) => (
														<tr
															key={`${row.source ?? "STREAM"}:${row.codec}:${row.resolution}`}
															className="border-zinc-800 border-t"
														>
															<td className="py-1">{row.codec}</td>
															<td className="py-1">{row.resolution}</td>
															<td className="py-1 text-right tabular-nums">
																{formatMinutes(locale, row.billableMinutes)}
															</td>
														</tr>
													))}
												</tbody>
											</table>
										</div>
									</ChartCard>
								</div>
							) : null}
							{visible("usage-breakdown") && missingRows > 0 ? (
								<p className="text-xs text-amber-400">
									{t("usage.missingCodecRecords", { count: missingRows })}
								</p>
							) : null}
							{kind === "LIVE" ? (
								<div className="space-y-1 text-xs text-zinc-500">
									{unitsMissingDays > 0 ? (
										<p>
											{t("usage.liveUnitsMissing", { count: unitsMissingDays })}
										</p>
									) : null}
								</div>
							) : null}
							{data ? (
								<details className="text-xs text-zinc-500">
									<summary className="cursor-pointer">
										{t("usage.otherApiValues")}
									</summary>
									<p className="my-2">{t("usage.otherApiValuesNote")}</p>
									<p className="my-2">{t("usage.rawTimeNote")}</p>
									<dl className="grid grid-cols-2 gap-3">
										<Stat
											label={t("usage.rawTime")}
											value={formatMinutes(
												locale,
												data.totals[kind].timeEncodedS,
											)}
										/>
										<Stat
											label={t("usage.featureMinutes")}
											value={formatMinutes(
												locale,
												data.totals[kind].billableFeatureMinutes,
											)}
										/>
										<Stat
											label={t("usage.transmuxingMinutes")}
											value={formatMinutes(
												locale,
												data.totals[kind].billableTransmuxingMinutes,
											)}
										/>
									</dl>
								</details>
							) : null}
						</section>
					);
				})}
			</div>
			{data ? (
				<p className="mt-3 text-xs text-zinc-500">
					{data.refreshedAt
						? t("usage.refreshedAt", {
								time: new Date(data.refreshedAt).toLocaleString(locale),
							})
						: t("usage.neverRefreshed")}
					{data.refreshedAt && data.pendingDays > 0
						? ` ${t("usage.pendingDays", { count: data.pendingDays })}`
						: ""}
					<span className="ml-1 inline-flex">
						<InfoHint
							text={t("usage.retentionNote")}
							labelFor={t("dashboard.panelsUsage")}
						/>
					</span>
				</p>
			) : null}
		</section>
	);
}
