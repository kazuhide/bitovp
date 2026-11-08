"use client";

import type { LocalSemanticReadinessReport } from "@bitovp/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { HelpOverlay } from "@/components/ui/help-overlay";
import { apiFetch } from "@/lib/api";
import { useMutationAccess } from "@/lib/auth/use-role-access";
import { useT } from "@/lib/i18n/context";

const queryKey = ["clip-editing-diagnostics"] as const;
export function ClipEditingClient() {
	const { t, locale } = useT();
	const canDiagnose = useMutationAccess("settings.clip-editing-diagnose");
	const client = useQueryClient();
	const query = useQuery({
		queryKey,
		queryFn: () =>
			apiFetch<LocalSemanticReadinessReport>("/api/settings/clip-editing"),
		retry: false,
		refetchOnWindowFocus: false,
		staleTime: Infinity,
	});
	const diagnose = useMutation({
		mutationFn: () =>
			apiFetch<LocalSemanticReadinessReport>("/api/settings/clip-editing", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{}",
			}),
		onSuccess: (data) => client.setQueryData(queryKey, data),
	});
	const data = query.data;
	const rows = data
		? [
				{
					label: "clipDiagnostics.configuration" as const,
					code: data.configuration,
				},
				{ label: "clipDiagnostics.worker" as const, code: data.worker.code },
				{ label: "clipDiagnostics.gateway" as const, code: data.gateway.code },
			]
		: [];
	return (
		<section className="max-w-3xl">
			<div className="flex flex-wrap items-center justify-between gap-4">
				<div className="flex items-center gap-2">
					<h1 className="font-semibold text-xl text-zinc-50">
						{t("clipDiagnostics.title")}
					</h1>
					<HelpOverlay labelFor={t("clipDiagnostics.title")}>
						<p className="leading-relaxed">{t("clipDiagnostics.scope")}</p>
					</HelpOverlay>
				</div>
				{canDiagnose ? (
					<Button
						variant="secondary"
						size="sm"
						disabled={
							data?.configuration !== "CONFIGURED" || diagnose.isPending
						}
						onClick={() => diagnose.mutate()}
					>
						{t(
							diagnose.isPending
								? "clipDiagnostics.checking"
								: "clipDiagnostics.diagnose",
						)}
					</Button>
				) : null}
			</div>
			{query.isPending ? (
				<p className="mt-6 text-sm text-zinc-500">{t("common.loading")}</p>
			) : null}
			{query.isError || diagnose.isError ? (
				<p role="alert" className="mt-4 text-sm text-amber-300">
					{t("clipDiagnostics.failed")}
				</p>
			) : null}
			{data ? (
				<>
					<dl
						aria-live="polite"
						className="mt-6 divide-y divide-zinc-800 rounded-lg border border-zinc-800 bg-zinc-900/40 px-4"
					>
						{rows.map((row) => (
							<div
								key={row.label}
								className="grid grid-cols-[minmax(7rem,1fr)_minmax(0,2fr)] gap-4 py-4 text-sm leading-relaxed"
							>
								<dt className="text-zinc-400">{t(row.label)}</dt>
								<dd className="min-w-0 text-zinc-100">
									{t(`clipDiagnostics.states.${row.code}`)}
									{row.label === "clipDiagnostics.worker" &&
									data.worker.readyCount + data.worker.failedCount > 0 ? (
										<p className="mt-1 text-xs text-zinc-500">
											{t("clipDiagnostics.counts", {
												ready: data.worker.readyCount,
												failed: data.worker.failedCount,
											})}
										</p>
									) : null}
								</dd>
							</div>
						))}
					</dl>
					{data.gateway.code !== "NOT_CHECKED" ? (
						<p className="mt-3 text-xs text-zinc-500">
							{t("clipDiagnostics.checkedAt", {
								time: new Date(data.checkedAt).toLocaleString(locale),
							})}
						</p>
					) : null}
					<details className="mt-5 text-sm text-zinc-400">
						<summary className="cursor-pointer text-zinc-300">
							{t("clipDiagnostics.details")}
						</summary>
						<div className="mt-3 space-y-3 leading-relaxed">
							<p>{t("clipDiagnostics.scope")}</p>
							{data.configuration !== "CONFIGURED" ? (
								<p>{t("clipDiagnostics.configurationRecovery")}</p>
							) : null}
							{data.worker.code !== "READY" &&
							data.worker.code !== "NOT_CHECKED" ? (
								<p>{t("clipDiagnostics.workerRecovery")}</p>
							) : null}
							{data.gateway.code === "READY" ? (
								<p>{t("clipDiagnostics.metadataOnly")}</p>
							) : data.gateway.code !== "NOT_CHECKED" ? (
								<p>{t("clipDiagnostics.gatewayRecovery")}</p>
							) : null}
						</div>
					</details>
				</>
			) : null}
		</section>
	);
}
