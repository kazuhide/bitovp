"use client";

import {
	type UseQueryResult,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { DeleteResourceButton } from "@/components/delete-resource-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { HelpOverlay } from "@/components/ui/help-overlay";
import { apiFetch } from "@/lib/api";
import { RoleAccess, useRoleAccess } from "@/lib/auth/use-role-access";
import { localizedCustomerError } from "@/lib/customer-error";
import { formatDateTime } from "@/lib/format";
import { useT } from "@/lib/i18n/context";
import { customerFeederErrorMessage } from "@/lib/i18n/feeder-error";
import {
	FEEDER_STATUS_TONE,
	type FeederSessionDetail,
	type FeederSessionDiagnostics,
	feederFailureMessage,
	isActiveFeederStatus,
	parseLoopBoundary,
} from "../feeder-shared";
import { StopFeederSessionDialog } from "../stop-feeder-dialog";

function inputDestination(target: unknown): string {
	if (target === null || typeof target !== "object" || Array.isArray(target)) {
		return "—";
	}
	const value = target as Record<string, unknown>;
	if (typeof value.url === "string") {
		return value.url;
	}
	if (typeof value.host === "string") {
		return typeof value.port === "number"
			? `${value.host}:${value.port}`
			: value.host;
	}
	return "—";
}

/**
 * Customer detail leads with the file-input task. Process ownership, loop
 * telemetry and the sanitized log are fetched only after an ADMIN/owner opens
 * Diagnostics; they are absent from both the ordinary response and DOM.
 */
export function FeederDetail({ id }: { id: string }) {
	const { t } = useT();
	const queryClient = useQueryClient();
	const router = useRouter();
	const canViewDiagnostics = useRoleAccess("ADMIN");
	const [confirming, setConfirming] = useState(false);
	const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);

	const session = useQuery({
		queryKey: ["feeder-session", id],
		queryFn: () => apiFetch<FeederSessionDetail>(`/api/feeder-sessions/${id}`),
		refetchInterval: (query) => {
			const row = query.state.data;
			// ERROR/STOPPED can still hold a process or publisher claim. Stop
			// only acknowledges queueing: keep observing until cleanup lands.
			return row && (isActiveFeederStatus(row.status) || row.stoppable)
				? 3_000
				: false;
		},
	});

	const diagnostics = useQuery({
		queryKey: ["feeder-session-diagnostics", id],
		queryFn: () =>
			apiFetch<FeederSessionDiagnostics>(
				`/api/feeder-sessions/${id}?diagnostics=1`,
			),
		enabled: canViewDiagnostics && diagnosticsOpen,
		refetchInterval:
			diagnosticsOpen && session.data?.status
				? isActiveFeederStatus(session.data.status) || session.data.stoppable
					? 3_000
					: false
				: false,
	});

	const stop = useMutation({
		mutationFn: () =>
			apiFetch(`/api/feeder-sessions/${id}/actions`, {
				method: "POST",
				body: JSON.stringify({ action: "stop" }),
			}),
		onSuccess: () => {
			setConfirming(false);
			queryClient.invalidateQueries({ queryKey: ["feeder-session", id] });
			queryClient.invalidateQueries({
				queryKey: ["feeder-session-diagnostics", id],
			});
		},
		onError: () => setConfirming(false),
	});

	const remove = useMutation({
		mutationFn: () =>
			apiFetch(`/api/feeder-sessions/${id}`, { method: "DELETE" }),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["feeder-sessions"] });
			router.push("/live/feeders");
		},
	});

	if (session.isLoading) {
		return (
			<div
				role="status"
				aria-label={t("feeder.loadingSession")}
				className="space-y-2"
			>
				{[0, 1, 2].map((i) => (
					<div key={i} className="h-16 animate-pulse rounded-md bg-zinc-900" />
				))}
			</div>
		);
	}
	if (session.isError || !session.data) {
		return (
			<div className="space-y-2">
				<p role="alert" className="text-red-400 text-sm">
					{t("feeder.detailLoadFailed")}
				</p>
				<Button
					variant="secondary"
					size="sm"
					disabled={session.isFetching}
					onClick={() => session.refetch()}
				>
					{t("common.retry")}
				</Button>
			</div>
		);
	}

	const row = session.data;
	const diagnosticRows =
		diagnostics.data?.recentLoopBoundaries
			.map(parseLoopBoundary)
			.filter(
				(boundary): boundary is NonNullable<typeof boundary> =>
					boundary !== null,
			) ?? [];
	const diagnosticLog = Array.isArray(diagnostics.data?.logTail)
		? diagnostics.data.logTail.filter(
				(line): line is string => typeof line === "string",
			)
		: [];

	return (
		<section>
			<header className="flex flex-wrap items-center gap-3">
				<div className="flex items-center gap-2">
					<h1 className="font-semibold text-xl text-zinc-50">
						{t("feeder.sessionDetailTitle")} {row.id.slice(0, 8)}…
					</h1>
					<HelpOverlay labelFor={t("feeder.sessionDetailTitle")}>
						{t("feeder.detailLead")}
					</HelpOverlay>
				</div>
				<Badge tone={FEEDER_STATUS_TONE[row.status]}>{row.status}</Badge>
				<RoleAccess control="live.feeder.detail">
					{row.stoppable ? (
						<Button
							variant="destructive"
							size="sm"
							disabled={stop.isPending}
							onClick={() => setConfirming(true)}
						>
							{t("feeder.stop")}
						</Button>
					) : null}
					<DeleteResourceButton
						resourceLabel={t("feeder.sessionWord")}
						disabled={row.stoppable}
						disabledReason={t("feeder.stopBeforeDeleting")}
						confirmTitle={t("feeder.deleteTitle")}
						confirmDescription={t("feeder.deleteConfirm")}
						pending={remove.isPending}
						error={
							remove.isError
								? localizedCustomerError(t, remove.error, "live.deleteFailed")
								: null
						}
						onConfirm={() => remove.mutate()}
					/>
				</RoleAccess>
			</header>

			{row.internalFailure || row.error ? (
				/* Preserve 's attribute-by-attribute newlines while allowing long customer-facing text to wrap. */
				<p
					role="alert"
					className="mt-3 whitespace-pre-line text-red-400 text-sm"
				>
					{row.internalFailure
						? t("feeder.internalFailure")
						: customerFeederErrorMessage(t, row.error as string)}
				</p>
			) : null}
			{stop.isError ? (
				<p role="alert" className="mt-2 text-red-400 text-sm">
					{feederFailureMessage(t, t("ui.stop"), stop.error)}
				</p>
			) : null}

			<dl className="mt-4 grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
				<div className="rounded-md border border-zinc-800 px-3 py-2">
					<dt className="text-xs text-zinc-500">{t("feeder.source")}</dt>
					<dd className="truncate font-mono text-xs text-zinc-300">
						{row.sourceBucket}/{row.sourceKey}
					</dd>
				</div>
				<div className="rounded-md border border-zinc-800 px-3 py-2">
					<dt className="text-xs text-zinc-500">
						{t("feeder.inputDestination")}
					</dt>
					<dd className="truncate font-mono text-xs text-zinc-300">
						{inputDestination(row.target)}
					</dd>
				</div>
				<div className="rounded-md border border-zinc-800 px-3 py-2">
					<dt className="text-xs text-zinc-500">{t("feeder.channel")}</dt>
					<dd>
						<Link
							href={`/live/${row.liveChannelId}`}
							className="font-mono text-xs text-zinc-300 hover:text-emerald-400"
						>
							{row.liveChannelId}
						</Link>
					</dd>
				</div>
				<div className="rounded-md border border-zinc-800 px-3 py-2">
					<dt className="text-xs text-zinc-500">{t("feeder.timing")}</dt>
					<dd className="text-xs text-zinc-300">
						{t("uiX.startedStopped", {
							started: formatDateTime(row.startedAt ?? undefined),
							stopped: formatDateTime(row.stoppedAt ?? undefined),
						})}
					</dd>
				</div>
			</dl>

			<details className="mt-5 rounded-md border border-zinc-800 px-3 py-2">
				<summary className="cursor-pointer text-sm text-zinc-300">
					{t("feeder.technicalInformation")}
				</summary>
				<dl className="mt-3 grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
					<div>
						<dt className="text-zinc-500">{t("common.status")}</dt>
						<dd className="text-zinc-300">{row.status}</dd>
					</div>
					<div>
						<dt className="text-zinc-500">{t("feeder.protocol")}</dt>
						<dd className="text-zinc-300">{row.protocol}</dd>
					</div>
					<div>
						<dt className="text-zinc-500">{t("feeder.resourceId")}</dt>
						<dd className="font-mono text-zinc-300">{row.id}</dd>
					</div>
					<div>
						<dt className="text-zinc-500">{t("feeder.channelResourceId")}</dt>
						<dd className="font-mono text-zinc-300">{row.liveChannelId}</dd>
					</div>
				</dl>
			</details>

			{canViewDiagnostics ? (
				<section className="mt-6 rounded-md border border-zinc-800 p-3">
					<Button
						variant="secondary"
						size="sm"
						aria-expanded={diagnosticsOpen}
						onClick={() => setDiagnosticsOpen((open) => !open)}
					>
						{t("feeder.diagnostics")}
					</Button>
					{diagnosticsOpen ? (
						<DiagnosticsBody
							technicalDetailsAllowed={canViewDiagnostics}
							diagnostics={diagnostics}
							boundaries={diagnosticRows}
							logLines={diagnosticLog}
						/>
					) : null}
				</section>
			) : null}

			<RoleAccess control="live.feeder.detail">
				<StopFeederSessionDialog
					open={confirming}
					stopping={stop.isPending}
					onCancel={() => setConfirming(false)}
					onConfirm={() => stop.mutate()}
				/>
			</RoleAccess>
		</section>
	);
}

function DiagnosticsBody({
	technicalDetailsAllowed,
	diagnostics,
	boundaries,
	logLines,
}: {
	technicalDetailsAllowed: boolean;
	diagnostics: UseQueryResult<FeederSessionDiagnostics>;
	boundaries: NonNullable<ReturnType<typeof parseLoopBoundary>>[];
	logLines: string[];
}) {
	const { t } = useT();
	if (diagnostics.isLoading) {
		return (
			<p role="status" className="mt-3 text-sm text-zinc-400">
				{t("feeder.diagnosticsLoading")}
			</p>
		);
	}
	if (diagnostics.isError) {
		return (
			<p role="alert" className="mt-3 text-red-400 text-sm">
				{t("feeder.diagnosticsLoadFailed")}
			</p>
		);
	}
	if (!diagnostics.data) {
		return null;
	}
	const data = diagnostics.data;
	return technicalDetailsAllowed ? (
		<div className="mt-3">
			<p className="text-xs text-zinc-500">{t("feeder.diagnosticsLead")}</p>
			<dl className="mt-3 grid grid-cols-1 gap-2 text-xs sm:grid-cols-3">
				<div>
					<dt className="text-zinc-500">{t("feeder.processId")}</dt>
					<dd className="font-mono text-zinc-300">
						{data.pid === null
							? t("feeder.notAvailable")
							: t("uiX.pidValue", { pid: data.pid })}
					</dd>
				</div>
				<div>
					<dt className="text-zinc-500">{t("feeder.ownerHost")}</dt>
					<dd className="font-mono text-zinc-300">
						{data.ownerHost ?? t("feeder.notAvailable")}
					</dd>
				</div>
				<div>
					<dt className="text-zinc-500">{t("feeder.processGoneAt")}</dt>
					<dd className="text-zinc-300">
						{data.processGoneAt
							? formatDateTime(data.processGoneAt)
							: t("feeder.notAvailable")}
					</dd>
				</div>
			</dl>
			{data.error ? (
				<>
					<h2 className="mt-5 font-medium text-sm text-zinc-200">
						{t("feeder.recordedFailure")}
					</h2>
					<pre className="mt-2 overflow-auto whitespace-pre-wrap rounded-md bg-zinc-900 p-3 text-[11px] text-zinc-400">
						{data.error}
					</pre>
				</>
			) : null}
			<h2 className="mt-5 font-medium text-sm text-zinc-200">
				{t("uiX.loopBoundaries")} ({boundaries.length}/{data.loopBoundaryCount})
			</h2>
			{boundaries.length > 0 ? (
				<div className="mt-2 overflow-x-auto rounded-md border border-zinc-800">
					<table className="w-full text-xs">
						<thead>
							<tr className="border-zinc-800 border-b text-left text-zinc-500">
								<th className="px-3 py-1.5">{t("feeder.loop")}</th>
								<th className="px-3 py-1.5">{t("feeder.wallClock")}</th>
								<th className="px-3 py-1.5">{t("feeder.streamTime")}</th>
							</tr>
						</thead>
						<tbody className="divide-y divide-zinc-800/70">
							{boundaries.map((boundary) => (
								<tr key={boundary.loopIndex}>
									<td className="px-3 py-1.5">#{boundary.loopIndex}</td>
									<td className="px-3 py-1.5">
										{formatDateTime(boundary.wallClock)}
									</td>
									<td className="px-3 py-1.5">{boundary.streamTimeSec}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			) : null}
			<h2 className="mt-5 font-medium text-sm text-zinc-200">
				{t("uiX.logTail")}
			</h2>
			{logLines.length > 0 ? (
				<pre className="mt-2 max-h-96 overflow-auto rounded-md bg-zinc-900 p-3 text-[11px] text-zinc-400">
					{logLines.join("\n")}
				</pre>
			) : (
				<p className="mt-2 text-sm text-zinc-500">{t("feeder.noLogLines")}</p>
			)}
		</div>
	) : null;
}
