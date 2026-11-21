"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import {
	Bar,
	BarChart,
	CartesianGrid,
	Legend,
	Line,
	LineChart,
	ResponsiveContainer,
	Tooltip,
	XAxis,
	YAxis,
} from "recharts";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api";
import { useSession } from "@/lib/auth/use-session";
import { useT } from "@/lib/i18n/context";
import type {
	OperationAnalyticsDto,
	OperationAnalyticsWeek,
} from "@/lib/operation-analytics";
import { SettingsBreadcrumb } from "../settings-breadcrumb";

const OUTCOMES = [
	{
		key: "firstFrame",
		label: "operationAnalytics.firstFrame",
		color: "var(--color-green-400)",
	},
	{
		key: "failed",
		label: "operationAnalytics.failed",
		color: "var(--color-red-400)",
	},
	{
		key: "canceled",
		label: "operationAnalytics.canceled",
		color: "var(--color-amber-400)",
	},
	{
		key: "unconfirmed",
		label: "operationAnalytics.unconfirmed",
		color: "var(--color-zinc-600)",
	},
	{
		key: "pending",
		label: "operationAnalytics.pending",
		color: "var(--color-zinc-300)",
	},
] as const;
const COUNTS = [
	{ key: "started", label: "operationAnalytics.started" },
	...OUTCOMES,
] as const;
const DURATIONS = [
	{
		key: "p50Ms",
		label: "operationAnalytics.p50",
		color: "var(--color-blue-400)",
	},
	{
		key: "p95Ms",
		label: "operationAnalytics.p95",
		color: "var(--color-teal-400)",
	},
] as const;
const GRID_STROKE = "var(--color-zinc-800)";
const AXIS_TICK = { fill: "var(--color-zinc-400)", fontSize: 11 };
// The h-56 containers have a fixed height; width is measured after mount.
const INITIAL_DIMENSION = { width: 0, height: 224 };
const TOOLTIP_LABEL_STYLE = { color: "var(--color-zinc-200)" };
const TOOLTIP_STYLE = {
	background: "var(--color-zinc-900)",
	border: "1px solid var(--color-zinc-700)",
	borderRadius: 6,
	fontSize: 12,
};

export function OperationAnalytics() {
	const { t } = useT();
	const session = useSession();
	const identity =
		session.isSuccess && session.data.authenticated ? session.data : undefined;
	const tenant =
		identity?.mode === "users" ? identity.organizationId : identity?.mode;
	const report = useQuery({
		queryKey: ["operation-analytics", tenant],
		enabled: Boolean(tenant),
		queryFn: ({ signal }) =>
			apiFetch<OperationAnalyticsDto>("/api/operation-analytics", {
				cache: "no-store",
				headers: identity?.organizationId
					? { "x-bitovp-expected-org": identity.organizationId }
					: undefined,
				signal,
			}),
	});
	const loading = session.isPending || (Boolean(tenant) && report.isPending);

	return (
		<section>
			<SettingsBreadcrumb />
			<header className="flex flex-wrap items-baseline justify-between gap-2">
				<h1 className="font-semibold text-xl text-zinc-50">
					{t("operationAnalytics.title")}
				</h1>
				{report.isSuccess ? (
					<div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-zinc-400">
						<span>
							{t(
								report.data.isCollecting
									? "operationAnalytics.collecting"
									: "operationAnalytics.paused",
							)}
						</span>
						<Link
							href="/settings/features#feat-operation-analytics"
							className="text-zinc-200 underline underline-offset-4 hover:text-zinc-50"
						>
							{t("operationAnalytics.collectionSettings")}
						</Link>
					</div>
				) : null}
			</header>
			{loading ? (
				<p className="mt-5 text-sm text-zinc-400" role="status">
					{t("common.loading")}
				</p>
			) : null}
			{!loading && (!tenant || report.isError) ? (
				<div className="mt-5 flex flex-wrap items-center gap-3">
					<p className="text-sm text-red-400" role="alert">
						{t("operationAnalytics.loadFailed")}
					</p>
					<Button
						variant="secondary"
						onClick={() => {
							void (tenant ? report.refetch() : session.refetch());
						}}
					>
						{t("common.retry")}
					</Button>
				</div>
			) : null}
			{report.isSuccess ? <WeeklyReport weeks={report.data.weeks} /> : null}
		</section>
	);
}

function WeeklyReport({ weeks }: { weeks: OperationAnalyticsWeek[] }) {
	const { t, locale } = useT();
	const period = new Intl.DateTimeFormat(locale, {
		timeZone: "UTC",
		month: "short",
		day: "numeric",
		year: "numeric",
	});
	const tickDate = new Intl.DateTimeFormat(locale, {
		timeZone: "UTC",
		month: "numeric",
		day: "numeric",
	});
	const integer = new Intl.NumberFormat(locale);
	const decimal = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
	const percent = new Intl.NumberFormat(locale, {
		style: "percent",
		maximumFractionDigits: 1,
	});
	const hasAttempts = weeks.some((week) => week.started > 0);
	const hasDurations = weeks.some((week) => week.p50Ms !== null);
	const chartDate = (date: string) => tickDate.format(new Date(date));
	const tooltipDate = (value: unknown) =>
		typeof value === "string" ? chartDate(value) : "";
	const duration = (value: number) =>
		t("operationAnalytics.milliseconds", { value: decimal.format(value) });

	return (
		<div className="mt-2 space-y-4">
			<p className="text-sm text-zinc-400">{t("operationAnalytics.period")}</p>
			{hasAttempts ? (
				<div className="grid gap-4 xl:grid-cols-2">
					<section
						aria-labelledby="op-analytics-volume"
						className="min-w-0 rounded-lg border border-zinc-800 bg-zinc-950/40 p-4"
					>
						<h2
							id="op-analytics-volume"
							className="font-medium text-sm text-zinc-200"
						>
							{t("operationAnalytics.attempts")}
						</h2>
						<div aria-hidden="true" className="mt-3 h-56 min-w-0">
							<ResponsiveContainer
								width="100%"
								height="100%"
								minWidth={0}
								initialDimension={INITIAL_DIMENSION}
							>
								<BarChart data={weeks} accessibilityLayer={false}>
									<CartesianGrid stroke={GRID_STROKE} vertical={false} />
									<XAxis
										dataKey="weekStart"
										tickFormatter={chartDate}
										tick={AXIS_TICK}
									/>
									<YAxis allowDecimals={false} tick={AXIS_TICK} width={44} />
									<Tooltip
										labelFormatter={tooltipDate}
										contentStyle={TOOLTIP_STYLE}
										labelStyle={TOOLTIP_LABEL_STYLE}
									/>
									<Legend wrapperStyle={{ fontSize: 11 }} />
									{OUTCOMES.map(({ key, label, color }) => (
										<Bar
											key={key}
											dataKey={key}
											stackId="outcomes"
											name={t(label)}
											fill={color}
											isAnimationActive={false}
										/>
									))}
								</BarChart>
							</ResponsiveContainer>
						</div>
					</section>
					<section
						aria-labelledby="op-analytics-latency"
						className="min-w-0 rounded-lg border border-zinc-800 bg-zinc-950/40 p-4"
					>
						<h2
							id="op-analytics-latency"
							className="font-medium text-sm text-zinc-200"
						>
							{t("operationAnalytics.firstFrameTime")}
						</h2>
						{hasDurations ? (
							<div aria-hidden="true" className="mt-3 h-56 min-w-0">
								<ResponsiveContainer
									width="100%"
									height="100%"
									minWidth={0}
									initialDimension={INITIAL_DIMENSION}
								>
									<LineChart data={weeks} accessibilityLayer={false}>
										<CartesianGrid stroke={GRID_STROKE} vertical={false} />
										<XAxis
											dataKey="weekStart"
											tickFormatter={chartDate}
											tick={AXIS_TICK}
										/>
										<YAxis
											tick={AXIS_TICK}
											tickFormatter={duration}
											width={76}
										/>
										<Tooltip
											labelFormatter={tooltipDate}
											formatter={(value) =>
												typeof value === "number" ? duration(value) : "—"
											}
											contentStyle={TOOLTIP_STYLE}
											labelStyle={TOOLTIP_LABEL_STYLE}
										/>
										<Legend wrapperStyle={{ fontSize: 11 }} />
										{DURATIONS.map(({ key, label, color }) => (
											<Line
												key={key}
												dataKey={key}
												name={t(label)}
												stroke={color}
												connectNulls={false}
												dot={{ r: 3 }}
												isAnimationActive={false}
											/>
										))}
									</LineChart>
								</ResponsiveContainer>
							</div>
						) : (
							<p className="mt-3 flex h-56 items-center justify-center text-center text-sm text-zinc-400">
								{t("operationAnalytics.noFirstFrame")}
							</p>
						)}
					</section>
				</div>
			) : (
				<p className="text-sm text-zinc-400">{t("operationAnalytics.empty")}</p>
			)}
			<div className="overflow-x-auto rounded-md border border-zinc-800">
				<table className="w-full text-left text-sm">
					<caption className="sr-only">{t("operationAnalytics.table")}</caption>
					<thead className="bg-zinc-900 text-zinc-400">
						<tr>
							<th scope="col" className="whitespace-nowrap px-3 py-2">
								{t("operationAnalytics.week")}
							</th>
							{COUNTS.map(({ key, label }) => (
								<th key={key} scope="col" className="px-3 py-2 text-right">
									{t(label)}
								</th>
							))}
							<th scope="col" className="px-3 py-2 text-right">
								{t("operationAnalytics.share")}
							</th>
							{DURATIONS.map(({ key, label }) => (
								<th key={key} scope="col" className="px-3 py-2 text-right">
									{t(label)}
								</th>
							))}
						</tr>
					</thead>
					<tbody className="divide-y divide-zinc-800">
						{weeks.map((week) => (
							<tr key={week.weekStart}>
								<th
									scope="row"
									className="whitespace-nowrap px-3 py-2 font-medium"
								>
									<time dateTime={week.weekStart}>
										{period.format(new Date(week.weekStart))}
									</time>
									{week.isPartial ? (
										<span className="block font-normal text-xs text-zinc-400">
											{t("operationAnalytics.partial")}
										</span>
									) : null}
								</th>
								{COUNTS.map(({ key }) => (
									<td key={key} className="px-3 py-2 text-right tabular-nums">
										{integer.format(week[key])}
									</td>
								))}
								<td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">
									{week.firstFrameShare === null ? (
										"—"
									) : (
										<>
											{percent.format(week.firstFrameShare)}{" "}
											<span className="text-zinc-400">
												({integer.format(week.firstFrame)}/
												{integer.format(week.started - week.pending)})
											</span>
										</>
									)}
								</td>
								{DURATIONS.map(({ key }) => {
									const value = week[key];
									return (
										<td
											key={key}
											className="whitespace-nowrap px-3 py-2 text-right tabular-nums"
										>
											{value === null ? "—" : duration(value)}
										</td>
									);
								})}
							</tr>
						))}
					</tbody>
				</table>
			</div>
			<p className="text-xs text-zinc-400">
				{t("operationAnalytics.shareNote")}
			</p>
		</div>
	);
}
