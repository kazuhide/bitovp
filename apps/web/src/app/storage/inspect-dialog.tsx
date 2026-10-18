"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { ApiError, apiFetch } from "@/lib/api";
import { baseName, formatBytes, formatDateTime } from "@/lib/format";
import type { MessageKey } from "@/lib/i18n";
import { useT } from "@/lib/i18n/context";
import {
	INSPECTION_TONE,
	isInspectionRunning,
	type ProbeStreamRow,
	type StorageInspectionDto,
	summarizeProbe,
} from "./inspect-shared";

export type InspectTarget = {
	credentialId: string;
	bucket: string;
	objectKey: string;
	/** Listing-reported size  — rides the POST so the worker can
	    aim the TRUE tail; not part of the row's identity. */
	objectSize?: number;
};

const POLL_MS = 2000;

const targetId = (target: InspectTarget) =>
	`${target.credentialId}|${target.bucket}|${target.objectKey}`;

/**
 * THE query key for "the most recent inspection of this object" — exported so
 * every reader of that fact (this dialog, the job-detail chips) shares one
 * cache entry. A second key over the identical URL is how the chips went
 * stale: nothing ever invalidated the copy (review of the #153-155 stack, I2).
 */
export const latestInspectionKey = (target: InspectTarget) =>
	["storage-inspection-latest", targetId(target)] as const;

/**
 * "Inspect" — ffprobe of one storage object, shown as a readable summary.
 *
 * The body is KEYED by the target and only mounted while open, so switching
 * objects (or re-opening) starts from clean state with no reset plumbing.
 */
export function InspectDialog({
	target,
	onClose,
}: {
	target: InspectTarget | null;
	onClose: () => void;
}) {
	const { t } = useT();
	return (
		<Dialog
			open={target !== null}
			onOpenChange={(next) => {
				if (!next) {
					onClose();
				}
			}}
			title={
				target
					? `${t("storage.inspect")} ${baseName(target.objectKey)}`
					: t("storage.inspect")
			}
			description={
				target
					? t("uiX.ffprobeBoundedTitle", {
							bucket: target.bucket,
							key: target.objectKey,
						})
					: undefined
			}
			wide
		>
			{target ? <InspectBody key={targetId(target)} target={target} /> : null}
		</Dialog>
	);
}

/**
 * Flow: ask for the most recent inspection of this object first and adopt it if
 * there is one (re-opening the dialog must not pay for another read); otherwise
 * POST a new one. Then poll the row while PENDING|RUNNING, stopping on terminal.
 *
 * The probe is BOUNDED — the worker reads a capped head plus, at most, one
 * capped retry slice — so "no streams found" is an expected outcome for a
 * non-faststart MP4, not a defect. The ERROR path prints the worker's message
 * verbatim (it is written to be operator-readable) plus that explanation.
 */
type InspectionHistoryEntry = {
	id: string;
	status: StorageInspectionDto["status"];
	createdAt: string;
	bytesRead: number | null;
};

function InspectBody({ target }: { target: InspectTarget }) {
	const { t } = useT();
	const queryClient = useQueryClient();
	const [activeId, setActiveId] = useState<string | null>(null);
	// One POST per mounted target, ever: the effect below may re-run on any
	// render and a double-fire would mean a second bounded read.
	const requested = useRef(false);

	const latest = useQuery({
		queryKey: latestInspectionKey(target),
		queryFn: () => {
			// Identity fields only — objectSize is advisory POST payload, and the
			// GET's strict query schema would reject it.
			const params = new URLSearchParams({
				credentialId: target.credentialId,
				bucket: target.bucket,
				objectKey: target.objectKey,
				// : the dialog shows prior inspections too.
				history: "1",
			});
			return apiFetch<{
				latest: StorageInspectionDto | null;
				history?: InspectionHistoryEntry[];
			}>(`/api/storage-inspections?${params}`);
		},
		retry: false,
		// Always re-ask on open: a prior probe may have finished since last time.
		gcTime: 0,
		staleTime: 0,
	});

	const create = useMutation({
		mutationFn: () =>
			apiFetch<StorageInspectionDto>("/api/storage-inspections", {
				method: "POST",
				body: JSON.stringify(target),
			}),
		onSuccess: (row) => setActiveId(row.id),
	});
	const startInspection = create.mutate;

	const priorId = latest.data?.latest?.id ?? null;
	const latestSettled = latest.isSuccess;
	useEffect(() => {
		if (!latestSettled || requested.current) {
			return;
		}
		requested.current = true;
		if (priorId !== null) {
			setActiveId(priorId);
			return;
		}
		startInspection();
	}, [latestSettled, priorId, startInspection]);

	const detail = useQuery({
		queryKey: ["storage-inspection", activeId],
		queryFn: () =>
			apiFetch<StorageInspectionDto>(`/api/storage-inspections/${activeId}`),
		enabled: activeId !== null,
		retry: false,
		refetchInterval: (query) => {
			const status = query.state.data?.status;
			return status && isInspectionRunning(status) ? POLL_MS : false;
		},
	});

	// When a poll lands on a terminal row, every OTHER observer of "the latest
	// inspection of this object" — the job-detail chips — must refetch, or the
	// card keeps looking uninspected until a full page load while the operator
	// is reading the finished report right next to it (stack review, I2).
	const detailStatus = detail.data?.status;
	useEffect(() => {
		if (detailStatus !== undefined && !isInspectionRunning(detailStatus)) {
			void queryClient.invalidateQueries({
				queryKey: latestInspectionKey(target),
			});
		}
	}, [detailStatus, queryClient, target]);

	// Newest known state wins; the POST response (or the adopted prior row) fills
	// the gap before the first poll returns, so the body never flashes empty.
	const row: StorageInspectionDto | null =
		detail.data ?? create.data ?? latest.data?.latest ?? null;
	const failure = latest.error ?? create.error ?? detail.error ?? null;

	return (
		<div className="space-y-4">
			{failure ? (
				<p
					role="alert"
					className="rounded-md border border-red-900 bg-red-950/30 px-3 py-2 text-red-300 text-sm"
				>
					{failure instanceof ApiError
						? failure.message
						: t("inspect.requestFailed")}
				</p>
			) : null}

			{row === null && failure === null ? (
				<p role="status" className="text-sm text-zinc-500">
					{t("inspect.requesting")}
				</p>
			) : null}

			{row ? (
				<>
					<div className="flex flex-wrap items-center gap-3">
						<Badge tone={INSPECTION_TONE[row.status]}>{row.status}</Badge>
						{row.bytesRead !== null ? (
							<span className="text-xs text-zinc-400">
								{t("uiX.readBytes", { bytes: formatBytes(row.bytesRead) })}
							</span>
						) : null}
						<span className="text-xs text-zinc-500">
							{formatDateTime(row.createdAt)}
						</span>
						{isInspectionRunning(row.status) ? null : (
							<Button
								variant="secondary"
								size="sm"
								className="ml-auto"
								disabled={create.isPending}
								onClick={() => {
									setActiveId(null);
									startInspection();
								}}
							>
								{create.isPending
									? t("inspect.inspecting")
									: t("inspect.reinspect")}
							</Button>
						)}
					</div>

					{isInspectionRunning(row.status) ? (
						<p role="status" className="text-sm text-zinc-400">
							{t("inspect.probing")}
						</p>
					) : null}

					{row.status === "ERROR" ? (
						<div
							role="alert"
							className="space-y-2 rounded-md border border-red-900 bg-red-950/30 px-3 py-2 text-sm"
						>
							{/* Verbatim: the worker writes this for an operator to read. */}
							<p className="break-words text-red-300">
								{row.error ?? t("inspect.failed")}
							</p>
							<p className="text-red-200/70 text-xs">
								{t("prose.inspectBounded")}{" "}
								<code className="font-mono">-movflags +faststart</code>
								{t("uiX.inspectBoundedTailRest")}
							</p>
						</div>
					) : null}

					{row.status === "FINISHED" ? <ProbeReport probe={row.probe} /> : null}

					{/* : the object's PRIOR inspections — the rows were
					    always kept (and #27's prune bounds them); only the view
					    was latest-only. Click loads that row above. */}
					{(latest.data?.history?.length ?? 0) > 1 ? (
						<details className="rounded-md border border-zinc-800 px-3 py-2">
							<summary className="cursor-pointer text-xs text-zinc-400">
								{t("inspect.historyTitle", {
									count: latest.data?.history?.length ?? 0,
								})}
							</summary>
							<ul className="mt-2 space-y-1">
								{(latest.data?.history ?? []).map((entry) => (
									<li key={entry.id}>
										<button
											type="button"
											onClick={() => setActiveId(entry.id)}
											className={`flex w-full items-center gap-3 rounded px-2 py-1 text-left text-xs hover:bg-zinc-900 ${
												entry.id === row.id
													? "bg-zinc-900 text-zinc-200"
													: "text-zinc-400"
											}`}
										>
											<Badge tone={INSPECTION_TONE[entry.status]}>
												{entry.status}
											</Badge>
											<span className="font-mono">
												{formatDateTime(entry.createdAt)}
											</span>
											{entry.bytesRead !== null ? (
												<span className="text-zinc-500">
													{t("uiX.readBytes", {
														bytes: formatBytes(entry.bytesRead),
													})}
												</span>
											) : null}
										</button>
									</li>
								))}
							</ul>
						</details>
					) : null}
				</>
			) : null}
		</div>
	);
}

/**
 * Column headers as catalogue KEYS, not copy — the same shape `nav-items.ts` uses,
 * and for the same reason: this array is module scope, so `useT` cannot be called
 * here. `#`, `Type` and `FPS` carry `null` and stay verbatim: the first is a symbol,
 * and the other two are the identifiers ffprobe itself prints.
 */
const COLUMNS: {
	labelKey: MessageKey | null;
	label?: string;
	cell: (row: ProbeStreamRow) => string;
}[] = [
	{
		labelKey: null,
		label: "#",
		cell: (s) => (s.index === null ? "—" : String(s.index)),
	},
	{ labelKey: "ui.type", cell: (s) => s.codecType ?? "—" },
	{ labelKey: "inspect.codec", cell: (s) => s.codecName ?? "—" },
	{ labelKey: "inspect.profile", cell: (s) => s.profile ?? "—" },
	{ labelKey: "inspect.resolution", cell: (s) => s.resolution ?? "—" },
	{ labelKey: null, label: "FPS", cell: (s) => s.frameRate ?? "—" },
	{ labelKey: "inspect.bitrate", cell: (s) => s.bitRate ?? "—" },
	{ labelKey: "inspect.channels", cell: (s) => s.channels ?? "—" },
	{ labelKey: "inspect.sampleRate", cell: (s) => s.sampleRate ?? "—" },
	{ labelKey: "inspect.language", cell: (s) => s.language ?? "—" },
];

function ProbeReport({ probe }: { probe: unknown }) {
	const { t } = useT();
	const summary = summarizeProbe(probe);
	return (
		<div className="space-y-3">
			{summary ? (
				<>
					<dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
						<div>
							<dt className="text-xs text-zinc-500">
								{t("inspect.container")}
							</dt>
							<dd className="text-zinc-200">{summary.formatName ?? "—"}</dd>
						</div>
						<div>
							<dt className="text-xs text-zinc-500">{t("common.duration")}</dt>
							<dd className="text-zinc-200">{summary.duration ?? "—"}</dd>
						</div>
						<div>
							<dt className="text-xs text-zinc-500">{t("inspect.bitrate")}</dt>
							<dd className="text-zinc-200">{summary.bitRate ?? "—"}</dd>
						</div>
						<div>
							<dt className="text-xs text-zinc-500">{t("inspect.streams")}</dt>
							<dd className="text-zinc-200">{summary.streams.length}</dd>
						</div>
					</dl>
					<div className="overflow-x-auto rounded-md border border-zinc-800">
						<table className="w-full min-w-[46rem] text-sm">
							<caption className="sr-only">
								{t("uiX.ffprobeStreamsCaption")}
							</caption>
							<thead>
								<tr className="border-zinc-800 border-b text-left text-xs text-zinc-500">
									{COLUMNS.map((column) => (
										<th
											key={column.label ?? column.labelKey}
											className="px-3 py-2 font-medium"
										>
											{column.labelKey ? t(column.labelKey) : column.label}
										</th>
									))}
								</tr>
							</thead>
							<tbody className="divide-y divide-zinc-800/70">
								{summary.streams.map((stream) => (
									<tr key={stream.key}>
										{COLUMNS.map((column) => (
											<td
												key={column.label ?? column.labelKey}
												className="whitespace-nowrap px-3 py-1.5 text-zinc-300"
											>
												{column.cell(stream)}
											</td>
										))}
									</tr>
								))}
							</tbody>
						</table>
					</div>
				</>
			) : (
				<p className="text-sm text-zinc-500">{t("uiX.ffprobeNoData")}</p>
			)}
			<details className="rounded-md border border-zinc-800 bg-zinc-900/40">
				<summary className="cursor-pointer px-3 py-2 text-xs text-zinc-300">
					{t("inspect.rawJson")}
				</summary>
				<pre className="max-h-80 overflow-auto px-3 pb-3 font-mono text-[11px] text-zinc-400">
					{JSON.stringify(probe, null, 2)}
				</pre>
			</details>
		</div>
	);
}
