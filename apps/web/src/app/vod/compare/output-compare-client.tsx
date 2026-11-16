"use client";

import type { PlayerClientConfig } from "@bitovp/core";
import { useQueries } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api";
import { useT } from "@/lib/i18n/context";
import {
	type OutputJob,
	outputFormats,
	outputLinks,
	parseOutputJobIds,
} from "./output-selection";
import { SynchronizedPlayback } from "./synchronized-playback";

export function OutputCompareClient({
	player,
}: {
	player?: PlayerClientConfig;
}) {
	const { t } = useT();
	const params = useSearchParams();
	const router = useRouter();
	const ids = parseOutputJobIds(params.get("jobs"));
	const queries = useQueries({
		queries: ids.map((id) => ({
			queryKey: ["encoding-job", id],
			queryFn: () => apiFetch<OutputJob>(`/api/encoding-jobs/${id}`),
			staleTime: 30_000,
		})),
	});
	const rows = queries.map((query, index) => {
		const job = query.isError ? undefined : query.data;
		const links = outputLinks(job);
		const key = params.get(index === 0 ? "left" : "right");
		const selected =
			key === null ? links[0] : links.find((link) => link.key === key);
		const format = outputFormats(job?.plan);
		const heading = (
			<div className="min-w-0 space-y-2">
				<h2 className="truncate font-medium text-sm text-zinc-200">
					<Link
						className="hover:text-emerald-400"
						href={`/vod/jobs/${ids[index]}`}
					>
						{job?.name ?? ids[index]}
					</Link>
				</h2>
				<p className="text-xs text-zinc-400">
					{t("outputCompare.format", {
						format: format || t("outputCompare.formatUnknown"),
					})}
				</p>
				<label className="flex min-w-0 items-center gap-2 text-xs text-zinc-400">
					{t("outputCompare.output")}
					<select
						aria-label={`${t("outputCompare.output")} ${t(index === 0 ? "outputCompare.left" : "outputCompare.right")}`}
						value={selected?.key ?? key ?? ""}
						disabled={links.length === 0}
						className="min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-200 focus-visible:outline-2 focus-visible:outline-emerald-500"
						onChange={(event) => {
							const next = new URLSearchParams(params.toString());
							next.set(index === 0 ? "left" : "right", event.target.value);
							router.replace(`/vod/compare?${next.toString()}`);
						}}
					>
						{!selected ? (
							<option value={key ?? ""}>{t("outputCompare.missing")}</option>
						) : null}
						{links.map((link) => (
							<option
								key={link.key}
								value={link.key}
							>{`${link.label} (${link.kind})`}</option>
						))}
					</select>
				</label>
			</div>
		);
		return { query, job, links, selected, format, heading };
	});
	const outputs =
		rows[0]?.selected && rows[1]?.selected
			? ([
					{
						jobId: ids[0] as string,
						heading: rows[0].heading,
						link: rows[0].selected,
					},
					{
						jobId: ids[1] as string,
						heading: rows[1].heading,
						link: rows[1].selected,
					},
				] as const)
			: null;
	return (
		<section>
			<header className="flex flex-wrap items-center gap-3">
				<Link
					href="/vod/jobs"
					className="text-sm text-zinc-400 hover:text-emerald-400"
				>
					{t("pageTitles.vodJobs")}
				</Link>
				<h1 className="font-semibold text-xl text-zinc-50">
					{t("outputCompare.title")}
				</h1>
			</header>
			{ids.length !== 2 ? (
				<p className="mt-6 text-sm text-zinc-400">
					{t("outputCompare.pickTwo")}
				</p>
			) : queries.some((query) => query.isLoading) ? (
				<div
					role="status"
					aria-label={t("outputCompare.loading")}
					className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2"
				>
					{ids.map((id) => (
						<div
							key={id}
							className="aspect-video animate-pulse rounded-md bg-zinc-900"
						/>
					))}
				</div>
			) : outputs ? (
				<SynchronizedPlayback
					key={JSON.stringify(
						outputs.map((output) => [
							output.jobId,
							output.link.key,
							output.link.url,
						]),
					)}
					outputs={outputs}
					player={player}
				/>
			) : (
				<div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
					{rows.map((row, index) => (
						<section key={ids[index]} className="min-w-0 space-y-3">
							{row.heading}
							<p
								role={row.selected ? "status" : "alert"}
								className="text-sm text-amber-400"
							>
								{t(
									row.query.isError
										? "outputCompare.loadFailed"
										: row.selected
											? "outputCompare.waiting"
											: "outputCompare.unavailable",
								)}
							</p>
							{row.query.isError ? (
								<Button
									size="sm"
									variant="secondary"
									onClick={() => void row.query.refetch()}
								>
									{t("common.retry")}
								</Button>
							) : null}
						</section>
					))}
				</div>
			)}
			{rows.some((row) => /HDR|HLG|Dolby Vision/.test(row.format)) ? (
				<p className="mt-3 text-xs text-amber-400">
					{t("outputCompare.displayNotice")}
				</p>
			) : null}
		</section>
	);
}
