"use client";

import { focusManager, useQueryClient } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useDocumentOrganization } from "@/components/providers";
import { InfoHint } from "@/components/ui/info-hint";
import { useT } from "@/lib/i18n/context";
import { moqArchiveClientOrigin } from "@/lib/moq-player/client-playback-time";
import type { MoqHeartbeatHistory } from "@/lib/moq-player/heartbeat";
import { moqObservationPath } from "@/lib/moq-player/history-client";
import type { MoqObservationSession } from "@/lib/moq-player/observations";
import { bindPassiveRequestUrl } from "@/lib/passive-request";
import { MoqAnalyticsHistory } from "./moq-analytics-history";
import { MoqClientPlaybackClock } from "./moq-client-playback-clock";
import { MoqEncoderHistory } from "./moq-encoder-history";
import { MoqPlaybackStages } from "./moq-playback-stages";
import { MoqViewerMetrics } from "./moq-viewer-metrics";
import {
	moqObservationHistoryKey,
	useMoqObservationHistory,
} from "./use-moq-observation-history";

const fullUtc = (value: string) =>
	`${value.slice(0, 10)} ${value.slice(11, 19)}`;

export type MoqArchiveSave = { sessionId: string; startedAt: string } & (
	| { state: "saving" }
	| { state: "unconfirmed"; confirmUntilMs: number }
);

export function MoqHistoryPanel({
	channelId,
	runId,
	active,
	hideEncoder = false,
	archiveSaves = [],
}: {
	channelId: string;
	runId: string;
	active: boolean;
	hideEncoder?: boolean;
	archiveSaves?: readonly MoqArchiveSave[];
}) {
	const { t } = useT();
	const organizationId = useDocumentOrganization();
	const queryClient = useQueryClient();
	const [selected, select] = useState("");
	const history = useMoqObservationHistory(
		channelId,
		runId,
		active ? "live" : "archive",
		!active || !hideEncoder,
	);
	const pending =
		history.isPending || (!active && !history.isFetchedAfterMount);
	const data = !pending && !history.isError ? history.data : undefined;
	const sessions = [...(data?.sessions ?? [])].sort(
		(a, b) =>
			Date.parse(b.startedAt) - Date.parse(a.startedAt) ||
			a.id.localeCompare(b.id),
	);
	const session =
		sessions.find((value) => value.id === selected) ?? sessions[0];
	const unresolvedSaves = archiveSaves.filter(
		(save) =>
			!sessions.some((entry) => entry.id === save.sessionId && entry.archive),
	);
	const reconcileUntil = Math.max(
		0,
		...unresolvedSaves.map((save) =>
			save.state === "unconfirmed" ? save.confirmUntilMs : 0,
		),
	);
	const { refetch } = history;
	useEffect(() => {
		const remaining = reconcileUntil - performance.now();
		if (active || remaining <= 0) return;
		// A read begun before the lost receipt can already be in flight.
		// Join that read and cancel its query signal at the reconciliation cutoff.
		const interval = window.setInterval(() => {
			if (focusManager.isFocused() && performance.now() < reconcileUntil)
				void refetch({ cancelRefetch: false });
		}, 5000);
		const deadline = window.setTimeout(() => {
			window.clearInterval(interval);
			void queryClient.cancelQueries({
				queryKey: moqObservationHistoryKey(channelId, runId),
				exact: true,
			});
		}, remaining);
		return () => {
			window.clearInterval(interval);
			window.clearTimeout(deadline);
		};
	}, [active, channelId, queryClient, reconcileUntil, refetch, runId]);

	const encoder = hideEncoder ? undefined : data?.heartbeat;
	let archiveUrl: string | null = null;
	try {
		if (session?.archive && organizationId)
			archiveUrl = bindPassiveRequestUrl(
				`${moqObservationPath(channelId, runId)}/${session.id}/archive`,
				organizationId,
			);
	} catch {
		/* Never emit a bare native URL without its document binding. */
	}
	const archiveOrigin =
		session && archiveUrl ? moqArchiveClientOrigin(session) : null;
	const historyLabel = t("moqPlayback.savedHistory");
	const configuration = data?.configuration;
	return (
		<section
			data-moq-history={runId}
			className="@container min-w-0 space-y-4 border-t border-zinc-800 pt-4"
		>
			<header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
				<div className="flex min-w-0 items-center gap-2">
					<h3 className="font-medium text-sm text-zinc-200">{historyLabel}</h3>
					{session ? (
						<InfoHint
							labelFor={historyLabel}
							text={`${t("moqPlayback.historyClock")} ${t("moqPlayback.recordedScope")}`}
						/>
					) : null}
				</div>
				{session && sessions.length > 1 ? (
					<label className="flex max-w-full flex-wrap items-center gap-2 text-xs text-zinc-400">
						<span className="sr-only">
							{t("moqPlayback.observationSession")}
						</span>
						<select
							value={session.id}
							onChange={(event) => select(event.target.value)}
							className="h-8 max-w-full truncate rounded-md border border-zinc-700 bg-zinc-950 px-2 text-xs text-zinc-200 tabular-nums"
						>
							{sessions.map((value) => {
								const sameStart = sessions.filter(
									(entry) => entry.startedAt === value.startedAt,
								);
								const time = value.startedAt
									.replace("T", " ")
									.replace(/Z$/, " UTC");
								const suffix =
									sameStart.length > 1
										? ` · ${sameStart.indexOf(value) + 1}`
										: "";
								return (
									<option key={value.id} value={value.id}>
										{time}
										{suffix}
									</option>
								);
							})}
						</select>
					</label>
				) : null}
			</header>
			{unresolvedSaves.map((save) => (
				<p
					key={save.sessionId}
					role="status"
					data-moq-recording={save.state}
					data-moq-recording-session={save.sessionId}
					className="text-xs text-zinc-400"
				>
					{t(`moqPlayback.recording.${save.state}`)} ·{" "}
					<time dateTime={save.startedAt}>{fullUtc(save.startedAt)} UTC</time>
				</p>
			))}
			{pending && history.fetchStatus !== "idle" ? (
				<p className="text-xs text-zinc-500">{t("moqPlayback.loading")}</p>
			) : !data ? (
				<p className="text-xs text-red-300">{t("moqPlayback.historyFailed")}</p>
			) : session ? (
				<MoqHistoryObservation
					key={`${session.id}:${archiveUrl ?? ""}:${session.archive?.sha256 ?? ""}:${session.archive?.durationMs ?? ""}:${archiveOrigin ?? ""}`}
					channelId={channelId}
					runId={runId}
					session={session}
					active={active}
					archiveUnresolved={unresolvedSaves.some(
						(save) => save.sessionId === session.id,
					)}
					archiveUrl={archiveUrl}
					origin={archiveOrigin}
					encoder={encoder}
				/>
			) : (
				<div className="space-y-3">
					<p className="text-xs text-zinc-500">{t("moqPlayback.noHistory")}</p>
					{encoder ? (
						<MoqEncoderHistory active={active} heartbeat={encoder} />
					) : null}
				</div>
			)}
			{configuration ? (
				<details>
					<summary className="cursor-pointer text-xs text-zinc-400">
						{t("moqPlayback.configuration")}
					</summary>
					<dl className="mt-2 flex flex-wrap gap-x-4 gap-y-2 text-xs">
						<div className="min-w-0">
							<dt className="text-zinc-500">{t("moqPlayback.namespace")}</dt>
							<dd className="break-words text-zinc-200">
								{configuration.namespace.join("/")}
							</dd>
						</div>
						<div>
							<dt className="text-zinc-500">{t("moqPlayback.draft")}</dt>
							<dd className="text-zinc-200">{configuration.draftVersion}</dd>
						</div>
						<div>
							<dt className="text-zinc-500">{t("moqPlayback.catalog")}</dt>
							<dd className="text-zinc-200">
								{configuration.catalogTrackName}
							</dd>
						</div>
					</dl>
				</details>
			) : null}
		</section>
	);
}

function MoqHistoryObservation({
	channelId,
	runId,
	session,
	active,
	archiveUnresolved,
	archiveUrl,
	origin,
	encoder,
}: {
	channelId: string;
	runId: string;
	session: MoqObservationSession;
	active: boolean;
	archiveUnresolved: boolean;
	archiveUrl: string | null;
	origin: number | null;
	encoder?: MoqHeartbeatHistory;
}) {
	const { t } = useT();
	const mediaRef = useRef<HTMLVideoElement>(null);
	const [playhead, setPlayhead] = useState<number | null>(null);
	const archive = session.archive;
	const analyticsEncodingId = session.analyticsVideoId?.split(":")[1];
	const hasArchive = archive !== null && archiveUrl !== null;
	const endedAt = session.endedAt;
	return (
		<div className="min-w-0 space-y-3">
			<p className="flex flex-wrap gap-x-1.5 text-xs text-zinc-400 tabular-nums">
				<time dateTime={session.startedAt}>{fullUtc(session.startedAt)}</time>
				{endedAt ? (
					<>
						<span aria-hidden="true">–</span>
						<time dateTime={endedAt}>
							{endedAt.slice(0, 10) === session.startedAt.slice(0, 10)
								? endedAt.slice(11, 19)
								: fullUtc(endedAt)}
						</time>
					</>
				) : null}
				<span>UTC</span>
			</p>
			<div
				data-moq-history-layout
				className={
					hasArchive
						? "grid min-w-0 items-start gap-4 @3xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]"
						: "min-w-0 space-y-3"
				}
			>
				{hasArchive ? (
					<div className="min-w-0 overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950/40">
						<video
							ref={mediaRef}
							data-moq-archive={session.id}
							src={archiveUrl}
							controls
							muted
							playsInline
							preload="metadata"
							aria-label={t("moqPlayback.receivedVideo")}
							className="block aspect-video w-full bg-black object-contain"
						/>
						<div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t border-zinc-800 p-3">
							{origin !== null ? (
								<MoqClientPlaybackClock
									mode="archive"
									mediaRef={mediaRef}
									originUtcMs={origin}
									durationMs={archive.durationMs}
									onTimeChange={setPlayhead}
								/>
							) : null}
							<a
								href={archiveUrl}
								download={`moq-${session.id}.webm`}
								className="inline-flex items-center gap-1.5 rounded text-xs text-zinc-300 hover:text-zinc-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
							>
								<Download className="size-3.5" aria-hidden="true" />
								{t("moqPlayback.downloadRecording")}
							</a>
						</div>
					</div>
				) : archiveUnresolved ? null : (
					<p className="text-xs text-zinc-500">
						{t(archive ? "moqPlayback.unavailable" : "moqPlayback.noRecording")}
					</p>
				)}
				<div
					data-moq-history-metrics={session.id}
					className="min-w-0 space-y-3"
				>
					<MoqViewerMetrics
						samples={session.samples}
						startedAt={session.startedAt}
						playhead={hasArchive ? playhead : undefined}
					/>
					{encoder ? (
						<MoqEncoderHistory active={active} heartbeat={encoder} />
					) : null}
				</div>
			</div>
			{session.events.length ||
			(session.analyticsImpressionId && analyticsEncodingId) ? (
				<details>
					<summary className="cursor-pointer text-xs text-zinc-400">
						{t("moqPlayback.moreObservations")}
					</summary>
					<div className="mt-2 space-y-3">
						{session.events.length ? (
							<>
								<p className="text-xs text-zinc-500">
									{t("moqPlayback.browserSource")}
								</p>
								<MoqPlaybackStages
									startedAt={session.startedAt}
									events={session.events}
								/>
							</>
						) : null}
						{session.analyticsImpressionId && analyticsEncodingId ? (
							<MoqAnalyticsHistory
								channelId={channelId}
								runId={runId}
								encodingId={analyticsEncodingId}
								impressionId={session.analyticsImpressionId}
								active={active}
							/>
						) : null}
					</div>
				</details>
			) : null}
		</div>
	);
}
