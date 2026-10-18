"use client";

import {
	type QueryClient,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useId, useRef } from "react";
import { Button } from "@/components/ui/button";
import { InfoHint } from "@/components/ui/info-hint";
import { apiFetch } from "@/lib/api";
import { useMutationAccess } from "@/lib/auth/use-role-access";
import { useT } from "@/lib/i18n/context";

import {
	type BackfillResult,
	useAutomaticUsageBackfill,
} from "./use-automatic-usage-backfill";

type ImportRequest = {
	accountId: string;
	from: string;
	to: string;
	automatic?: boolean;
};

/** Cancellation is required even with no cached data: invalidating alone joins
 * the first pending GET, whose earlier snapshot could then become "fresh". */
async function refreshAccountUsage(
	client: QueryClient,
	accountId: string,
	current: () => boolean,
) {
	if (!current()) return;
	const queryKey = ["dashboard-usage", accountId];
	await client.cancelQueries({ queryKey });
	if (current()) await client.invalidateQueries({ queryKey });
}

export function DashboardBackfill({
	accountId,
	from,
	to,
	automatic = false,
}: {
	accountId: string;
	from: string;
	to: string;
	automatic?: boolean;
}) {
	const { t } = useT();
	const hintId = useId();
	const allowed = useMutationAccess("dashboard.statistics-backfill");
	const client = useQueryClient();
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	const scope = useRef({ accountId, allowed });
	scope.current = { accountId, allowed };
	const queryKey = ["dashboard-backfill", accountId];
	const status = useQuery({
		queryKey,
		queryFn: ({ signal }) =>
			apiFetch<BackfillResult>(
				`/api/dashboard/usage/backfill?${new URLSearchParams({ accountId })}`,
				{ signal },
			),
		enabled: !!accountId,
		refetchInterval: (query) =>
			["queued", "running"].includes(query.state.data?.job?.status ?? "")
				? 2000
				: false,
	});
	const mutation = useMutation({
		onMutate: async (request: ImportRequest) => {
			await client.cancelQueries({
				queryKey: ["dashboard-backfill", request.accountId],
				exact: true,
			});
		},
		mutationFn: (request: ImportRequest): Promise<BackfillResult> => {
			if (
				!mounted.current ||
				!scope.current.allowed ||
				scope.current.accountId !== request.accountId
			)
				return Promise.resolve({ job: null });
			return apiFetch<BackfillResult>("/api/dashboard/usage/backfill", {
				method: "POST",
				body: JSON.stringify(
					request.automatic
						? { accountId: request.accountId, mode: "automatic" }
						: {
								accountId: request.accountId,
								from: request.from,
								to: request.to,
							},
				),
			});
		},
		onSuccess: async (result, request) => {
			if (
				!mounted.current ||
				!scope.current.allowed ||
				scope.current.accountId !== request.accountId
			)
				return;
			const key = ["dashboard-backfill", request.accountId];
			await client.cancelQueries({ queryKey: key, exact: true });
			if (
				mounted.current &&
				scope.current.allowed &&
				scope.current.accountId === request.accountId
			) {
				client.setQueryData(key, result);
				if (request.automatic && result.job === null)
					await refreshAccountUsage(
						client,
						request.accountId,
						() =>
							mounted.current &&
							scope.current.allowed &&
							scope.current.accountId === request.accountId,
					);
			}
		},
	});
	const automaticRefresh = useAutomaticUsageBackfill({
		accountId,
		enabled: automatic && allowed,
		job: status.data?.job,
		request: () =>
			mutation.mutateAsync({ accountId, from, to, automatic: true }),
	});

	const job = status.data?.job;
	useEffect(() => {
		if (job?.status !== "completed" || job.accountId !== accountId) return;
		let current = true;
		void refreshAccountUsage(
			client,
			accountId,
			() => current && mounted.current && scope.current.accountId === accountId,
		);
		return () => {
			current = false;
		};
	}, [job, accountId, client]);
	const busy =
		mutation.isPending || job?.status === "queued" || job?.status === "running";
	return (
		<div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs">
			{allowed ? (
				<Button
					size="sm"
					variant="secondary"
					aria-describedby={hintId}
					disabled={busy || !accountId}
					onClick={() => {
						automaticRefresh.manualStarted();
						mutation.mutate({ accountId, from, to });
					}}
				>
					{t("usage.backfill")}
				</Button>
			) : null}
			{allowed ? (
				<>
					<InfoHint
						labelFor={t("usage.backfill")}
						text={t("usage.backfillHint")}
					/>
					<p id={hintId} className="sr-only">
						{t("usage.backfillHint")}
					</p>
				</>
			) : null}
			{job ? (
				<p role="status" className="order-first min-w-0 text-zinc-400">
					{job.from !== from || job.to !== to
						? `${job.from} — ${job.to}: `
						: ""}
					{t(
						job.automatic &&
							(job.status === "queued" || job.status === "running")
							? job.status === "queued"
								? "usage.autoQueued"
								: "usage.autoRunning"
							: `usage.backfill${job.status}`,
					)}
					{job.status === "running" || job.status === "queued"
						? ` (${job.completedChunks}/${job.totalChunks})`
						: ""}
					{job.status === "completed"
						? ` · ${t("usage.backfillRows", { count: job.rowsUpserted })}`
						: ""}
				</p>
			) : null}
			{mutation.error || status.error || job?.status === "failed" ? (
				<p role="alert" className="basis-full text-red-400">
					{t("usage.backfillFailed")}
					{mutation.error ? `: ${mutation.error.message}` : ""}
					{automatic &&
					allowed &&
					(mutation.error || job?.status === "failed") ? (
						<Button
							size="sm"
							variant="ghost"
							disabled={busy}
							onClick={automaticRefresh.retry}
						>
							{t("usage.autoRetry")}
						</Button>
					) : null}
					{status.error ? (
						<Button
							size="sm"
							variant="ghost"
							disabled={status.isFetching}
							onClick={() => void status.refetch()}
						>
							{t("common.retry")}
						</Button>
					) : null}
				</p>
			) : null}
		</div>
	);
}
