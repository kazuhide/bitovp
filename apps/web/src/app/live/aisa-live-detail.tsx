"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { CopyableId } from "@/components/copyable-id";
import { Button } from "@/components/ui/button";
import type {
	AisaAnalysis,
	AisaResultsResponse,
} from "@/lib/aisa-live/contracts";
import { apiFetch } from "@/lib/api";
import { useT } from "@/lib/i18n/context";
import { AisaLiveActions } from "./aisa-live-actions";
import { AisaLiveIngest } from "./aisa-live-ingest";
import { AisaLiveResults } from "./aisa-live-results";
import {
	AISA_TERMINAL,
	AisaPreviewLinks,
	AisaPreviewNotice,
} from "./aisa-live-shared";

export function AisaLiveDetail(props: {
	accountId: string;
	analysisId: string;
}) {
	return (
		<AnalysisDetail key={`${props.accountId}:${props.analysisId}`} {...props} />
	);
}

function AnalysisDetail({
	accountId,
	analysisId,
}: Parameters<typeof AisaLiveDetail>[0]) {
	const { t } = useT();
	const cache = useQueryClient();
	const [hasFinalResult, setHasFinalResult] = useState(false);
	const base = `/api/live/analyses/${encodeURIComponent(analysisId)}`;
	const query = `bitmovinAccountId=${encodeURIComponent(accountId)}`;
	const resourceKey = ["aisa-live-analysis", accountId, analysisId];
	const resource = useQuery({
		queryKey: resourceKey,
		queryFn: async () => {
			const next = await apiFetch<AisaAnalysis>(`${base}?${query}`);
			const previous = cache.getQueryData<AisaAnalysis>(resourceKey);
			if (
				next.analysisId !== analysisId ||
				(previous && previous.encodingId !== next.encodingId)
			)
				throw new Error("Unexpected analysis identity");
			return next;
		},
		retry: false,
		refetchInterval: (state) =>
			state.state.data && AISA_TERMINAL.has(state.state.data.status)
				? false
				: 5000,
	});
	const results = useQuery({
		queryKey: ["aisa-live-results", accountId, analysisId],
		queryFn: () => apiFetch<AisaResultsResponse>(`${base}/results?${query}`),
		enabled: Boolean(resource.data),
		retry: false,
		refetchInterval: hasFinalResult ? false : 5000,
	});
	const refresh = async () => {
		const updated = await resource.refetch();
		if (updated.data) await results.refetch();
		return !updated.isError;
	};
	const analysis = resource.data;
	return (
		<section className="mx-auto max-w-5xl space-y-6">
			<header className="space-y-3">
				<div className="flex flex-wrap items-start justify-between gap-3">
					<div>
						<p className="mb-1 text-xs text-zinc-500">{t("aisaLive.title")}</p>
						<h1 className="break-words font-semibold text-xl text-zinc-50">
							{analysis?.name || t("aisaLive.title")}
						</h1>
					</div>
					<Button
						variant="secondary"
						onClick={refresh}
						disabled={resource.isFetching || results.isFetching}
					>
						{t("aisaLive.refresh")}
					</Button>
				</div>
				<AisaPreviewLinks />
			</header>
			<AisaPreviewNotice />
			{resource.isLoading ? (
				<p role="status" className="text-sm text-zinc-400">
					{t("aisaLive.loading")}
				</p>
			) : null}
			{resource.isError ? (
				<p role="alert" className="text-sm text-red-300">
					{t("aisaLive.requestFailed")}
				</p>
			) : null}
			{analysis ? (
				<>
					<dl className="grid gap-4 rounded-md border border-zinc-800 p-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
						<div>
							<dt className="text-xs text-zinc-500">
								{t("aisaLive.lifecycle")}
							</dt>
							<dd className="mt-1 text-zinc-200">{analysis.status}</dd>
						</div>
						<div className="min-w-0">
							<dt className="text-xs text-zinc-500">
								{t("aisaLive.analysisId")}
							</dt>
							<dd className="mt-1">
								<CopyableId
									value={analysis.analysisId}
									label={t("aisaLive.analysisId")}
								/>
							</dd>
						</div>
						<div className="min-w-0">
							<dt className="text-xs text-zinc-500">
								{t("aisaLive.encodingId")}
							</dt>
							<dd className="mt-1">
								<CopyableId
									value={analysis.encodingId}
									label={t("aisaLive.encodingId")}
								/>
							</dd>
						</div>
					</dl>
					{!AISA_TERMINAL.has(analysis.status) ? (
						<AisaLiveActions
							accountId={accountId}
							analysis={analysis}
							disabled={resource.isError || resource.isFetching}
							onRefresh={refresh}
						/>
					) : null}
					<AisaLiveIngest
						accountId={accountId}
						analysisId={analysisId}
						encodingId={analysis.encodingId}
						running={analysis.status === "RUNNING" && !resource.isError}
					/>
					<AisaLiveResults
						accountId={accountId}
						analysisId={analysisId}
						encodingId={analysis.encodingId}
						status={analysis.status}
						result={results.data}
						failed={results.isError}
						onFinal={setHasFinalResult}
					/>
				</>
			) : null}
		</section>
	);
}
