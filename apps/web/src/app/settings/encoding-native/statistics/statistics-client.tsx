"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { type FormEvent, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, SelectNative } from "@/components/ui/input";
import { apiFetch } from "@/lib/api";
import {
	type EncodingStatisticsResult,
	type StatisticsRow,
	type StatisticsView,
	statisticsViews,
} from "@/lib/encoding-statistics";
import { useT } from "@/lib/i18n/context";

type Account = { id: string; label: string };

const labels = {
	totals: "encodingStatistics.totals",
	daily: "encodingStatistics.daily",
	live: "encodingStatistics.live",
	vod: "encodingStatistics.vod",
	labels: "encodingStatistics.labels",
	"daily-labels": "encodingStatistics.dailyLabels",
	cdn: "encodingStatistics.cdn",
	"live-options": "encodingStatistics.liveOptions",
} as const;

const metricLabels = {
	date: "encodingStatistics.date",
	from: "encodingStatistics.from",
	to: "encodingStatistics.to",
	label: "encodingStatistics.label",
	bytesEncoded: "encodingStatistics.encodedBytes",
	bytesEncodedTotal: "encodingStatistics.encodedBytes",
	timeEncoded: "encodingStatistics.encodedSeconds",
	timeEncodedTotal: "encodingStatistics.encodedSeconds",
	bytesEgress: "encodingStatistics.egressBytes",
	bytesEgressTotal: "encodingStatistics.egressBytes",
	billableMinutes: "encodingStatistics.billableMinutes",
	billableTransmuxingMinutes: "encodingStatistics.transmuxingMinutes",
	billableFeatureMinutes: "encodingStatistics.featureMinutes",
	timeEnqueued: "encodingStatistics.queueSeconds",
	realtimeFactor: "encodingStatistics.realtimeFactor",
	storageUsage: "encodingStatistics.cdnStorage",
	storageUsageTotal: "encodingStatistics.cdnStorage",
	transferUsage: "encodingStatistics.cdnTransfer",
	transferUsageTotal: "encodingStatistics.cdnTransfer",
	encodingId: "encodingStatistics.encodingId",
	type: "encodingStatistics.optionType",
	unitsUsed: "encodingStatistics.unitsUsed",
} as const;

function StatisticsTable({ rows }: { rows: StatisticsRow[] }) {
	const { locale, t } = useT();
	const columns = [...new Set(rows.flatMap(Object.keys))];
	const numbers = new Intl.NumberFormat(locale, { maximumFractionDigits: 4 });
	if (columns.length === 0) return <p>{t("encodingStatistics.empty")}</p>;
	return (
		<div className="overflow-x-auto rounded-md border border-border">
			<table className="w-full text-left text-sm">
				<thead>
					<tr className="border-b border-border">
						{columns.map((key) => (
							<th key={key} scope="col" className="whitespace-nowrap px-3 py-2">
								{Object.hasOwn(metricLabels, key)
									? t(metricLabels[key as keyof typeof metricLabels])
									: key}
							</th>
						))}
					</tr>
				</thead>
				<tbody className="divide-y divide-border">
					{rows.map((row, index) => (
						<tr key={index}>
							{columns.map((key) => (
								<td
									key={key}
									className="whitespace-nowrap px-3 py-2 tabular-nums"
								>
									{typeof row[key] === "number"
										? numbers.format(row[key])
										: (row[key] ?? "—")}
								</td>
							))}
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

export function EncodingStatisticsClient() {
	const { t } = useT();
	const fieldId = useId();
	const [view, setView] = useState<StatisticsView>("totals");
	const [range, setRange] = useState(false);
	const [submitted, setSubmitted] = useState("");
	const [offsets, setOffsets] = useState([0]);
	const offset = offsets.at(-1) ?? 0;
	const accounts = useQuery({
		queryKey: ["bitmovin-accounts"],
		queryFn: ({ signal }) =>
			apiFetch<Account[]>("/api/bitmovin-accounts", { signal }),
	});
	const statistics = useQuery({
		queryKey: ["encoding-statistics", submitted, offset],
		queryFn: ({ signal }) => {
			const params = new URLSearchParams(submitted);
			if (offset > 0) params.set("offset", String(offset));
			return apiFetch<EncodingStatisticsResult>(
				`/api/encoding-native/statistics?${params}`,
				{ signal },
			);
		},
		enabled: !!submitted,
		retry: false,
	});

	function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const params = new URLSearchParams({ view });
		for (const [key, value] of new FormData(event.currentTarget)) {
			if (typeof value !== "string") continue;
			const text = key === "encodingId" ? value.trim() : value;
			if (text) params.set(key, text);
		}
		setOffsets([0]);
		if (params.toString() === submitted && offset === 0)
			void statistics.refetch();
		else setSubmitted(params.toString());
	}

	const allowRange = view !== "live-options" && view !== "cdn";
	const page = statistics.data?.page;
	return (
		<div className="space-y-5">
			<header className="space-y-1">
				<Link
					href="/settings/encoding-native"
					className="text-sm text-muted-foreground underline"
				>
					{t("encodingNative.title")}
				</Link>
				<h1 className="text-2xl font-semibold">
					{t("encodingStatistics.title")}
				</h1>
			</header>
			<form
				className="grid gap-3 md:grid-cols-2 xl:grid-cols-3"
				onSubmit={submit}
				onChange={() => setSubmitted("")}
			>
				<label className="space-y-1 text-sm" htmlFor={`${fieldId}-account`}>
					<span>{t("encodingStatistics.account")}</span>
					<SelectNative
						id={`${fieldId}-account`}
						name="accountId"
						required
						disabled={!accounts.data?.length}
					>
						<option value="">{t("encodingStatistics.selectAccount")}</option>
						{accounts.data?.map(({ id, label }) => (
							<option key={id} value={id}>
								{label}
							</option>
						))}
					</SelectNative>
				</label>
				<label className="space-y-1 text-sm" htmlFor={`${fieldId}-view`}>
					<span>{t("encodingStatistics.view")}</span>
					<SelectNative
						id={`${fieldId}-view`}
						value={view}
						onChange={(event) => {
							setView(event.currentTarget.value as StatisticsView);
							setRange(false);
						}}
					>
						{statisticsViews.map((item) => (
							<option key={item} value={item}>
								{t(labels[item])}
							</option>
						))}
					</SelectNative>
				</label>
				{allowRange && (
					<label className="flex items-center gap-2 self-end pb-2 text-sm">
						<input
							type="checkbox"
							checked={range}
							onChange={(event) => setRange(event.currentTarget.checked)}
						/>
						{t("encodingStatistics.limitDates")}
					</label>
				)}
				{(range || view === "cdn") && (
					<>
						<label className="space-y-1 text-sm" htmlFor={`${fieldId}-from`}>
							<span>{t("encodingStatistics.from")}</span>
							<Input id={`${fieldId}-from`} type="date" name="from" required />
						</label>
						<label className="space-y-1 text-sm" htmlFor={`${fieldId}-to`}>
							<span>{t("encodingStatistics.to")}</span>
							<Input id={`${fieldId}-to`} type="date" name="to" required />
						</label>
					</>
				)}
				{(view === "labels" || view === "daily-labels") && (
					<label className="space-y-1 text-sm" htmlFor={`${fieldId}-label`}>
						<span>{t("encodingStatistics.label")}</span>
						<Input
							id={`${fieldId}-label`}
							type="text"
							name="label"
							maxLength={256}
						/>
					</label>
				)}
				{view === "live-options" && (
					<label className="space-y-1 text-sm" htmlFor={`${fieldId}-encoding`}>
						<span>{t("encodingStatistics.encodingId")}</span>
						<Input
							id={`${fieldId}-encoding`}
							type="text"
							name="encodingId"
							required
						/>
					</label>
				)}
				<div className="flex items-end">
					<Button
						type="submit"
						disabled={!accounts.data?.length || statistics.isFetching}
					>
						{t("encodingStatistics.load")}
					</Button>
				</div>
			</form>
			{accounts.isError && (
				<p role="alert">{t("encodingStatistics.accountsFailed")}</p>
			)}
			{statistics.isError && submitted && (
				<p role="alert">{t("encodingStatistics.failed")}</p>
			)}
			{statistics.data && submitted && (
				<div className="space-y-4">
					{statistics.data.totals && (
						<StatisticsTable rows={[statistics.data.totals]} />
					)}
					<StatisticsTable rows={statistics.data.rows} />
					{page?.nextOffset == null &&
						page &&
						offset + page.received < page.totalCount && (
							<p className="text-sm text-muted-foreground">
								{t("encodingStatistics.returned", {
									count: page.received,
									total: page.totalCount,
								})}
							</p>
						)}
					{page && (offsets.length > 1 || page.nextOffset !== null) && (
						<nav
							className="flex gap-2"
							aria-label={t("encodingNative.pagination")}
						>
							<Button
								variant="secondary"
								disabled={offsets.length < 2}
								onClick={() => setOffsets(offsets.slice(0, -1))}
							>
								{t("providerResources.previous")}
							</Button>
							<Button
								variant="secondary"
								disabled={page.nextOffset === null}
								onClick={() => {
									if (page.nextOffset !== null)
										setOffsets([...offsets, page.nextOffset]);
								}}
							>
								{t("providerResources.next")}
							</Button>
						</nav>
					)}
				</div>
			)}
		</div>
	);
}
