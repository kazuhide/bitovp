"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { AisaAnalysisPage } from "@/lib/aisa-live/contracts";
import { apiFetch } from "@/lib/api";
import { useT } from "@/lib/i18n/context";
import {
	AISA_PAGE_SIZE,
	AisaAccountSelect,
	AisaPreviewLinks,
	AisaPreviewNotice,
	aisaDetailHref,
	useAisaAccounts,
} from "./aisa-live-shared";

export function AisaLiveList() {
	const { t } = useT();
	const accounts = useAisaAccounts();
	const [paging, setPaging] = useState({ accountId: "", offset: 0 });
	const offset = paging.accountId === accounts.accountId ? paging.offset : 0;
	const list = useQuery({
		queryKey: ["aisa-live-analyses", accounts.accountId, offset],
		queryFn: () =>
			apiFetch<AisaAnalysisPage>(
				`/api/live/analyses?bitmovinAccountId=${encodeURIComponent(accounts.accountId)}&offset=${offset}&limit=${AISA_PAGE_SIZE}`,
			),
		enabled: Boolean(accounts.accountId) && !accounts.accounts.isError,
		retry: false,
		refetchInterval: 15000,
	});
	const next =
		list.data?.totalCount === undefined
			? list.data?.items.length === AISA_PAGE_SIZE
			: offset + AISA_PAGE_SIZE < list.data.totalCount;
	return (
		<section className="mx-auto max-w-5xl space-y-6">
			<header className="space-y-3">
				<h1 className="font-semibold text-xl text-zinc-50">
					{t("aisaLive.title")}
				</h1>
				<AisaPreviewLinks />
			</header>
			<AisaPreviewNotice />
			<div className="max-w-md">
				<AisaAccountSelect state={accounts} />
			</div>
			{accounts.accountId ? (
				<>
					<div className="flex justify-end">
						<Button
							variant="secondary"
							disabled={list.isFetching}
							onClick={() => list.refetch()}
						>
							{t("aisaLive.refresh")}
						</Button>
					</div>
					{list.isLoading ? (
						<p role="status" className="text-sm text-zinc-400">
							{t("aisaLive.loading")}
						</p>
					) : null}
					{list.isError ? (
						<p role="alert" className="text-sm text-red-300">
							{t("aisaLive.requestFailed")}
						</p>
					) : null}
					{list.data?.items.length === 0 && !list.isError ? (
						<p
							role="status"
							className="rounded-md border border-zinc-800 border-dashed p-6 text-sm text-zinc-400"
						>
							{t("aisaLive.noAnalyses")}
						</p>
					) : null}
					{list.data?.items.length ? (
						<ul className="divide-y divide-zinc-800 rounded-md border border-zinc-800">
							{list.data.items.map((analysis) => (
								<li
									key={analysis.analysisId}
									className="flex flex-wrap items-center justify-between gap-3 p-4"
								>
									<div className="min-w-0">
										<Link
											className="break-words font-medium text-sm text-emerald-400 underline underline-offset-4"
											href={aisaDetailHref(
												accounts.accountId,
												analysis.analysisId,
											)}
										>
											{analysis.name || analysis.analysisId}
										</Link>
										<p className="mt-1 break-all font-mono text-xs text-zinc-500">
											{analysis.analysisId}
										</p>
									</div>
									<span className="text-xs text-zinc-400">
										{analysis.status}
									</span>
								</li>
							))}
						</ul>
					) : null}
					<div className="flex justify-between gap-3">
						<Button
							variant="secondary"
							disabled={offset === 0 || list.isFetching}
							onClick={() =>
								setPaging({
									accountId: accounts.accountId,
									offset: Math.max(0, offset - AISA_PAGE_SIZE),
								})
							}
						>
							{t("aisaLive.previous")}
						</Button>
						<Button
							variant="secondary"
							disabled={!next || list.isFetching}
							onClick={() =>
								setPaging({
									accountId: accounts.accountId,
									offset: offset + AISA_PAGE_SIZE,
								})
							}
						>
							{t("aisaLive.next")}
						</Button>
					</div>
				</>
			) : null}
		</section>
	);
}
