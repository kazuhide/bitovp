"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Play, Square } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useDocumentOrganization } from "@/components/providers";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api";
import { useT } from "@/lib/i18n/context";
import type { MoqHeartbeatHistory } from "@/lib/moq-player/heartbeat";
import type { MoqHistorySaveState } from "@/lib/moq-player/history-client";
import { loadMoqPlayer } from "@/lib/moq-player/loader";
import {
	appendMoqLiveSample,
	type MoqMetricSample,
} from "@/lib/moq-player/metric-series";
import {
	appendMoqObservationEvent,
	type MoqObservationEvent,
} from "@/lib/moq-player/observations";
import { createMoqPreviewArchive } from "@/lib/moq-player/preview-archive";
import type { MoqRecordingState } from "@/lib/moq-player/recording";
import { createMoqPlayback } from "@/lib/moq-player/session";
import {
	type MoqPlaybackDescriptor,
	parseMoqPlaybackDescriptor,
} from "@/lib/moq-player/types";
import {
	EMPTY_MOQ_VIDEO_STATISTICS,
	type MoqVideoStatistics,
} from "@/lib/moq-player/video-statistics";
import { MOQ_ARCHIVE_SAVE_TIMEOUT_MS } from "../../../../config/moq-policy";
import { MoqClientPlaybackClock } from "./moq-client-playback-clock";
import { MoqEncoderHistory } from "./moq-encoder-history";
import { type MoqArchiveSave, MoqHistoryPanel } from "./moq-history-panel";
import { MoqPlaybackStages } from "./moq-playback-stages";
import { MoqPlayerStatistics } from "./moq-player-statistics";
import { MoqViewerMetrics } from "./moq-viewer-metrics";
import { useMoqObservationHistory } from "./use-moq-observation-history";

const emptyHeartbeat: MoqHeartbeatHistory = {
	source: "live-encoder-heartbeat",
	points: [],
	truncated: false,
};

type Props = {
	channelId: string;
	runId: string;
	active: boolean;
	standalone?: boolean;
};
type Phase =
	| "idle"
	| "loading"
	| "stopping"
	| "waiting"
	| "frames"
	| "stopped"
	| "unavailable"
	| "failed";
type Attempt = {
	abort: AbortController;
	session?: ReturnType<typeof createMoqPlayback>;
	archive?: ReturnType<typeof createMoqPreviewArchive>;
	reason: "stopped" | "failed" | "ended";
	noteStage(type: MoqObservationEvent["type"]): void;
};
type PlaybackTrace = {
	attemptId: number;
	startedAt: string;
	events: readonly MoqObservationEvent[];
	latest: MoqObservationEvent;
};

export function MoqPlayerPreview(props: Props) {
	return (
		<MoqPlaybackAttempt key={`${props.channelId}:${props.runId}`} {...props} />
	);
}
function MoqPlaybackAttempt({
	channelId,
	runId,
	active,
	standalone = false,
}: Props) {
	const { t } = useT();
	const organizationId = useDocumentOrganization();
	const queryClient = useQueryClient();
	const observations = useMoqObservationHistory(
		channelId,
		runId,
		active,
		active,
	);
	const heartbeat = observations.data?.heartbeat ?? emptyHeartbeat;
	const [samples, setSamples] = useState<readonly MoqMetricSample[]>([]);
	const host = useRef<HTMLElement>(null);
	const current = useRef<Attempt | undefined>(undefined);
	const generation = useRef(0);
	const intent = useRef(0);
	const closing = useRef<Promise<void> | undefined>(undefined);
	const archiveGeneration = useRef(0);
	const mounted = useRef(true);
	const [recordingState, setRecordingState] =
		useState<MoqRecordingState>("idle");
	const [archiveSaves, setArchiveSaves] = useState<MoqArchiveSave[]>([]);
	const [historyState, setHistoryState] = useState<
		MoqHistorySaveState | "idle"
	>("idle");
	const [analyticsState, setAnalyticsState] = useState<
		"ready" | "unavailable" | "not-configured"
	>("not-configured");
	const [phase, setPhase] = useState<Phase>("idle");
	const [trace, setTrace] = useState<PlaybackTrace>();
	const [cleanupPending, setCleanupPending] = useState(false);
	const [statistics, setStatistics] = useState<MoqVideoStatistics>(
		EMPTY_MOQ_VIDEO_STATISTICS,
	);
	const [configuration, setConfiguration] = useState<
		MoqPlaybackDescriptor["resource"]["metadata"] | null
	>(null);
	const [relay, setRelay] = useState<MoqPlaybackDescriptor["relay"]>();
	const close = useCallback(() => {
		if (closing.current) return closing.current;
		generation.current++;
		const attempt = current.current;
		if (!attempt) return Promise.resolve();
		current.current = undefined;
		attempt.noteStage(attempt.reason);
		attempt.abort.abort();
		const disposal =
			attempt.session?.dispose() ??
			attempt.archive?.finish(attempt.reason) ??
			Promise.resolve();
		closing.current = disposal;
		if (mounted.current) setCleanupPending(true);
		void Promise.allSettled([disposal, attempt.session?.released]).then(() => {
			if (closing.current !== disposal) return;
			closing.current = undefined;
			if (mounted.current) setCleanupPending(false);
		});
		return disposal;
	}, []);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
			archiveGeneration.current++;
			intent.current++;
		};
	}, []);
	useEffect(() => {
		if (!active) {
			intent.current++;
			void close().catch(() => {});
			setPhase("stopped");
			setStatistics(EMPTY_MOQ_VIDEO_STATISTICS);
			setSamples([]);
		} else {
			setPhase((value) => (value === "stopped" ? "idle" : value));
		}
		return () => {
			void close().catch(() => {});
		};
	}, [active, close]);
	async function play() {
		if (!active || !host.current || closing.current) return;
		const startedAt = performance.now();
		const startedWall = new Date().toISOString();
		const ownIntent = ++intent.current;
		setPhase("loading");
		await close().catch(() => {});
		if (ownIntent !== intent.current || !mounted.current || !host.current)
			return;
		if (closing.current) {
			setPhase("failed");
			return;
		}
		const archiveEpoch = ++archiveGeneration.current;
		const visibleArchive = () =>
			mounted.current && archiveGeneration.current === archiveEpoch;
		setStatistics(EMPTY_MOQ_VIDEO_STATISTICS);
		setSamples([]);
		setConfiguration(null);
		setRelay(undefined);
		setRecordingState("idle");
		setHistoryState("idle");
		setAnalyticsState("not-configured");
		if (typeof Reflect.get(window, "WebTransport") !== "function") {
			setPhase("unavailable");
			return;
		}
		const started: MoqObservationEvent = { type: "started", elapsedMs: 0 };
		setTrace({
			attemptId: ownIntent,
			startedAt: startedWall,
			events: [started],
			latest: started,
		});
		const attempt: Attempt = {
			abort: new AbortController(),
			reason: "ended",
			noteStage(type) {
				const elapsedMs = Math.max(
					0,
					Math.round(performance.now() - startedAt),
				);
				const event = { type, elapsedMs };
				if (mounted.current)
					setTrace((value) => {
						if (value?.attemptId !== ownIntent || value.latest.type === type)
							return value;
						return {
							...value,
							events: appendMoqObservationEvent(value.events, event),
							latest: event,
						};
					});
				attempt.archive?.event(type, elapsedMs);
			},
		};
		current.current = attempt;
		const owned = () =>
			current.current === attempt && !attempt.abort.signal.aborted;
		setPhase("loading");
		try {
			const raw = await apiFetch<unknown>(
				`/api/live-channels/${channelId}/runs/${runId}/moq-playback`,
				{ cache: "no-store", signal: attempt.abort.signal },
			);
			if (!owned()) return;
			const descriptor = parseMoqPlaybackDescriptor(raw, runId);
			setConfiguration(descriptor.resource.metadata);
			setRelay(descriptor.relay);
			attempt.archive = createMoqPreviewArchive({
				channelId,
				runId,
				descriptor,
				startedAt: startedWall,
				startedMonotonicMs: startedAt,
				onRecordingState: (value) => {
					if (!visibleArchive()) return;
					setRecordingState(value);
					const sessionId = attempt.archive?.id;
					if (!sessionId) return;
					const pending: MoqArchiveSave | undefined =
						value === "unconfirmed"
							? {
									sessionId,
									startedAt: startedWall,
									state: value,
									confirmUntilMs:
										performance.now() + MOQ_ARCHIVE_SAVE_TIMEOUT_MS,
								}
							: value === "saving"
								? { sessionId, startedAt: startedWall, state: value }
								: undefined;
					setArchiveSaves((saves) => {
						const others = saves.filter((save) => save.sessionId !== sessionId);
						if (pending) return [...others, pending];
						return others.length === saves.length ? saves : others;
					});
				},
				onHistoryState: (value) => {
					if (visibleArchive()) setHistoryState(value);
				},
				onAnalyticsState: (value) => {
					if (visibleArchive()) setAnalyticsState(value);
				},
				onPersisted: () => {
					void queryClient.invalidateQueries({
						queryKey: ["moq-observations", channelId, runId],
					});
				},
			});
			attempt.noteStage("descriptor-ready");
			const factory = await loadMoqPlayer(organizationId);
			if (!owned() || !host.current) return;
			attempt.session = createMoqPlayback(
				factory,
				descriptor,
				host.current,
				() => {
					if (owned()) setPhase("frames");
				},
				() => {
					if (owned()) {
						attempt.reason = "failed";
						attempt.noteStage("failed");
						setPhase("failed");
						setStatistics(EMPTY_MOQ_VIDEO_STATISTICS);
						setSamples([]);
					}
				},
				{
					startedAt,
					onStage: (type) => {
						if (owned()) attempt.noteStage(type);
					},
					onVideo: (video) => attempt.archive?.video(video),
					beforeDispose: () =>
						attempt.archive?.finish(attempt.reason) ?? Promise.resolve(),
					onStatistics: (value) => {
						if (owned()) {
							const elapsedMs = Math.max(
								0,
								Math.round(performance.now() - startedAt),
							);
							setStatistics(value);
							setSamples((series) =>
								appendMoqLiveSample(series, {
									elapsedMs,
									latencyMs:
										value.latencySeconds === null
											? null
											: value.latencySeconds * 1000,
									fps: value.fps,
									bufferSeconds: value.bufferSeconds,
									bufferSource: value.bufferSource,
									renderingSource: value.renderingSource,
								}),
							);
							attempt.archive?.statistics(value);
						}
					},
				},
			);
			await attempt.session.ready;
			if (owned())
				setPhase((value) =>
					value === "frames" || value === "failed" ? value : "waiting",
				);
		} catch (error) {
			if (!owned()) return;
			attempt.reason = "failed";
			void close().catch(() => {});
			setStatistics(EMPTY_MOQ_VIDEO_STATISTICS);
			setSamples([]);
			setPhase(
				typeof error === "object" &&
					error !== null &&
					"status" in error &&
					error.status === 503
					? "unavailable"
					: "failed",
			);
		}
	}
	async function stop() {
		if (phase === "stopping") return;
		intent.current++;
		if (current.current) current.current.reason = "stopped";
		const disposal = close();
		setStatistics(EMPTY_MOQ_VIDEO_STATISTICS);
		setSamples([]);
		const ownGeneration = generation.current;
		setPhase("stopping");
		try {
			await disposal;
			if (generation.current === ownGeneration) setPhase("stopped");
		} catch {
			if (generation.current === ownGeneration) setPhase("failed");
		}
	}
	const busy =
		phase === "loading" ||
		phase === "stopping" ||
		phase === "waiting" ||
		phase === "frames";
	return (
		<div
			id="moq-preview"
			className="@container min-w-0 space-y-4 scroll-mt-4"
			data-moq-preview={runId}
			data-moq-phase={phase}
		>
			{!active ? (
				<MoqHistoryPanel
					key="history-ended"
					channelId={channelId}
					runId={runId}
					active={false}
					archiveSaves={archiveSaves}
				/>
			) : null}
			{!active && !standalone ? (
				<Link
					href={`/live/${channelId}/runs/${runId}/moq#moq-preview`}
					className="inline-block text-xs text-zinc-400 underline underline-offset-2 hover:text-zinc-200"
				>
					{t("moqPlayback.openPlayer")}
				</Link>
			) : null}
			<details key="live" open={active} className="min-w-0 space-y-2">
				<summary
					className={active ? "hidden" : "cursor-pointer text-xs text-zinc-400"}
				>
					MoQ / Web X · {t("moqPlayback.stopped")}
				</summary>
				<div
					data-moq-live-layout
					className="grid min-w-0 items-start gap-5 @3xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]"
				>
					<div className="min-w-0 overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950/35">
						<div className="relative">
							<section
								ref={host}
								data-moq-live-host={runId}
								aria-label={t("moqPlayback.title")}
								className="aspect-video w-full overflow-hidden bg-black [&_canvas]:h-full [&_canvas]:w-full [&_canvas]:object-contain [&_video]:h-full [&_video]:w-full [&_video]:object-contain"
							/>
							{!busy && active ? (
								<div className="absolute inset-0 grid place-items-center">
									<Button
										size="default"
										disabled={cleanupPending}
										onClick={() => void play()}
									>
										<Play aria-hidden className="size-4" />
										{t("moqPlayback.play")}
									</Button>
								</div>
							) : null}
						</div>
						<div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
							{!active ? (
								<Button size="sm" disabled>
									{t("moqPlayback.play")}
								</Button>
							) : null}
							{busy ? (
								<Button
									size="sm"
									variant="secondary"
									disabled={phase === "stopping"}
									onClick={() => void stop()}
								>
									<Square aria-hidden className="size-3" />
									{t("moqPlayback.stop")}
								</Button>
							) : null}
							<span
								role={phase === "failed" ? "alert" : "status"}
								aria-live="polite"
								className={
									phase === "failed"
										? "text-xs text-red-300"
										: "text-xs text-zinc-400"
								}
							>
								{t(`moqPlayback.${phase}`)}
							</span>
							{statistics.resolution ? (
								<span
									data-moq-resolution
									className="text-xs text-zinc-400 tabular-nums"
								>
									{statistics.resolution}
								</span>
							) : null}
							{cleanupPending && !busy ? (
								<span className="text-xs text-zinc-400">
									{t("moqPlayback.cleanupPending")}
								</span>
							) : null}
							{active && !standalone ? (
								<Link
									href={`/live/${channelId}/runs/${runId}/moq#moq-preview`}
									className="text-xs text-zinc-300 underline underline-offset-2 sm:ml-auto"
								>
									{t("moqPlayback.openPlayer")}
								</Link>
							) : null}
						</div>
						{active && phase === "frames" ? (
							<div className="border-t border-zinc-800 px-3 py-2">
								<MoqClientPlaybackClock mode="live" active />
							</div>
						) : null}
					</div>
					{active ? (
						<div
							data-moq-live-metrics
							className="min-w-0 space-y-3 rounded-lg border border-zinc-800 bg-zinc-950/35 p-3"
						>
							<MoqViewerMetrics
								samples={samples}
								startedAt={trace?.startedAt ?? ""}
								live
							/>
							<MoqEncoderHistory
								heartbeat={heartbeat}
								status={
									observations.isError
										? "error"
										: observations.isPending
											? "pending"
											: undefined
								}
							/>
						</div>
					) : null}
				</div>
				{trace || configuration || relay ? (
					<details className="min-w-0 text-xs">
						<summary className="cursor-pointer text-zinc-400">
							{t("moqPlayback.playerDetails")}
						</summary>
						<div className="mt-2 space-y-2">
							{trace ? (
								<MoqPlaybackStages
									startedAt={trace.startedAt}
									events={trace.events}
									latest={trace.latest}
								/>
							) : null}
							<MoqPlayerStatistics
								statistics={statistics}
								configuration={configuration}
								relay={relay}
							/>
						</div>
					</details>
				) : null}
				<div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-zinc-500">
					{recordingState !== "saving" && recordingState !== "unconfirmed" ? (
						<p
							aria-live="polite"
							data-moq-recording={recordingState}
							hidden={recordingState === "idle"}
						>
							{t(`moqPlayback.recording.${recordingState}`)}
						</p>
					) : null}
					<p
						data-moq-history-save={historyState}
						hidden={historyState !== "failed" && historyState !== "limit"}
					>
						{t(`moqPlayback.historySave.${historyState}`)}
					</p>
					<p hidden={analyticsState !== "unavailable"}>
						{t(`moqPlayback.analyticsState.${analyticsState}`)}
					</p>
				</div>
			</details>
			{active && (observations.data?.sessions.length || archiveSaves.length) ? (
				<MoqHistoryPanel
					key="history-active"
					channelId={channelId}
					runId={runId}
					active
					hideEncoder
					archiveSaves={archiveSaves}
				/>
			) : null}
		</div>
	);
}
