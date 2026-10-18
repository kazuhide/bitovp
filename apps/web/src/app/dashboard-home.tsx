"use client";

import {
	type DashboardUsageSeries,
	isLabelUsageSeries,
	USAGE_PERIOD_DAYS,
	type UsagePeriodDays,
} from "@bitovp/core";
import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { PageContext } from "@/components/page-context";
import { Button } from "@/components/ui/button";
import { InfoHint } from "@/components/ui/info-hint";
import { Input, SelectNative } from "@/components/ui/input";
import { apiFetch } from "@/lib/api";
import { useT } from "@/lib/i18n/context";
import { DashboardBackfill } from "./dashboard-backfill";
import { DashboardInsights } from "./dashboard-insights";
import { DashboardLabelFilter } from "./dashboard-label-filter";
import { DashboardLabelUsage } from "./dashboard-label-usage";
import { DashboardPanelPicker } from "./dashboard-panel-picker";
import {
	DASHBOARD_INSIGHT_PANEL_IDS,
	DASHBOARD_PANEL_IDS,
	dashboardPanelIsVisible,
} from "./dashboard-panels";
import { DashboardUsage } from "./dashboard-usage";
import { useDashboardPanelPreferences } from "./use-dashboard-panel-preferences";

function presetRange(days: UsagePeriodDays) {
	const to = new Date();
	const from = new Date(to);
	from.setUTCDate(from.getUTCDate() - days + 1);
	return {
		from: from.toISOString().slice(0, 10),
		to: to.toISOString().slice(0, 10),
	};
}

export function DashboardHome() {
	const { t } = useT();
	const controlId = useId();
	const { hiddenPanels, preferencesLoaded, togglePanel, showAllPanels } =
		useDashboardPanelPreferences();
	const [selectedAccount, setSelectedAccount] = useState("");
	const [selectedLabel, setSelectedLabel] = useState<{
		accountId: string;
		value: string;
	} | null>(null);
	const [days, setDays] = useState<UsagePeriodDays | null>(30);
	const [range, setRange] = useState(() => presetRange(30));
	const [draftRange, setDraftRange] = useState(range);
	const accounts = useQuery({
		queryKey: ["bitmovin-accounts"],
		queryFn: () =>
			apiFetch<{ id: string; label: string }[]>("/api/bitmovin-accounts"),
	});
	const accountId =
		accounts.data?.find((account) => account.id === selectedAccount)?.id ??
		accounts.data?.[0]?.id ??
		"";
	const anyVisible = DASHBOARD_PANEL_IDS.some((id) =>
		dashboardPanelIsVisible(hiddenPanels, id),
	);
	const label =
		selectedLabel?.accountId === accountId ? selectedLabel.value : "";
	const params = new URLSearchParams({ accountId, ...range });
	if (label) params.set("label", label);
	const series = useQuery({
		queryKey: ["dashboard-usage", accountId, range.from, range.to, label],
		queryFn: ({ signal }) =>
			apiFetch<DashboardUsageSeries>(`/api/dashboard/usage?${params}`, {
				signal,
			}),
		enabled: preferencesLoaded && anyVisible && !!accountId,
		staleTime: 5 * 60 * 1000,
	});
	const showTrends = DASHBOARD_INSIGHT_PANEL_IDS.some((id) =>
		dashboardPanelIsVisible(hiddenPanels, id),
	);
	const today = presetRange(7).to;
	const canApplyRange =
		draftRange.from >= "2013-01-01" &&
		draftRange.to <= today &&
		draftRange.from <= draftRange.to &&
		(draftRange.from !== range.from || draftRange.to !== range.to);
	const accountControl = (
		<div className="flex min-w-0 max-w-40 items-center justify-end gap-2 text-xs">
			<span aria-hidden="true" className="shrink-0 text-zinc-400">
				Bitmovin
			</span>
			{accounts.data?.length === 1 ? (
				<dl className="min-w-0">
					<dt className="sr-only">{t("usage.account")}</dt>
					<dd
						className="max-w-40 truncate text-xs text-zinc-300"
						title={accounts.data[0]?.label}
					>
						{accounts.data[0]?.label}
					</dd>
				</dl>
			) : (
				<>
					<label className="sr-only" htmlFor={`${controlId}-account`}>
						{t("usage.account")}
					</label>
					<SelectNative
						id={`${controlId}-account`}
						className="h-8 w-28 min-w-0 text-xs"
						value={accountId}
						disabled={!accounts.data?.length}
						onChange={(event) => {
							setSelectedAccount(event.target.value);
							setSelectedLabel(null);
						}}
					>
						{!accounts.data?.length ? (
							<option value="">
								{t(accounts.isPending ? "common.loading" : "usage.noAccounts")}
							</option>
						) : null}
						{accounts.data?.map((account) => (
							<option key={account.id} value={account.id}>
								{account.label}
							</option>
						))}
					</SelectNative>
				</>
			)}
		</div>
	);
	return (
		<section>
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div className="min-w-0 max-w-3xl">
					<div className="flex items-center gap-2">
						<h1 className="font-semibold text-xl text-zinc-50">
							{t("dashboard.heading")}
						</h1>
						<InfoHint
							labelFor={t("dashboard.heading")}
							text={
								label
									? t("usage.labelSubtitle", { label })
									: t("usage.subtitle")
							}
						/>
					</div>
				</div>
				<div className="flex flex-wrap items-center justify-end gap-2">
					<PageContext>{accountControl}</PageContext>
					<DashboardPanelPicker
						key={accountId}
						hiddenPanels={hiddenPanels}
						onTogglePanel={togglePanel}
						onShowAllPanels={showAllPanels}
					>
						{accountId ? (
							<DashboardLabelFilter
								accountId={accountId}
								label={label}
								enabled={preferencesLoaded}
								onSelect={(value) =>
									setSelectedLabel(value ? { accountId, value } : null)
								}
							/>
						) : null}
					</DashboardPanelPicker>
				</div>
			</div>
			<div className="clear-both mt-2 space-y-2">
				<div className="flex flex-wrap items-center gap-x-3 gap-y-2">
					<div className="min-w-0">
						<div className="flex flex-wrap items-center gap-x-3 gap-y-2">
							<div>
								<div className="flex flex-wrap gap-1">
									{USAGE_PERIOD_DAYS.map((period) => (
										<Button
											key={period}
											size="sm"
											variant={days === period ? "secondary" : "ghost"}
											aria-pressed={days === period}
											onClick={() => {
												const next = presetRange(period);
												setDays(period);
												setRange(next);
												setDraftRange(next);
											}}
										>
											{t(`usage.period${period}`)}
										</Button>
									))}
								</div>
							</div>
							<form
								className="flex min-w-0 flex-wrap items-center gap-1.5"
								onSubmit={(event) => {
									event.preventDefault();
									if (!canApplyRange) return;
									setDays(null);
									setRange(draftRange);
								}}
							>
								<div>
									<label className="sr-only" htmlFor={`${controlId}-from`}>
										{t("usage.fromDate")}
									</label>
									<Input
										id={`${controlId}-from`}
										className="h-8 w-36 text-xs"
										type="date"
										required
										min="2013-01-01"
										max={draftRange.to || today}
										value={draftRange.from}
										onChange={(event) =>
											setDraftRange({ ...draftRange, from: event.target.value })
										}
									/>
								</div>
								<span aria-hidden="true" className="text-xs text-zinc-500">
									–
								</span>
								<div>
									<label className="sr-only" htmlFor={`${controlId}-to`}>
										{t("usage.toDate")}
									</label>
									<Input
										id={`${controlId}-to`}
										className="h-8 w-36 text-xs"
										type="date"
										required
										min={draftRange.from || "2013-01-01"}
										max={today}
										value={draftRange.to}
										onChange={(event) =>
											setDraftRange({ ...draftRange, to: event.target.value })
										}
									/>
								</div>
								<div>
									<Button
										type="submit"
										size="sm"
										variant="secondary"
										disabled={!canApplyRange}
									>
										{t("usage.applyRange")}
									</Button>
								</div>
							</form>
						</div>
					</div>
					{accountId && !label ? (
						<DashboardBackfill
							key={accountId}
							automatic={preferencesLoaded && anyVisible}
							accountId={accountId}
							{...range}
						/>
					) : null}
				</div>
				{accounts.error ? (
					<p role="alert" className="text-red-400 text-xs">
						{t("usage.loadFailed")}: {accounts.error.message}
						<Button
							size="sm"
							variant="ghost"
							disabled={accounts.isFetching}
							onClick={() => void accounts.refetch()}
						>
							{t("common.retry")}
						</Button>
					</p>
				) : null}
				{label ? (
					<div className="flex min-w-0 items-center gap-2 text-sm text-zinc-200">
						<span className="truncate" title={label}>
							{label}
						</span>
						<Button
							size="sm"
							variant="ghost"
							onClick={() => setSelectedLabel(null)}
						>
							{t("usage.clearLabel")}
						</Button>
					</div>
				) : null}
				<div className="flex flex-wrap items-center justify-between gap-2">
					<p className="text-xs text-zinc-400">
						{t("usage.selectedRange", { from: range.from, to: range.to })}
					</p>
				</div>
			</div>
			{!anyVisible ? (
				<p role="status" className="mt-6 text-sm text-zinc-400">
					{t("dashboard.allPanelsHidden")}{" "}
					<Button size="sm" variant="ghost" onClick={showAllPanels}>
						{t("dashboard.panelsReset")}
					</Button>
				</p>
			) : null}
			{anyVisible && accountId ? (
				<>
					{series.error ? (
						<p role="alert" className="mt-3 text-red-400 text-xs">
							{t("usage.loadFailed")}: {series.error.message}
							<Button
								size="sm"
								variant="ghost"
								disabled={series.isFetching}
								onClick={() => void series.refetch()}
							>
								{t("common.retry")}
							</Button>
						</p>
					) : null}
					{series.isPending ? (
						<p role="status" className="mt-3 text-xs text-zinc-400">
							{t("common.loading")}
						</p>
					) : null}
					{series.data?.coverage?.missingDays ? (
						<p role="status" className="mt-3 text-amber-400 text-xs">
							{t(label ? "usage.labelIncomplete" : "usage.incomplete", {
								count: series.data.coverage.missingDays,
							})}
						</p>
					) : null}
					{series.data ? (
						isLabelUsageSeries(series.data) ? (
							<DashboardLabelUsage
								hiddenPanels={hiddenPanels}
								data={series.data}
							/>
						) : (
							<DashboardUsage hiddenPanels={hiddenPanels} data={series.data} />
						)
					) : null}
					{showTrends && series.data ? (
						<section aria-labelledby="dashboard-trends" className="mt-10">
							<div className="flex items-center gap-2">
								<h2
									id="dashboard-trends"
									className="font-medium text-sm text-zinc-200"
								>
									{t("dashboard.trends")}
								</h2>
								<InfoHint
									labelFor={t("dashboard.trends")}
									text={t("insights.statisticsNote")}
								/>
							</div>
							<div className="mt-3">
								<DashboardInsights
									hiddenPanels={hiddenPanels}
									data={series.data}
								/>
							</div>
						</section>
					) : null}
				</>
			) : null}
		</section>
	);
}
