"use client";

import {
	deriveProviderLifecycle,
	heartbeatSampleFresh,
	type PersistedProviderState,
} from "@bitovp/core";
import type { ReactNode } from "react";
import type {
	HeartbeatReception,
	LiveChannelStatus,
} from "@/app/live/live-shared";
import { HelpOverlay } from "@/components/ui/help-overlay";
import { formatDateTime } from "@/lib/format";
import type { MessageKey } from "@/lib/i18n";
import { useT } from "@/lib/i18n/context";
import type { ChannelAlertEvent } from "./alert-panel";
import {
	DELIVERY_LANES,
	type DeliveryLane,
	type LampState,
	lastSeen,
	latestWarning,
	openAlertsByLane,
	originReadLimitReached,
	summarizeOrigin,
	videoStream,
} from "./delivery-status";
import { incomingMbps, parseHeartbeat } from "./heartbeat";
import { HeartbeatHistory } from "./heartbeat-history";
import { HeartbeatPanel } from "./heartbeat-panel";
import { HeartbeatReceptionPanel } from "./heartbeat-reception-panel";
import { inputQualityWarnings } from "./input-quality";
import { deliveryDiagnosis, selectLiveTelemetry } from "./live-telemetry";
import { OriginPanel } from "./origin-panel";
import { SectionCard } from "./section-card";
import type { LiveJumpEvent } from "./section-focus";
import type { LivePhase, LiveSectionId } from "./section-layout";
import { StreamHealth, useRunHealth } from "./stream-health";

const LAMP_COPY: Record<LampState, MessageKey> = {
	on: "live.health.ok",
	off: "live.health.down",
	unknown: "status.unknown",
	unobservable: "live.health.unobservable",
	ended: "live.health.ended",
};
const LAMP_TONE: Record<LampState, string> = {
	on: "text-emerald-400",
	off: "text-red-400",
	unknown: "text-amber-400",
	unobservable: "text-zinc-400",
	ended: "text-zinc-400",
};
const ORIGIN_COPY: Record<
	ReturnType<typeof summarizeOrigin>["state"],
	MessageKey
> = {
	none: "live.health.outputNotObserved",
	unavailable: "origin.summaryUnavailable",
	stale: "origin.stale",
	advancing: "origin.advancing",
};

function LaneCard({
	lane,
	lamp,
	state,
	at,
	alerts,
	metrics,
	children,
}: {
	lane: DeliveryLane;
	lamp: LampState;
	state: string;
	at: string;
	alerts: number | "unknown";
	metrics: [string, string][];
	children?: ReactNode;
}) {
	const { t } = useT();
	return (
		<article
			data-lane={lane}
			aria-labelledby={`delivery-${lane}-h`}
			className="min-w-0 space-y-3 rounded-md border border-zinc-800 bg-zinc-900/40 p-3"
		>
			<div className="flex flex-wrap items-center justify-between gap-2">
				<h3
					id={`delivery-${lane}-h`}
					className="font-medium text-sm text-zinc-200"
				>
					{t(`live.health.${lane}`)}
				</h3>
				<span
					data-lane-lamp={lamp}
					className={`inline-flex items-center gap-1.5 text-xs ${LAMP_TONE[lamp]}`}
				>
					<span
						aria-hidden
						className="h-2.5 w-2.5 shrink-0 rounded-full bg-current"
					/>
					{t(LAMP_COPY[lamp])}
				</span>
			</div>
			<p
				data-lane-cell={`${lane}-state`}
				className="break-words text-sm text-zinc-200"
			>
				{state}
			</p>
			<p data-lane-cell={`${lane}-last-seen`} className="text-xs text-zinc-400">
				{t("live.health.lastSeen", { when: at })}
			</p>
			<dl className="space-y-2 text-xs">
				{metrics.map(([label, value]) => (
					<div
						key={label}
						className="flex flex-wrap justify-between gap-x-3 gap-y-1"
					>
						<dt className="text-zinc-400">{label}</dt>
						<dd className="min-w-0 break-all text-zinc-200">{value}</dd>
					</div>
				))}
			</dl>
			<p
				data-lane-cell={`${lane}-alerts`}
				className={`text-xs ${alerts === "unknown" ? "text-amber-400" : alerts > 0 ? "text-red-400" : "text-zinc-400"}`}
			>
				{alerts === "unknown"
					? t("live.health.laneAlertsUnknown")
					: t("live.health.laneAlerts", { count: alerts })}
			</p>
			{children}
		</article>
	);
}

export function DeliveryStatusPanel({
	channelId,
	run,
	mode,
	phase,
	lastHeartbeat,
	heartbeatReception,
	openAlerts,
	alertHistory,
	playableCount,
	manifestCount,
	region,
	encoderIp,
	channelStatus,
	providerStatus,
	providerObservedAt,
	nowMs,
	detailsOpen,
	detailsHelp,
	onJump,
}: {
	channelId: string;
	run:
		| ({ id: string; originObservation: unknown } & PersistedProviderState)
		| null;
	mode: "live" | "finished";
	phase: LivePhase;
	lastHeartbeat: unknown;
	heartbeatReception?: HeartbeatReception;
	openAlerts: ChannelAlertEvent[] | "unknown";
	alertHistory: ChannelAlertEvent[];
	playableCount: number;
	manifestCount: number;
	region: string | null;
	encoderIp: string | null;
	channelStatus: LiveChannelStatus;
	providerStatus: string | null;
	providerObservedAt: string | null;
	nowMs: number;
	detailsOpen: (id: LiveSectionId) => boolean;
	detailsHelp: (id: LiveSectionId) => string | undefined;
	onJump?: (event: LiveJumpEvent, targetId: string) => void;
}) {
	const { t } = useT();
	const health = useRunHealth(channelId, run?.id ?? null, mode === "live");
	const telemetry = selectLiveTelemetry({
		reception: heartbeatReception,
		runId: run?.id ?? null,
		poll: lastHeartbeat,
		nowMs,
		mode,
	});
	const diagnosis = deliveryDiagnosis(telemetry, run?.originObservation, nowMs);
	const heartbeat = parseHeartbeat(telemetry.sample);
	const providerLifecycle = deriveProviderLifecycle(
		{ ...run, providerStatus, providerStatusObservedAt: providerObservedAt },
		nowMs,
	);
	const lamps: Record<DeliveryLane, LampState> =
		mode === "finished"
			? { ingest: "ended", encoder: "ended", output: "ended" }
			: {
					ingest:
						diagnosis.input === "UNKNOWN"
							? "unknown"
							: diagnosis.input === "CONNECTED"
								? "on"
								: "off",
					encoder: !heartbeatSampleFresh({ at: providerObservedAt }, nowMs)
						? "unknown"
						: providerLifecycle === "RUNNING"
							? "on"
							: providerLifecycle === "TERMINAL"
								? "off"
								: "unknown",
					output:
						diagnosis.output === "advancing"
							? "on"
							: diagnosis.output === "stalled"
								? "off"
								: health.data?.outputObservable === false
									? "unobservable"
									: "unknown",
				};
	const quality =
		telemetry.current && telemetry.sample
			? inputQualityWarnings(
					telemetry.sample.raw,
					telemetry.previousRaw,
					telemetry.providerSampleAtMs ?? Number.NaN,
					telemetry.previousSampleAtMs,
				)
			: [];
	const qualityText = (warning: (typeof quality)[number]) => {
		switch (warning.code) {
			case "PACKET_ARRIVAL_STALLED":
				return t("live.health.packetStalled", {
					streamIndex: warning.params.streamIndex,
					mediaType: warning.params.mediaType,
					ageSeconds: warning.params.ageSeconds.toFixed(1),
				});
			case "VIDEO_RATE_LOW":
				return t("live.health.rateLow", {
					streamIndex: warning.params.streamIndex,
					declaredFps: warning.params.declaredFps,
					actualFps: Math.round(warning.params.actualFps * 10) / 10,
				});
			case "VIDEO_GOP_LONG":
				return t("live.health.gopLong", {
					streamIndex: warning.params.streamIndex,
					maximumMs: Math.round(warning.params.maximumMs),
				});
			case "PACKET_COUNTERS_INCREASED":
				return t("live.health.packetGrowth", {
					count: Object.values(warning.params).reduce((a, b) => a + b, 0),
				});
		}
	};
	const counts = openAlerts === "unknown" ? null : openAlertsByLane(openAlerts);
	const origin = summarizeOrigin(run?.originObservation);
	const stream = videoStream(heartbeat);
	const warning = latestWarning(heartbeat);
	const seen = (stamp: string | null) => {
		const value = lastSeen(stamp, nowMs, mode === "live");
		switch (value.kind) {
			case "never":
				return t("status.never");
			case "skew":
				return t("status.clockSkew");
			case "ago":
				return t("status.secondsAgo", { seconds: value.seconds });
			case "at":
				return formatDateTime(value.at);
		}
	};
	const inputState =
		mode === "finished"
			? t("status.none")
			: diagnosis.input === "CONNECTED"
				? t("status.ingestConnected")
				: diagnosis.input !== "UNKNOWN"
					? diagnosis.input
					: t(
							phase === "starting" && !heartbeat
								? "live.health.starting"
								: "status.unknown",
						);
	const states = {
		ingest: inputState,
		encoder:
			providerLifecycle === "UNKNOWN" || providerLifecycle === "UNOBSERVED"
				? t("status.unknown")
				: (providerStatus ?? t("status.unknown")),
		output:
			diagnosis.outputSource === "origin" || origin.state === "unavailable"
				? t(ORIGIN_COPY[origin.state])
				: t(
						diagnosis.output === "advancing"
							? "origin.advancing"
							: diagnosis.output === "stalled"
								? "origin.stale"
								: "status.unknown",
					),
	};
	const stamps = {
		ingest: heartbeat?.at ?? null,
		encoder: providerObservedAt,
		output:
			diagnosis.outputSource === "origin" && origin.lastFetchAtMs !== null
				? new Date(origin.lastFetchAtMs).toISOString()
				: diagnosis.outputSource === "push" || diagnosis.outputSource === "poll"
					? (heartbeat?.at ?? null)
					: null,
	};
	const metrics: Record<DeliveryLane, [string, string][]> = {
		ingest: [
			[t("heartbeatLog.incomingMbps"), incomingMbps(stream?.incomingBitrate)],
			[t("heartbeat.rate"), stream?.rate ?? "—"],
			[
				t("heartbeat.droppedVideo"),
				t("live.health.droppedCounts", {
					total: heartbeat?.totals.droppedPacketsVideo ?? "—",
					delta: heartbeat?.deltas.droppedPacketsVideo ?? "—",
				}),
			],
		],
		encoder: [
			[t("live.health.region"), region ?? "—"],
			[t("live.health.encoderIp"), encoderIp ?? "—"],
			[
				t("live.health.latestWarning"),
				warning?.text ??
					t(heartbeat ? "live.health.noWarning" : "status.unknown"),
			],
		],
		output: [
			[t("status.playable"), String(playableCount)],
			[t("jobDetail.manifests"), String(manifestCount)],
			[
				t("live.health.edgeDelayMax"),
				origin.maxEdgeDelaySeconds === null
					? "—"
					: t("live.health.seconds", { s: origin.maxEdgeDelaySeconds }),
			],
		],
	};
	return (
		<section
			id="sec-delivery-status"
			aria-labelledby="sec-delivery-status-h"
			className="space-y-3"
		>
			<h2
				id="sec-delivery-status-h"
				className="font-semibold text-base text-zinc-100"
			>
				{t("live.health.panelTitle")}{" "}
				<HelpOverlay labelFor={t("live.health.panelTitle")}>
					{t("live.health.sources")}
				</HelpOverlay>
			</h2>
			<p
				data-delivery-notice={diagnosis.notice}
				className={`text-sm ${diagnosis.notice === "INPUT_LOST" || diagnosis.notice === "OUTPUT_STALLED" ? "text-red-300" : "text-zinc-300"}`}
			>
				{t(`live.health.diagnosis.${diagnosis.notice}`)}
			</p>
			<p className="text-xs text-zinc-400">
				{t("live.health.source", {
					source:
						telemetry.source === "none"
							? "—"
							: telemetry.source === "push"
								? "Push"
								: "Poll",
				})}
			</p>
			{quality.length > 0 ? (
				<details className="text-sm text-amber-300">
					<summary className="cursor-pointer">
						{t("live.health.qualityTitle", { count: quality.length })}
					</summary>
					<ul className="mt-2 list-disc space-y-1 pl-5">
						{quality.map((warning, index) => (
							<li key={`${warning.code}-${index}`}>{qualityText(warning)}</li>
						))}
					</ul>
					<p className="mt-2 text-xs text-zinc-400">
						{t("live.health.qualityHint")}
					</p>
				</details>
			) : null}
			{originReadLimitReached(run?.originObservation) ? (
				<p role="status" className="text-sm text-amber-300">
					{t("origin.playlistReadLimitReached")}{" "}
					<HelpOverlay labelFor={t("origin.playlistReadLimitReached")}>
						{t("origin.playlistReadLimitHelp")}
					</HelpOverlay>
				</p>
			) : null}
			<HeartbeatReceptionPanel
				reception={heartbeatReception}
				runId={run?.id ?? null}
				nowMs={nowMs}
				mode={mode}
			/>
			<div className="grid gap-3 lg:grid-cols-3">
				{DELIVERY_LANES.map((lane) => (
					<LaneCard
						key={lane}
						lane={lane}
						lamp={lamps[lane]}
						state={states[lane]}
						at={seen(stamps[lane])}
						alerts={counts?.[lane] ?? "unknown"}
						metrics={metrics[lane]}
					>
						{lane === "ingest" ? (
							<SectionCard
								id="sec-heartbeat"
								level={4}
								title={t("live.health.ingestDetails")}
								help={detailsHelp("sec-heartbeat")}
								defaultOpen={detailsOpen("sec-heartbeat")}
							>
								<HeartbeatPanel
									lastHeartbeat={telemetry.sample}
									nowMs={nowMs}
								/>
								<h5 className="mt-4 font-medium text-xs text-zinc-300">
									{t("live.history")}
								</h5>
								<HeartbeatHistory
									channelId={channelId}
									status={channelStatus}
									{...(mode === "finished" && run ? { runId: run.id } : {})}
									alertMarks={(openAlerts === "unknown" ? [] : openAlerts)
										.concat(alertHistory)
										.map((event) => ({
											id: event.id,
											at: event.openedAt,
											severity: event.rule.severity,
										}))}
								/>
							</SectionCard>
						) : lane === "output" ? (
							<>
								{/* biome-ignore lint/a11y/useValidAnchor: real section navigation with focus transfer to the target heading. */}
								<a
									href="#sec-manifests"
									onClick={(event) => onJump?.(event, "sec-manifests")}
									className="inline-block text-xs text-zinc-300 underline underline-offset-4"
								>
									{t("live.health.toManifests")}
								</a>
								<SectionCard
									id="sec-origin"
									level={4}
									title={t("origin.title")}
									help={detailsHelp("sec-origin")}
									defaultOpen={detailsOpen("sec-origin")}
								>
									<OriginPanel observation={run?.originObservation ?? null} />
								</SectionCard>
							</>
						) : null}
					</LaneCard>
				))}
			</div>
			{run ? (
				<StreamHealth
					channelId={channelId}
					runId={run.id}
					mode={mode}
					lamps={false}
					reception={heartbeatReception}
				/>
			) : null}
		</section>
	);
}
