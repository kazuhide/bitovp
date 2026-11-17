"use client";

import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useDocumentOrganization } from "@/components/providers";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api";
import { useT } from "@/lib/i18n/context";
import type { MoqHistorySaveState } from "@/lib/moq-player/history-client";
import { loadMoqPlayer } from "@/lib/moq-player/loader";
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
import { MoqContentTime } from "./moq-content-time";
import { MoqHistoryPanel } from "./moq-history-panel";
import { MoqPlayerStatistics } from "./moq-player-statistics";

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
	const host = useRef<HTMLElement>(null);
	const current = useRef<Attempt | undefined>(undefined);
	const generation = useRef(0);
	const intent = useRef(0);
	const closing = useRef<Promise<void> | undefined>(undefined);
	const archiveGeneration = useRef(0);
	const mounted = useRef(true);
	const [recordingState, setRecordingState] =
		useState<MoqRecordingState>("idle");
	const [historyState, setHistoryState] = useState<
		MoqHistorySaveState | "idle"
	>("idle");
	const [analyticsState, setAnalyticsState] = useState<
		"ready" | "unavailable" | "not-configured"
	>("not-configured");
	const [phase, setPhase] = useState<Phase>("idle");
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
		current.current = undefined;
		attempt?.abort.abort();
		const disposal =
			attempt?.session?.dispose() ??
			attempt?.archive?.finish(attempt.reason) ??
			Promise.resolve();
		closing.current = disposal;
		const clear = () => {
			if (closing.current === disposal) closing.current = undefined;
		};
		void disposal.then(clear, clear);
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
		}
		return () => {
			void close().catch(() => {});
		};
	}, [active, close]);
	async function play() {
		if (!active || !host.current) return;
		const startedAt = performance.now();
		const startedWall = new Date().toISOString();
		const ownIntent = ++intent.current;
		setPhase("loading");
		await close().catch(() => {});
		if (ownIntent !== intent.current || !mounted.current || !host.current)
			return;
		const archiveEpoch = ++archiveGeneration.current;
		const visibleArchive = () =>
			mounted.current && archiveGeneration.current === archiveEpoch;
		setStatistics(EMPTY_MOQ_VIDEO_STATISTICS);
		setConfiguration(null);
		setRelay(undefined);
		setRecordingState("idle");
		setHistoryState("idle");
		if (typeof Reflect.get(window, "WebTransport") !== "function") {
			setPhase("unavailable");
			return;
		}
		const attempt: Attempt = { abort: new AbortController(), reason: "ended" };
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
					if (visibleArchive()) setRecordingState(value);
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
			await attempt.archive.ready;
			if (!owned()) return;
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
						setPhase("failed");
						setStatistics(EMPTY_MOQ_VIDEO_STATISTICS);
					}
				},
				{
					startedAt,
					onVideo: (video) => attempt.archive?.video(video),
					beforeDispose: () =>
						attempt.archive?.finish(attempt.reason) ?? Promise.resolve(),
					onStatistics: (value) => {
						if (owned()) {
							setStatistics(value);
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
			className="space-y-2 scroll-mt-4"
			data-moq-preview={runId}
			data-moq-phase={phase}
		>
			{!active ? (
				<MoqHistoryPanel
					key="history-ended"
					channelId={channelId}
					runId={runId}
					active={false}
				/>
			) : null}
			{!active && !standalone ? (
				<Link
					href={`/live/${channelId}/runs/${runId}/moq#moq-preview`}
					className="inline-block text-xs text-zinc-300 underline underline-offset-2"
				>
					{t("moqPlayback.openPlayer")}
				</Link>
			) : null}
			<details key="live" open={active} className="space-y-2">
				<summary
					className={active ? "hidden" : "cursor-pointer text-xs text-zinc-400"}
				>
					MoQ / Web X · {t("moqPlayback.stopped")}
				</summary>
				<div className="flex flex-wrap items-center gap-2">
					<span className="rounded border border-zinc-700 px-2 py-1 font-medium text-xs text-zinc-200">
						MoQ / Web X
					</span>
					<Button
						size="sm"
						disabled={!active || busy}
						onClick={() => void play()}
					>
						{t("moqPlayback.play")}
					</Button>
					<Button
						size="sm"
						variant="secondary"
						disabled={!busy || phase === "stopping"}
						onClick={() => void stop()}
					>
						{t("moqPlayback.stop")}
					</Button>
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
					{!standalone ? (
						<Link
							href={`/live/${channelId}/runs/${runId}/moq`}
							className="text-xs text-zinc-300 underline underline-offset-2"
						>
							{t("moqPlayback.openPlayer")}
						</Link>
					) : null}
				</div>
				<section
					ref={host}
					data-moq-live-host={runId}
					aria-label={t("moqPlayback.title")}
					className="relative aspect-video w-full max-w-2xl overflow-hidden rounded-md border border-zinc-800 bg-black [&_canvas]:h-full [&_canvas]:w-full [&_canvas]:object-contain [&_video]:h-full [&_video]:w-full [&_video]:object-contain"
				/>
				<MoqContentTime mediaRef={host} />
				<MoqPlayerStatistics
					statistics={statistics}
					configuration={configuration}
					relay={relay}
				/>
				<div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-zinc-500">
					<p
						aria-live="polite"
						data-moq-recording={recordingState}
						hidden={recordingState === "idle"}
					>
						{t(`moqPlayback.recording.${recordingState}`)}
					</p>
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
			{active ? (
				<MoqHistoryPanel
					key="history-active"
					channelId={channelId}
					runId={runId}
					active
				/>
			) : null}
		</div>
	);
}
