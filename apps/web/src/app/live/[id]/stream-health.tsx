"use client";

import type { RunHealthLanes, RunHealthPoint, RunTimeline } from "@bitovp/core";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { useT } from "@/lib/i18n/context";
import type { HeartbeatReception } from "../live-shared";
import { mergePushTimeline } from "./push-timeline";
import { RunTimelineChart } from "./run-timeline-chart";

/* Advance the chart clock between polling responses so its right edge and allocation elapsed time remain current. Finished runs use endedAt and remain static. */
export function useTickingNow(active: boolean, periodMs = 2_000): number {
	const [nowMs, setNowMs] = useState(() => Date.now());
	useEffect(() => {
		if (!active) {
			return;
		}
		const timer = setInterval(() => setNowMs(Date.now()), periodMs);
		return () => clearInterval(timer);
	}, [active, periodMs]);
	return nowMs;
}

/**
 * Stream health (2026-08-23, owner ask; graph redesigned 2026-08-24, ledger
 * #166): the at-a-glance answer to "is this broadcast healthy right now",
 * and — for any run — the absolute-time timeline from start to stop with
 * the discrete events (queued/running/connect/output/content/stop) marked.
 *
 * Data is the run's own records, derived server-side (deriveRunHealth +
 * deriveRunTimeline) — this component renders lamps, the timeline chart and
 * the event list. Live mode refetches on the heartbeat cadence; finished
 * mode fetches once.
 */

export type HealthResponse = {
	points: RunHealthPoint[];
	lanes: RunHealthLanes;
	latest?: RunHealthPoint;
	run: {
		id: string;
		seq: number;
		status: string;
		createdAt: string;
		queueSeconds?: number | null;
	};
	truncated: boolean;
	/** False for a DASH-only plan — output is unobservable, not down (N3). */
	outputObservable: boolean;
	/** Absent only across a mid-deploy version skew — the chart just hides. */
	timeline?: RunTimeline;
	/** True when the content-action record hit its cap (review-294 S1). */
	actionsTruncated?: boolean;
	/** : Push drew the state lines where it was received. */
	laneSources?: { push: boolean; pushTruncated: boolean };
};

function formatSeconds(totalSec: number): string {
	const m = Math.floor(totalSec / 60);
	const sec = Math.round(totalSec % 60);
	return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
}

/**
 * The startup FIGURE : the chart's
 * axis starts at RUNNING so the queue/allocation wait no longer dominates
 * the picture — this line is where that wait stays readable. ONE source:
 * the run row's measured queueSeconds (#160's AWAIT pair). The events-
 * derived fallback (RUNNING − start request) was CUT (review-295 I3): a
 * resumed provision keeps its DONE entries' original timestamps, so that
 * arithmetic reads ~20h on a next-morning retry — the exact recorded
 * defect #160's isolated AWAIT pair exists to avoid. Runs without the
 * measurement (legacy pre-#160, the deliberately-unmeasured restart path)
 * show NO figure rather than a wrong one.
 *
 * While still allocating — no RUNNING, run not ended, and NO heartbeat
 * samples (review-295 I4: samples mean the encoder is answering, and an
 * amber "starting" line above a healthy chart contradicts itself) — the
 * figure is the ticking ELAPSED wait. A run that died before RUNNING
 * shows nothing here (the run row's error already says why).
 */
function StartupFigure({
	timeline,
	queueSeconds,
	hasSamples,
	nowMs,
}: {
	timeline: RunTimeline;
	queueSeconds?: number;
	hasSamples: boolean;
	nowMs: number;
}) {
	const { t } = useT();
	const runningAt = timeline.events.find(
		(e) => e.kind === "ENCODER_RUNNING",
	)?.atMs;
	if (runningAt !== undefined) {
		if (queueSeconds === undefined) {
			return null;
		}
		return (
			<p className="text-xs text-zinc-400">
				{t("live.health.startup", { duration: formatSeconds(queueSeconds) })}
			</p>
		);
	}
	if (timeline.window.endMs !== undefined || hasSamples) {
		return null;
	}
	const elapsed = Math.max(
		0,
		Math.round((nowMs - timeline.window.startMs) / 1000),
	);
	return (
		<p className="text-xs text-amber-400">
			{t("live.health.startingElapsed", {
				duration: formatSeconds(elapsed),
			})}
		</p>
	);
}

function Lamp({ on, label }: { on: boolean; label: string }) {
	const { t } = useT();
	return (
		<span className="inline-flex items-center gap-1.5 text-xs">
			<span
				aria-hidden
				className={`inline-block h-2.5 w-2.5 rounded-full ${
					on ? "bg-emerald-400" : "bg-red-400"
				}`}
			/>
			<span className="text-zinc-300">{label}</span>
			<span className={on ? "text-emerald-400" : "text-red-400"}>
				{on ? t("live.health.ok") : t("live.health.down")}
			</span>
		</span>
	);
}

export function useRunHealth(
	channelId: string,
	runId: string | null,
	live: boolean,
) {
	return useQuery({
		queryKey: ["run-health", channelId, runId],
		enabled: runId !== null,
		queryFn: () =>
			apiFetch<HealthResponse>(
				`/api/live-channels/${channelId}/runs/${runId}/health`,
			),
		// 5s, not the sweep's 30s cadence (owner expectation 2026-08-24:
		// Real-time rendering: new rows land about 30 seconds apart but on an unknown phase,
		// and a 30s poll could show them up to a minute late. The read is
		// five selects (four while provisioning), one of them a bounded
		// LIKE over AuditLog (at-range narrowed, pattern scanned) — 12/min
		// per open channel page (review-294 S6 corrected this sentence's
		// first figure). (review-293 I3 aligned this to the sweep; the
		// owner's realtime expectation supersedes; tradeoff on #166.)
		refetchInterval: live ? 5_000 : false,
	});
}

export function StreamHealth({
	channelId,
	runId,
	mode,
	lamps = true,
	reception,
}: {
	channelId: string;
	runId: string;
	mode: "live" | "finished";
	lamps?: boolean;
	reception?: HeartbeatReception;
}) {
	const { t } = useT();
	const health = useRunHealth(channelId, runId, mode === "live");
	// The axis clock ticks independently of the fetch: the chart's right
	// edge advances every ~2s while live, between data arrivals.
	const tickingNowMs = useTickingNow(mode === "live");
	if (health.isPending) {
		return <p className="text-xs text-zinc-500">{t("live.health.loading")}</p>;
	}
	if (health.isError || !health.data) {
		return (
			<p role="alert" className="text-red-400 text-xs">
				{t("live.health.loadFailed")}
			</p>
		);
	}
	const {
		latest,
		points,
		truncated,
		timeline,
		actionsTruncated,
		run,
		// review-293 S2: an absent field (contract break) must not read as
		// "DASH-only channel" — default to observable so a break shows red,
		// never a benign grey.
		outputObservable = true,
		laneSources,
	} = health.data;
	const pushTimeline =
		reception?.state === "available" && reception.runId === runId
			? reception.timeline
			: undefined;
	const displayEvents = timeline
		? mergePushTimeline(
				timeline.events,
				reception,
				runId,
				timeline.window,
				tickingNowMs,
			)
		: [];
	return (
		<div className="space-y-2">
			{mode === "live" ? (
				latest ? (
					lamps ? (
						<div className="flex flex-wrap items-center gap-4">
							<Lamp on={latest.ingest} label={t("live.health.ingest")} />
							<Lamp on={latest.encoder} label={t("live.health.encoder")} />
							{outputObservable ? (
								<Lamp on={latest.output} label={t("live.health.output")} />
							) : (
								// DASH-only: the heartbeat carries HLS only, so this
								// lane cannot be measured — grey, never red (N3).
								<span className="inline-flex items-center gap-1.5 text-xs">
									<span
										aria-hidden
										className="inline-block h-2.5 w-2.5 rounded-full bg-zinc-600"
									/>
									<span className="text-zinc-300">
										{t("live.health.output")}
									</span>
									<span className="text-zinc-500">
										{t("live.health.unobservable")}
									</span>
								</span>
							)}
						</div>
					) : null
				) : points.length > 0 ? (
					// review-293 I1: stale ≠ empty. The encoder lamp is
					// unreachable-red by construction (a row exists only when the
					// encoder answered), so THIS arm is the only way the feature
					// can say "the encoder stopped" — it must be loud, not a
					// benign "nothing yet" beside a solid-green timeline.
					<p role="alert" className="text-amber-400 text-xs">
						{t("live.health.stale")}
					</p>
				) : (
					<p className="text-xs text-zinc-500">{t("live.health.noData")}</p>
				)
			) : null}
			{timeline ? (
				<StartupFigure
					timeline={timeline}
					queueSeconds={run.queueSeconds ?? undefined}
					hasSamples={
						points.length > 0 || displayEvents.some((e) => e.source === "push")
					}
					nowMs={tickingNowMs}
				/>
			) : null}
			{timeline &&
			(timeline.events.some((e) => e.kind === "ENCODER_RUNNING") ||
				points.length > 0 ||
				displayEvents.some((e) => e.source === "push")) ? (
				// The chart exists from RUNNING on (owner follow-up: the axis
				// starts at encoder running; the wait above is a figure, not a band). It
				// still renders with zero heartbeat rows — a just-RUNNING run
				// shows its event dots on the _axis anchors. The points arm
				// keeps legacy runs whose mirror never wrote runningSince
				// drawable (their axis falls back to the window start).
				<RunTimelineChart
					window={timeline.window}
					events={displayEvents}
					points={points}
					nowMs={tickingNowMs}
					pushTimeline={pushTimeline}
					laneSources={laneSources}
				/>
			) : null}
			{points.length === 0 && mode === "finished" ? (
				<p className="text-xs text-zinc-500">{t("live.health.noData")}</p>
			) : null}
			{truncated ? (
				<p className="text-xs text-amber-400">{t("live.health.truncated")}</p>
			) : null}
			{actionsTruncated ? (
				<p className="text-xs text-amber-400">
					{t("live.health.actionsTruncated")}
				</p>
			) : null}
		</div>
	);
}
