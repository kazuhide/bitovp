"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { InfoHint } from "@/components/ui/info-hint";
import { apiFetch } from "@/lib/api";
import { useMutationAccess } from "@/lib/auth/use-role-access";
import { formatDateTime } from "@/lib/format";
import { useT } from "@/lib/i18n/context";
import type {
	LiveDiagnosticsKind,
	LiveDiagnosticsResponse,
} from "@/lib/live-diagnostics/types";

const DIAGNOSTICS_API = "/api/live-channels/[id]/runs/[runId]/diagnostics";
const FINAL_HEARTBEAT_API =
	"/api/live-channels/[id]/runs/[runId]/final-heartbeat";
const SELECT =
	"h-8 max-w-full rounded border border-zinc-700 bg-zinc-950 px-2 text-xs text-zinc-200";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KINDS = ["summary", "events", "streams", "srt", "hd-start"] as const;
type Props = {
	channelId: string;
	runId: string;
	status?: string;
	open: boolean;
};

export function ProviderDiagnosticsPanel(props: Props) {
	const { t } = useT();
	const canRead = useMutationAccess("live.channel.heartbeat-log");
	const [expanded, setExpanded] = useState(false);
	if (!canRead) return null;
	return (
		<details
			className="border-t border-zinc-800 pt-2"
			onToggle={(event) => setExpanded(event.currentTarget.open)}
		>
			<summary className="cursor-pointer text-xs text-zinc-300">
				{t("providerDiagnostics.title")}
			</summary>
			{expanded && props.open ? (
				<RunDiagnostics key={`${props.channelId}:${props.runId}`} {...props} />
			) : null}
		</details>
	);
}

function RunDiagnostics({ channelId, runId, status }: Props) {
	const { t } = useT();
	const canExport = useMutationAccess("live.channel.heartbeat-export");
	const [kind, setKind] = useState<LiveDiagnosticsKind>("summary");
	const [offset, setOffset] = useState(0);
	const [inputId, setInputId] = useState("");
	const [draftId, setDraftId] = useState("");
	const [invalidId, setInvalidId] = useState(false);
	const [knownIds, setKnownIds] = useState<string[]>([]);
	const path = (template: string) =>
		template.replace("[id]", channelId).replace("[runId]", runId);
	const query = useQuery({
		queryKey: [
			"live-provider-diagnostics",
			channelId,
			runId,
			kind,
			inputId,
			offset,
		],
		queryFn: async ({ signal }) => {
			const params = new URLSearchParams({
				kind,
				offset: String(offset),
				limit: "25",
			});
			if (kind === "srt" && inputId) params.set("srtInputId", inputId);
			const result = await apiFetch<LiveDiagnosticsResponse>(
				`${path(DIAGNOSTICS_API)}?${params}`,
				{ signal },
			);
			if (result.kind === "srt" && Array.isArray(result.data)) {
				const ids = result.data.flatMap((row) =>
					row.srtInputId && UUID.test(row.srtInputId) ? [row.srtInputId] : [],
				);
				if (!signal.aborted)
					setKnownIds((previous) => [...new Set([...previous, ...ids])]);
			}
			return result;
		},
		retry: false,
		staleTime: Infinity,
		gcTime: 0,
		refetchOnWindowFocus: false,
		refetchOnReconnect: false,
	});
	const terminal = status === "STOPPED" || status === "ERROR";
	function filter(value: string) {
		setDraftId(value);
		if (value && !UUID.test(value)) {
			setInvalidId(true);
			return;
		}
		setInvalidId(false);
		setInputId(value);
		setOffset(0);
	}
	return (
		<div className="mt-2 space-y-2 text-xs">
			<div className="flex flex-wrap items-end gap-2">
				<label className="flex flex-col gap-1 text-zinc-400">
					{t("providerDiagnostics.view")}
					<select
						className={SELECT}
						value={kind}
						onChange={(event) => {
							setKind(event.target.value as LiveDiagnosticsKind);
							setOffset(0);
							setInputId("");
							setDraftId("");
							setInvalidId(false);
						}}
					>
						{KINDS.map((value) => (
							<option key={value} value={value}>
								{t(`providerDiagnostics.${value}`)}
							</option>
						))}
					</select>
				</label>
				{kind === "hd-start" ? (
					<InfoHint text={t("providerDiagnostics.hdStartHint")} />
				) : null}
				<Button
					size="sm"
					variant="secondary"
					disabled={query.isFetching}
					onClick={() => void query.refetch()}
				>
					{t("providerDiagnostics.refresh")}
				</Button>
				{query.data ? (
					<span className="text-zinc-500">
						{t("providerDiagnostics.fetched", {
							time: formatDateTime(query.data.fetchedAt),
						})}
					</span>
				) : null}
			</div>
			{kind === "srt" ? (
				<div className="flex flex-wrap items-end gap-2">
					<label className="flex min-w-0 flex-col gap-1 text-zinc-400">
						{t("providerDiagnostics.srtInput")}
						<select
							className={SELECT}
							value={inputId}
							onChange={(event) => filter(event.target.value)}
						>
							<option value="">{t("providerDiagnostics.allInputs")}</option>
							{[...new Set([...knownIds, ...(inputId ? [inputId] : [])])].map(
								(id) => (
									<option key={id} value={id}>
										{id}
									</option>
								),
							)}
						</select>
					</label>
					<form
						className="flex flex-wrap items-end gap-2"
						onSubmit={(event) => {
							event.preventDefault();
							filter(draftId.trim());
						}}
					>
						<label className="flex flex-col gap-1 text-zinc-400">
							{t("providerDiagnostics.inputId")}
							<input
								className={SELECT}
								value={draftId}
								onChange={(event) => setDraftId(event.target.value)}
								aria-invalid={invalidId}
								placeholder="UUID"
							/>
						</label>
						<Button type="submit" size="sm" variant="secondary">
							{t("providerDiagnostics.apply")}
						</Button>
					</form>
					{invalidId ? (
						<p role="alert" className="text-amber-300">
							{t("providerDiagnostics.invalidId")}
						</p>
					) : null}
				</div>
			) : null}
			{query.isError ? (
				<p role="alert" className="text-amber-300">
					{t("providerDiagnostics.unavailable")}
				</p>
			) : null}
			{query.isPending ? (
				<p role="status" className="text-zinc-500">
					{t("heartbeatLog.loading")}
				</p>
			) : null}
			{query.data ? <DiagnosticResults result={query.data} /> : null}
			{query.data && "offset" in query.data ? (
				<div className="flex items-center gap-2 text-zinc-400">
					<Button
						size="sm"
						variant="secondary"
						disabled={offset === 0 || query.isFetching}
						onClick={() => setOffset(Math.max(0, offset - 25))}
					>
						{t("providerDiagnostics.previous")}
					</Button>
					<span>
						{t("providerDiagnostics.page", {
							page: Math.floor(offset / 25) + 1,
						})}
						{query.data.totalCount !== undefined
							? ` · ${t("providerDiagnostics.total", { count: query.data.totalCount })}`
							: ""}
					</span>
					<Button
						size="sm"
						variant="secondary"
						disabled={
							query.data.nextOffset === undefined ||
							query.data.nextOffset === null ||
							query.isFetching
						}
						onClick={() =>
							setOffset(
								query.data && "offset" in query.data
									? (query.data.nextOffset ?? offset)
									: offset,
							)
						}
					>
						{t("providerDiagnostics.next")}
					</Button>
				</div>
			) : null}
			{canExport && terminal ? (
				<FinalHeartbeatDownload key={status} path={path(FINAL_HEARTBEAT_API)} />
			) : null}
		</div>
	);
}

function FinalHeartbeatDownload({ path }: { path: string }) {
	const { t } = useT();
	const final = useMutation({
		mutationFn: () => apiFetch<{ data: { url: string } }>(path),
		gcTime: 0,
	});
	const finalUrl = final.data?.data.url?.startsWith("https://")
		? final.data.data.url
		: null;
	return (
		<div className="flex flex-wrap items-center gap-2 border-t border-zinc-800 pt-2">
			<Button
				size="sm"
				variant="secondary"
				disabled={final.isPending}
				onClick={() => final.mutate()}
			>
				{t("providerDiagnostics.getFinal")}
			</Button>
			{finalUrl ? (
				<a
					href={finalUrl}
					target="_blank"
					rel="noopener noreferrer"
					className="text-sky-400 underline"
				>
					{t("providerDiagnostics.downloadFinal")}
				</a>
			) : null}
			{final.isError ? (
				<span role="alert" className="text-amber-300">
					{t("providerDiagnostics.unavailable")}
				</span>
			) : null}
		</div>
	);
}

function DiagnosticResults({ result }: { result: LiveDiagnosticsResponse }) {
	const { t } = useT();
	const [rawOpen, setRawOpen] = useState(false);
	const rows = Array.isArray(result.data) ? result.data : [];
	return (
		<>
			<div className="max-h-72 space-y-2 overflow-auto rounded border border-zinc-800 p-2 text-zinc-300">
				{result.kind === "summary" ? (
					<p>
						{t("providerDiagnostics.status")}: {result.data.status ?? "—"}
					</p>
				) : null}
				{result.kind === "hd-start" ? (
					<p>
						{result.data.manifestGenerator ?? "—"} ·{" "}
						{result.data.liveEncodingMode ?? "—"} · HLS{" "}
						{result.data.hlsManifests?.length ?? "—"} · DASH{" "}
						{result.data.dashManifests?.length ?? "—"}
					</p>
				) : null}
				{result.kind !== "summary" &&
				result.kind !== "hd-start" &&
				rows.length === 0 ? (
					<p className="text-zinc-500">{t("providerDiagnostics.empty")}</p>
				) : null}
				{result.kind === "events"
					? result.data.map((event, index) => (
							<div
								key={`${event.time}:${index}`}
								className="flex flex-wrap gap-x-2 border-zinc-800 border-b pb-1 last:border-0"
							>
								<span className="text-zinc-500">
									{event.time ? formatDateTime(event.time) : "—"}
								</span>
								<span>{event.details?.eventType ?? "—"}</span>
								<span className="break-words">{event.details?.source}</span>
							</div>
						))
					: null}
				{result.kind === "streams"
					? result.data.map((entry, index) => (
							<div key={`${entry.time}:${index}`}>
								<p className="text-zinc-500">
									{entry.time ? formatDateTime(entry.time) : "—"}
								</p>
								{entry.streamInfos?.map((stream, streamIndex) => (
									<p
										key={`${stream.id}:${streamIndex}`}
										className="break-words"
									>
										{stream.mediaType ?? "—"} · {stream.codec ?? "—"} ·{" "}
										{stream.id ?? "—"}
										{stream.width && stream.height
											? ` · ${stream.width} × ${stream.height}`
											: ""}
										{stream.rate !== undefined
											? ` · ${stream.rate} ${stream.mediaType?.toLowerCase() === "video" ? "fps" : "Hz"}`
											: ""}
										{stream.bytesReadPerSecondAvg !== undefined
											? ` · ${((stream.bytesReadPerSecondAvg * 8) / 1_000_000).toFixed(2)} Mbps`
											: ""}
									</p>
								))}
							</div>
						))
					: null}
				{result.kind === "srt"
					? result.data.map((entry, index) => (
							<div
								key={`${entry.id}:${index}`}
								className="space-y-1 border-zinc-800 border-b pb-1 last:border-0"
							>
								<p className="break-all text-zinc-400">
									{entry.srtInputId ?? "—"}
									{entry.createdAt
										? ` · ${formatDateTime(entry.createdAt)}`
										: ""}
								</p>
								<div className="flex flex-wrap gap-x-4 gap-y-1">
									<span>
										{t("providerDiagnostics.received")}:{" "}
										{entry.recv?.mbitRate === undefined
											? "—"
											: `${entry.recv.mbitRate.toFixed(2)} Mbps`}
									</span>
									<span>
										{t("providerDiagnostics.lost")}:{" "}
										{entry.recv?.packetsLost ?? "—"}
									</span>
									<span>
										{t("providerDiagnostics.dropped")}:{" "}
										{entry.recv?.packetsDropped ?? "—"}
									</span>
									<span>
										{t("providerDiagnostics.retransmitted")}:{" "}
										{entry.recv?.packetsRetransmitted ?? "—"}
									</span>
								</div>
							</div>
						))
					: null}
			</div>
			<details
				key={`${result.kind}:${"offset" in result ? result.offset : 0}`}
				onToggle={(event) => setRawOpen(event.currentTarget.open)}
			>
				<summary className="cursor-pointer text-zinc-500">
					{t("providerDiagnostics.details")}
				</summary>
				{rawOpen ? (
					<pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap break-all text-zinc-400">
						{JSON.stringify(result.data, null, 2)}
					</pre>
				) : null}
			</details>
		</>
	);
}
