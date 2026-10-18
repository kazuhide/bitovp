"use client";
import type { LibrarySourceView } from "@bitovp/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api";
import { useMutationAccess } from "@/lib/auth/use-role-access";
import { localizedCustomerError } from "@/lib/customer-error";
import { useT } from "@/lib/i18n/context";
import type { JobAnalysisResponse } from "@/lib/job-analysis";
import { SourcePanel } from "./source-panel";
import { sourcePollingInterval } from "./source-polling";

export function useJobAnalysis(jobId: string, enabled: boolean) {
	return useQuery({
		queryKey: ["job-analysis", jobId],
		enabled,
		queryFn: () =>
			apiFetch<JobAnalysisResponse>(`/api/encoding-jobs/${jobId}/analysis`),
		refetchInterval: (query) =>
			query.state.data?.captureSuppressed || query.state.data?.enabled === false
				? false
				: query.state.data?.source
					? sourcePollingInterval(query.state.data.source.state)
					: 5_000,
	});
}

export function JobAnalysisPanel({
	jobId,
	enabled,
	captureSuppressed = false,
	source,
	error,
	locale,
	onLocaleChange,
	onSeek,
}: {
	jobId: string;
	enabled: boolean;
	captureSuppressed?: boolean;
	source?: LibrarySourceView | null;
	error?: Error | null;
	locale: string;
	onLocaleChange: (locale: string) => void;
	onSeek?: (seconds: number) => void;
}) {
	const { t } = useT();
	const canCapture = useMutationAccess("library.source.capture");
	const queryClient = useQueryClient();
	const capture = useMutation({
		mutationFn: () =>
			apiFetch(`/api/encoding-jobs/${jobId}/analysis`, { method: "POST" }),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["job-analysis", jobId] });
			queryClient.invalidateQueries({ queryKey: ["library"] });
		},
	});
	if (!enabled) return null;
	return (
		<details className="mt-6 rounded-md border border-zinc-800 p-4">
			<summary className="cursor-pointer font-medium text-sm">
				{t(captureSuppressed ? "library.title" : "library.analysis")}
			</summary>
			<div className="mt-3">
				{error ? (
					<p role="alert">{error.message}</p>
				) : captureSuppressed ? (
					<div className="space-y-2">
						<p className="text-sm text-zinc-400">
							{t("library.captureSuppressed")}
						</p>
						{canCapture ? (
							<Button
								size="sm"
								disabled={capture.isPending}
								onClick={() => capture.mutate()}
							>
								{t("library.recapture")}
							</Button>
						) : null}
						{capture.isError ? (
							<p role="alert" className="text-red-400 text-sm">
								{localizedCustomerError(
									t,
									capture.error,
									"common.requestFailed",
								)}
							</p>
						) : null}
					</div>
				) : source ? (
					<SourcePanel
						source={source}
						embeddedPlayback={{ locale, onLocaleChange, onSeek }}
					/>
				) : (
					<p className="text-sm text-zinc-400">
						{t("library.automaticImport")}
					</p>
				)}
			</div>
		</details>
	);
}
