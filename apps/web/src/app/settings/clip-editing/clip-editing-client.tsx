"use client";

import {
	LOCAL_SEMANTIC_HEARTBEAT_TTL_MS,
	type LocalSemanticReadinessReport,
} from "@bitovp/core";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { HelpOverlay } from "@/components/ui/help-overlay";
import { apiFetch } from "@/lib/api";
import { useMutationAccess } from "@/lib/auth/use-role-access";
import { useSession } from "@/lib/auth/use-session";
import { useT } from "@/lib/i18n/context";

export function ClipEditingClient() {
	const { t, locale } = useT();
	const canDiagnose = useMutationAccess("settings.clip-editing-diagnose");
	const session = useSession();
	const query = useQuery({
		queryKey: [
			"clip-editing-diagnostics",
			session.data?.organizationId,
			session.data?.actorUserId,
			session.data?.effectiveUserId,
			canDiagnose,
		],
		enabled: session.status === "success" && session.data.authenticated,
		queryFn: async ({ signal }) => {
			const configuration = await apiFetch<LocalSemanticReadinessReport>(
				"/api/settings/clip-editing",
				{ signal },
			);
			signal.throwIfAborted();
			if (!canDiagnose || configuration.configuration !== "CONFIGURED")
				return configuration;
			return apiFetch<LocalSemanticReadinessReport>(
				"/api/settings/clip-editing",
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: "{}",
					signal,
				},
			);
		},
		retry: false,
		refetchOnWindowFocus: false,
		refetchOnMount: "always",
		staleTime: LOCAL_SEMANTIC_HEARTBEAT_TTL_MS,
	});
	const data = query.isFetching || query.isError ? undefined : query.data;
	const checkedAt = data?.checkedAt;
	const [expiredAt, setExpiredAt] = useState<string>();
	useEffect(() => {
		if (!checkedAt) return;
		const remaining =
			Date.parse(checkedAt) + LOCAL_SEMANTIC_HEARTBEAT_TTL_MS - Date.now();
		if (!Number.isFinite(remaining)) return;
		const timeout = setTimeout(
			() => setExpiredAt(checkedAt),
			Math.max(0, remaining),
		);
		return () => clearTimeout(timeout);
	}, [checkedAt]);
	const expired =
		!!checkedAt &&
		(expiredAt === checkedAt ||
			!Number.isFinite(Date.parse(checkedAt)) ||
			Date.now() - Date.parse(checkedAt) >= LOCAL_SEMANTIC_HEARTBEAT_TTL_MS);
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
							query.isPending ||
							query.isFetching ||
							(!query.isError && data?.configuration !== "CONFIGURED")
						}
						onClick={() => {
							void query.refetch({ cancelRefetch: false });
						}}
					>
						{t(
							query.isFetching
								? "clipDiagnostics.checking"
								: "clipDiagnostics.diagnose",
						)}
					</Button>
				) : null}
			</div>
			{query.isPending || query.isFetching ? (
				<p className="mt-6 text-sm text-zinc-500">{t("common.loading")}</p>
			) : null}
			{query.isError ? (
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
									{expired &&
									row.label !== "clipDiagnostics.configuration" &&
									row.code !== "NOT_CHECKED"
										? t("clipDiagnostics.stale")
										: t(`clipDiagnostics.states.${row.code}`)}
									{row.label === "clipDiagnostics.worker" &&
									!expired &&
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
