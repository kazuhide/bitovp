"use client";

import type { PlayerClientConfig } from "@bitovp/core";
import {
	CHANNEL_STARTING_SCHEDULE_ACTIONS,
	DEFAULT_SCHEDULE_START_GRACE_MINUTES,
	deriveLiveChannelStatus,
	deriveProviderLifecycle,
	ingestConnectedTriState,
	isRuntimeRecordKind,
	liveChannelPlanSchema,
	liveNextAction,
	stepLogSchema,
} from "@bitovp/core";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { Fragment, type ReactNode, useEffect, useState } from "react";
import {
	type FeederSessionListItem,
	isActiveFeederStatus,
} from "@/app/live/feeders/feeder-shared";
import {
	isActiveChannelStatus,
	type LiveChannelDetailRow,
	normalizeLiveToVod,
} from "@/app/live/live-shared";
import { LiveStatusBadge } from "@/app/live/live-status-badge";
import {
	PlayerPreview,
	playableLinks,
} from "@/app/vod/jobs/[id]/player-preview";
import { CopyButton } from "@/components/copy-button";
import { ManifestList } from "@/components/manifest-list";
import { SaveAsTemplateButton } from "@/components/save-as-template";
import { StepTimeline } from "@/components/step-timeline";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api";
import type { SessionDto } from "@/lib/auth/dto";
import { RoleAccess } from "@/lib/auth/use-role-access";
import { localizedCustomerError } from "@/lib/customer-error";
import { useQcVmafEnabled } from "@/lib/feature-flags/context";
import { useT } from "@/lib/i18n/context";
import type { LiveScheduleDto } from "@/lib/live-runtime/schemas";
import { AlertPanel, type ChannelAlertEvent } from "./alert-panel";
import { LiveArchivePanel } from "./archive-panel";
import { CaptureVmafPanel } from "./capture-vmaf-panel";
import {
	ChannelCueForm,
	ChannelDangerZone,
	ChannelLifecycleActions,
	DuplicateChannelButton,
} from "./channel-actions";
import { ChannelDnsMappingsPanel } from "./channel-dns-mappings-panel";
import { ContentInsertionPanel } from "./content-insertion-panel";
import { DeliveryStatusPanel } from "./delivery-status-panel";
import { Disclosure } from "./disclosure";
import { DvrPanel } from "./dvr-panel";
import { EsamPanel } from "./esam-panel";
import { FeederPanel } from "./feeder-panel";
import { FlatSection } from "./flat-section";
import { DeepLinkFocus, RevealFocus } from "./focus-handoff";
import { HeartbeatLogPanel } from "./heartbeat-log-panel";
import { ingestCoordinates } from "./ingest-coordinates";
import { InsertedContentStopPanel } from "./insertion-stop-panel";
import { LadderPanel } from "./ladder-panel";
import { LifecycleStrip } from "./lifecycle-strip";
import { LiveAnnouncer, StatusAnnouncer } from "./live-announcer";
import { deliveryDiagnosis, selectLiveTelemetry } from "./live-telemetry";
import { LiveToVodPanel } from "./live-to-vod-panel";
import { NextActionPanel } from "./next-action-panel";
import { RunsPanel } from "./runs-panel";
import { RuntimeCapPanel } from "./runtime-cap-panel";
import { SCHEDULE_ACTION_LABEL_KEYS } from "./schedule-labels";
import { SchedulePanel } from "./schedule-panel";
import { SectionCard, SectionHelp } from "./section-card";
import { focusLiveSection, jumpToLiveSection } from "./section-focus";
import {
	LIVE_SECTION_HELP_KEYS,
	LIVE_SECTION_TITLE_KEYS,
	type LiveSectionId,
	liveBodyLayers,
	PHASE_DEFAULT_OPEN,
} from "./section-layout";
import { LiveSectionNav } from "./section-nav";
import { SlateReservationsPanel } from "./slate-reservations-panel";
import { StatusStrip } from "./status-strip";

/**
 * Live channel operator console: status + actions, copyable ingest
 * coordinates (the streamKey column is the ledgered display exception),
 * heartbeat dashboard, DVR panel and the provisioning step timeline.
 * Polls fast while transitional, slower while RUNNING (the heartbeat
 * sweep updates every 30s).
 */
/* LiveSectionNav shares one section list between the wide-screen rail and narrow-screen jump menu. Every jump focuses its target heading. Same-fragment clicks use jumpToLiveSection; other navigation uses DeepLinkFocus after hashchange because the browser default action can clear focus set in a click handler. */
/**
 * The scheduler's start grace (core's `DEFAULT_SCHEDULE_START_GRACE_MINUTES`,
 * which the worker also reads) plus one 30s sweep tick. Past this an ARMED row
 * is evidence the sweep is NOT running, not evidence of a schedule about to
 * fire.
 *
 * Known limit (review-234 I2): an installation that raises the worker's
 * `SCHEDULE_START_GRACE_MINUTES` env override moves the real deadline without
 * moving this one, so the page would call the sweep dead a little early and
 * fall back to "start it yourself" — the safe direction, and the honest fix
 * needs the effective value on the wire (an API field), which is its own
 * change.
 */
const SWEEP_GRACE_MS = (DEFAULT_SCHEDULE_START_GRACE_MINUTES * 60 + 30) * 1000;

export function ChannelDetail({
	id,
	player,
}: {
	id: string;
	player?: PlayerClientConfig;
}) {
	const { t } = useT();
	const qcVmafEnabled = useQcVmafEnabled();
	// review-260 127-A7: freshness is a function of time, but nothing
	// re-rendered when only TIME passed — a dead sweep left byte-identical
	// payloads, TanStack skips the re-render, and the stale badge never
	// appeared. One 30s tick (the sweep's own cadence) re-evaluates both the
	// predicate and the strip's age line.
	const [nowMs, setNowMs] = useState(() => Date.now());
	const [heartbeatLogOpen, setHeartbeatLogOpen] = useState(false);
	useEffect(() => {
		const id = setInterval(() => setNowMs(Date.now()), 30_000);
		return () => clearInterval(id);
	}, []);
	// review-260 127-A5 (folded here): freshness compares WORKER-stamped
	// sample times, so the comparison clock must be the server's, not the
	// viewer's. Each successful poll measures the offset between the response
	// stamp and the browser clock; the ticking nowMs is corrected by it. A
	// skewed viewer no longer reads a healthy channel as disconnected (fast clock)
	// or a frozen sample as fresh (slow clock).
	const [clockAnchor, setClockAnchor] = useState<{
		serverNow: string;
		receivedAtMs: number;
	} | null>(null);
	const channel = useQuery({
		queryKey: ["live-channel", id],
		queryFn: () => apiFetch<LiveChannelDetailRow>(`/api/live-channels/${id}`),
		refetchInterval: (query) => {
			const status = query.state.data?.status;
			if (!status) {
				return false;
			}
			if (status === "PROVISIONING" || status === "STOPPING") {
				return 5_000;
			}
			// A terminal RUN does not retire its reusable CHANNEL: a scheduler or
			// another operator can start the next airing while this page stays open.
			// Keep the normal foreground-only query default at a lower idle cadence.
			return isActiveChannelStatus(status) ? 15_000 : 30_000;
		},
	});
	// Defence in depth over the server-side DTO projection: if an ADMIN channel
	// response is still in TanStack's cache after the principal changes, do not
	// paint its bounded diagnostics until the shared session query has freshly
	// and successfully resolved the current principal. PR381 replaces this
	// direct query with the canonical useSession/useRoleAccess hook on rebase.
	const technicalSession = useQuery({
		queryKey: ["auth", "session"],
		queryFn: () => apiFetch<SessionDto>("/api/auth/session"),
		enabled: channel.data?.technicalDetailsAllowed === true,
		refetchOnMount: "always",
	});
	const serverNow = channel.data?.serverNow;
	useEffect(() => {
		if (serverNow) {
			// A 15s response can arrive between the 30s clock ticks. Rebase
			// both halves together or its fresh samples look falsely future.
			const receivedAtMs = Date.now();
			setNowMs(receivedAtMs);
			setClockAnchor({ serverNow, receivedAtMs });
		}
	}, [serverNow]);
	// Alerts : ONE query feeds the banner, the history section
	// AND the heartbeat chart's reference dots.
	const alerts = useQuery({
		queryKey: ["live-channel-alerts", id],
		queryFn: () =>
			apiFetch<{ open: ChannelAlertEvent[]; history: ChannelAlertEvent[] }>(
				`/api/live-channels/${id}/alerts`,
			),
		refetchInterval: 15_000,
	});

	// : the closed cards carry LIVE summaries, so the page needs the
	// same two lists the panels fetch. Identical query keys ⇒ TanStack serves
	// one request to both consumers; a different key here would silently double
	// the polling.
	const schedules = useQuery({
		queryKey: ["live-schedules", id],
		refetchInterval: 15_000,
		queryFn: () =>
			apiFetch<LiveScheduleDto[]>(`/api/live-channels/${id}/schedules`),
	});
	const feeders = useQuery({
		queryKey: ["feeder-sessions", id],
		// Mirror FeederPanel's own condition: observers each keep their own
		// timer and the UNION wins, so an unconditional interval here would
		// defeat the panel's "stop polling when nothing is running"
		// (review-234 N1). Active sessions ⇒ 5s, matching the panel exactly.
		refetchInterval: (query) =>
			query.state.data?.items.some((s) => isActiveFeederStatus(s.status))
				? 5_000
				: false,
		queryFn: () =>
			apiFetch<{ items: FeederSessionListItem[] }>(
				`/api/feeder-sessions?liveChannelId=${encodeURIComponent(id)}`,
			),
	});

	/**
	 * Review #348 M3: the skeleton used to lift the moment the CHANNEL row
	 * arrived, while the alerts and schedules queries were still in flight —
	 * and in that window the page rendered the pre-fix signature it exists to
	 * remove: a green `0` in the strip and `data-next-action="ON_AIR"`,
	 * because a pending query has no data either. Bounded (one round trip)
	 * but real, and it is the first thing an operator sees.
	 *
	 * The predicate is `isFetched`, NOT `isLoading`, and the difference is not
	 * cosmetic — `isLoading` here produced an infinite render loop, measured:
	 * TanStack v5's fetch reducer resets a DATALESS query's `status` to
	 * `pending` whenever it refetches, so an ERRORED schedules query goes back
	 * to `isLoading === true` the moment a second observer subscribes. That
	 * observer is `SchedulePanel`, which shares the `["live-schedules", id]`
	 * key and mounts only once this guard lets the page render — so the guard
	 * would engage, unmount the panel, resolve to error, disengage, remount
	 * the panel, and start again. (The alerts query has no second observer;
	 * `AlertPanel` takes props. That is why only the schedules arm looped.)
	 *
	 * `isFetched` is `dataUpdateCount > 0 || errorUpdateCount > 0`: false
	 * before the first settle, true for ever after — including during that
	 * refetch and during every 15s background poll. Monotonic is exactly what
	 * a one-shot "have we heard anything yet" gate needs.
	 */
	if (channel.isLoading || !alerts.isFetched || !schedules.isFetched) {
		return (
			<div
				role="status"
				aria-label={t("live.loadingChannel")}
				className="space-y-2"
			>
				{[0, 1, 2].map((i) => (
					<div key={i} className="h-16 animate-pulse rounded-md bg-zinc-900" />
				))}
			</div>
		);
	}
	if (channel.isError || !channel.data) {
		return (
			<div className="space-y-2">
				<p role="alert" className="text-red-400 text-sm">
					{t("live.channelLoadFailed")}
				</p>
				<Button
					variant="secondary"
					size="sm"
					disabled={channel.isFetching}
					onClick={() => channel.refetch()}
				>
					{t("common.retry")}
				</Button>
			</div>
		);
	}

	const row = channel.data;
	const sessionAllowsTechnicalDetails =
		technicalSession.status === "success" &&
		technicalSession.fetchStatus === "idle" &&
		!technicalSession.isRefetchError &&
		technicalSession.data.authenticated &&
		(technicalSession.data.mode === "password" ||
			(technicalSession.data.mode === "users" &&
				technicalSession.data.role === "ADMIN"));
	const technicalDetailsAllowed =
		row.technicalDetailsAllowed === true && sessionAllowsTechnicalDetails;
	//  PR2b: run-first, dual-written channel columns as fallback.
	const run = row.currentRun ?? null;
	const effectiveHeartbeat = run?.lastHeartbeat ?? row.lastHeartbeat;
	const effectiveStreamKey = run?.streamKey ?? row.streamKey;
	const effectiveEncoderIp = run?.encoderIp ?? row.encoderIp;
	const effectiveStepLog = run?.stepLog ?? row.stepLog;
	const effectiveLiveToVod = normalizeLiveToVod(
		run?.liveToVod ?? row.liveToVod,
	);
	// The DISPLAY status derives from the run — IDLE for a never-run channel
	// (the model's own word for it). Absence of a run row means "never ran"
	// ONLY when the channel column agrees (CREATED): #240's backfill gave
	// every evidence-bearing channel a run row, so a non-CREATED channel
	// without one is a legacy/cached response and shows its own status — the
	// presence-level fallback rule, applied to status.
	const displayStatus = run
		? deriveLiveChannelStatus(run.status)
		: row.status === "CREATED"
			? deriveLiveChannelStatus(null)
			: row.status;
	const plan = liveChannelPlanSchema.safeParse(row.plan);
	const entries = stepLogSchema.safeParse(effectiveStepLog);
	/**
	 * Live playback is offered only while the channel RUNS: a stopped channel's
	 * manifest still exists but nothing appends to it, so a player would stall
	 * at the last segment and report an error that is not one.
	 */
	const playable = playableLinks({
		links: row.playbackLinks ?? [],
		status: row.status === "RUNNING" ? "RUNNING" : "",
		live: true,
	});
	const playableKeys = new Set(playable.map((l) => l.key));
	const mslEdgeUrlMissing = (row.playbackLinks ?? []).some(
		(l) => l.reason?.code === "MSL_EDGE_URL_NOT_CONFIGURED",
	);
	const stepEntries = entries.success ? entries.data : [];
	// Runtime records (cues, ESAM points) are appended to the same log but are
	// not provisioning steps — counting them made a 31-step channel read
	// "34/34 steps" after three insertions (review catch).
	const provisioningEntries = stepEntries.filter(
		(entry) => !isRuntimeRecordKind(entry.kind),
	);
	const doneCount = provisioningEntries.filter(
		(e) => e.status === "DONE",
	).length;
	/* Four broadcast phases drive the contextual lead: preparation exposes ingest coordinates, provisioning shows progress, running uses StatusStrip, and finished shows the last result and restart action. Section ordering remains fixed for each phase. */
	const phase =
		displayStatus === "IDLE" || displayStatus === "CREATED"
			? "prepare"
			: displayStatus === "PROVISIONING"
				? "starting"
				: displayStatus === "RUNNING" || displayStatus === "STOPPING"
					? "onair"
					: "finished";
	// : the frozen-sample bug — the raw predicate reads only the
	// persisted sample, so a stopped channel's final CONNECTED heartbeat kept
	// the page at Connected forever. Connected NOW requires all three: a
	// status where a connection is possible, a sample that says CONNECTED,
	// and that sample young enough to vouch (3 × sweep cadence).
	const channelActive =
		displayStatus !== "IDLE" && isActiveChannelStatus(displayStatus);
	// A new query payload renders before its clock-rebase effect. Use that
	// payload's server time immediately; only add elapsed ticks to its OWN
	// anchor. Otherwise a fresh Push briefly looks future and the announcer
	// records a false stale/fresh transition even though the settled UI is green.
	const anchoredNowMs = serverNow
		? Date.parse(serverNow) +
			(clockAnchor?.serverNow === serverNow
				? Math.max(0, nowMs - clockAnchor.receivedAtMs)
				: 0)
		: nowMs;
	// Display evidence never falls through to another airing's channel mirror.
	const displayPoll = run ? run.lastHeartbeat : row.lastHeartbeat;
	const displayTelemetry = selectLiveTelemetry({
		reception: row.heartbeatReception,
		runId: run?.id ?? null,
		poll: displayPoll,
		nowMs: anchoredNowMs,
		mode: channelActive ? "live" : "finished",
	});
	const reportedOutput = deliveryDiagnosis(
		displayTelemetry,
		null,
		anchoredNowMs,
	);
	const displayIngestConnected = reportedOutput.input === "CONNECTED";
	//  (owner): the RUNNING preview must not start before output is
	// confirmed — judged WITH the origin observation, exactly as the delivery
	// status panel judges "advancing".
	const outputConfirmed =
		deliveryDiagnosis(
			displayTelemetry,
			run?.originObservation ?? null,
			anchoredNowMs,
		).output === "advancing";
	/**
	 * the PROVIDER's view of the current
	 * run's encoding, judged on the server-anchored clock (a confirmed RUNNING
	 * older than the freshness TTL is UNKNOWN, exactly as the worker judges
	 * it). UNKNOWN is what suppresses ON_AIR and paints the lifecycle strip
	 * amber; TERMINAL is what changes the ① hint from "may still be up" to
	 * "Bitmovin reported it ended — start a fresh run".
	 */
	const providerLifecycle = deriveProviderLifecycle(run ?? null, anchoredNowMs);
	const providerUnknown = providerLifecycle === "UNKNOWN";
	// UNOBSERVED does not block worker effects (the worker performs its own
	// readback before them), but it is still not evidence for a customer-facing
	// green/on-air claim. UNKNOWN and UNOBSERVED therefore share the safe UI
	// presentation while keeping their lifecycle semantics distinct.
	const providerUnconfirmed =
		providerUnknown || providerLifecycle === "UNOBSERVED";
	//  (review-331): three answers, not two. The boolean keeps every
	// existing reader's meaning (connected NOW, else not); the feeder panel
	// alone takes the tri-state, because for IT "no sample can vouch" must
	// read as unconfirmed rather than as "the encoder has not bound any input".
	const ingestKnown = ingestConnectedTriState(
		channelActive,
		effectiveHeartbeat,
		anchoredNowMs,
	);
	const ingestConnected = ingestKnown === true;
	const armed = (schedules.data ?? []).filter((r) => r.status === "ARMED");
	const nextArmed = [...armed].sort((a, b) =>
		a.fireAt.localeCompare(b.fireAt),
	)[0];
	/**
	 * Only rows that BRING THE CHANNEL UP may say "the schedule will act".
	 * The first cut of this filter excluded only STOP and reasoned that
	 * "FEEDER_START/SLATE_IN imply a running channel, so they count as
	 * starts" — review-234 I1 pointed out that implying one is exactly why
	 * they cannot PRODUCE one: the sweep refuses both unless the channel is
	 * already RUNNING, so an armed one on a stopped channel starts nothing
	 * and goes MISSED. Core owns the list.
	 */
	const armedStartCount = armed.filter((r) =>
		(CHANNEL_STARTING_SCHEDULE_ACTIONS as readonly string[]).includes(r.action),
	).length;
	/**
	 * Armed rows past the sweep's own grace: the sweep reaps due rows within
	 * a 30s tick, so these mean the worker is not running — and a dead
	 * automation must not be presented as one.
	 */
	const overdueArmedCount = armed.filter(
		(r) => Date.parse(r.fireAt) < Date.now() - SWEEP_GRACE_MS,
	).length;
	/**
	 * : fired schedules that did NOT deliver.
	 *
	 * Not a new alert metric — the audit asked only that a failed slate or
	 * feeder outcome stop being invisible above the fold, and this section
	 * header is the surface that already summarises the schedule ledger. It
	 * reads the SAME query key the panel does, so it costs no extra request.
	 */
	const failedOutcomeCount = (schedules.data ?? []).filter(
		(r) => r.status === "FIRED" && r.outcome === "FAILED",
	).length;
	// A failed refetch retains cached rows, not a verified current count.
	// Initial pending keeps the existing neutral zero (as distinct from error).
	// Retrying a first failure clears isError before data arrives; isFetched
	// retains that failed attempt, so this is not a new initial loading state.
	const feedersUnavailable =
		feeders.isError || (feeders.data === undefined && feeders.isFetched);
	const runningFeeders: number | "unknown" = feedersUnavailable
		? "unknown"
		: (feeders.data?.items ?? []).filter((s) => isActiveFeederStatus(s.status))
				.length;
	/* Use query isError for summary freshness. TanStack retains successful data after a failed background refresh, so data presence cannot establish that an alert count or schedule list is current. Keep stale detail visible with an explicit refresh error rather than reporting an empty or healthy state. */
	const alertsUnavailable = alerts.isError;
	const schedulesUnavailable = schedules.isError;
	const openAlerts: number | "unknown" = alertsUnavailable
		? "unknown"
		: (alerts.data?.open.length ?? 0);
	const nextAction = liveNextAction({
		//  PR3: the derived status — liveNextAction now speaks
		// IDLE and answers STOPPED with START_NEW_RUN (the honest verb).
		status: displayStatus,
		ingestConnected: displayIngestConnected,
		hasEncoding: row.bitmovinEncodingId !== null,
		playableCount: playable.length,
		armedStartCount,
		overdueArmedCount,
		openAlerts,
		// : a lost provider observation is never ON_AIR.
		providerUnknown: providerUnconfirmed,
	});
	/**
	 * : what is OPEN on arrival, one rule for the whole page.
	 *
	 * Three inputs, in the order §5.7 gives them: the PHASE's default set (what
	 * this situation is about), the derived next action's target (the one thing
	 * to do), and two escalations that outrank both — a CRITICAL alert and a
	 * FAILED provisioning step. All three only ever OPEN a section; nothing here
	 * can close one, because `SectionCard`'s effect is one-way and closing a
	 * card under the operator is the defect that component has already failed
	 * twice .
	 */
	const criticalOpenAlert = (alerts.data?.open ?? []).some(
		(event) => event.rule.severity === "CRIT",
	);
	const hasFailedStep = stepEntries.some((entry) => entry.status === "FAILED");
	const sectionOpen = (section: LiveSectionId) =>
		PHASE_DEFAULT_OPEN[phase].includes(section) ||
		nextAction.section === section ||
		(section === "sec-alerts" && criticalOpenAlert) ||
		(section === "sec-steps" && hasFailedStep);
	// the title-level help, read off the same table the
	// titles come from, so a section gains its help in ONE place.
	const sectionHelp = (section: LiveSectionId): string | undefined => {
		if (section === "sec-vmaf") return t("prose.captureVmafIntro");
		const key = LIVE_SECTION_HELP_KEYS[section];
		return key ? t(key) : undefined;
	};
	/**
	 * : the same two escalations, as a LIST, for the focus handoff.
	 *
	 * Only these two — not the phase default and not the next action's target.
	 * A phase default is what the page renders on arrival, and the next action
	 * moves with the channel's own lifecycle (`CONNECT_INPUT → ON_AIR` the
	 * moment ingest lands), so focusing on either would jump the caret at
	 * exactly the moment an operator is watching the channel come up. An
	 * escalation is different in kind: something went wrong that outranks what
	 * the operator was doing, which is the one case §5.7 asks to be taken to.
	 */
	const escalated: LiveSectionId[] = [
		...(criticalOpenAlert ? (["sec-alerts"] as const) : []),
		...(hasFailedStep ? (["sec-steps"] as const) : []),
	];

	/** The ingest coordinates themselves — framed twice, rendered once. */
	const ingestBody = plan.success ? (
		<ul className="space-y-2">
			{ingestCoordinates(plan.data, effectiveStreamKey, effectiveEncoderIp).map(
				(coordinate, index) => {
					const label = t(coordinate.labelKey, coordinate.labelValues);
					return (
						<li
							// index, not the label: two REDUNDANT_RTMP ingest points can
							// share an applicationName, and main collided there too
							key={`${coordinate.labelKey}-${index}`}
							className="flex items-center gap-3 rounded-md border border-zinc-800 px-3 py-2"
						>
							<span className="w-56 shrink-0 text-xs text-zinc-500">
								{label}
							</span>
							<span
								className={
									coordinate.valueKey === "feeder.staticKeyHint"
										? "min-w-0 flex-1 text-xs text-zinc-300"
										: "min-w-0 flex-1 truncate font-mono text-xs text-zinc-300"
								}
							>
								{coordinate.valueKey
									? t(coordinate.valueKey, coordinate.valueValues)
									: (coordinate.value ?? t("ingest.availableOnceRunning"))}
								{coordinate.valueKey === "feeder.staticKeyHint" ? (
									<Link
										href="/settings/live"
										className="ml-2 text-sky-300 underline"
									>
										{t("settings.streamKeys")}
									</Link>
								) : null}
							</span>
							{coordinate.hintKey ? (
								<span className="hidden max-w-64 shrink-0 text-[11px] text-zinc-600 lg:block">
									{t(coordinate.hintKey)}
								</span>
							) : null}
							{coordinate.copyable && coordinate.value !== null ? (
								<CopyButton
									value={coordinate.value}
									label={t("uiX.copyCoordinate", { label })}
								/>
							) : null}
						</li>
					);
				},
			)}
		</ul>
	) : (
		<p className="text-sm text-zinc-500">{t("live.planUnavailableHints")}</p>
	);
	const ingestSummary = plan.success ? plan.data.liveInput.kind : undefined;

	/**
	 * Sections a channel does not render AT ALL — distinct from "renders
	 * closed". The VMAF capture entry needs the deployment flag ;
	 * the last-broadcast lead needs a run to summarise.
	 */
	const omittedSections: LiveSectionId[] = [];
	if (!qcVmafEnabled) {
		omittedSections.push("sec-vmaf");
	}
	if (!run) {
		omittedSections.push("sec-last-run");
	}

	/**
	 * Every body section, keyed by id. The layers below RENDER FROM THE TABLE
	 * (`liveBodyLayers`), so the DOM order cannot drift from `section-layout.ts`
	 * — reorder the table and the page reorders with it, which is what makes
	 * the hierarchy pin in `channel-hierarchy.test.tsx` a real assertion rather
	 * than a restatement of this JSX.
	 *
	 * The `Record<LiveSectionId, ReactNode>` annotation makes a section added to
	 * the union and forgotten here a compile error. The ids rendered outside
	 * the layers (header, phase leads and delivery panel details) are `null`
	 * on purpose.
	 *
	 * An annotation rather than a trailing `satisfies`, for a reason that is not
	 * about types: the untranslated-JSX-text scanner reads a JSX-bearing object
	 * literal's tail as a text node, so `} satisfies Record<…>` renders to it as
	 * bare English inside a Japanese page. Both forms give the totality check;
	 * only this one is invisible to that instrument.
	 */
	const nodes: Record<LiveSectionId, ReactNode> = {
		"sec-actions": null,
		"sec-last-run": null,

		// Operations
		"sec-alerts": (
			<SectionCard
				key="sec-alerts"
				id="sec-alerts"
				level={3}
				title={t(LIVE_SECTION_TITLE_KEYS["sec-alerts"])}
				defaultOpen={sectionOpen("sec-alerts")}
				summary={
					openAlerts === "unknown"
						? t("status.summaryUnavailable")
						: t("status.summaryOpenAlerts", { count: openAlerts })
				}
				tone={
					openAlerts === "unknown" ? "warn" : openAlerts > 0 ? "error" : "ok"
				}
			>
				<AlertPanel
					channelId={id}
					mode="open"
					fetchError={
						alerts.isError
							? localizedCustomerError(t, alerts.error, "common.requestFailed")
							: null
					}
					open={alerts.data?.open ?? []}
					history={alerts.data?.history ?? []}
					onChanged={() => alerts.refetch()}
				/>
			</SectionCard>
		),
		"sec-manifests": (
			<SectionCard
				key="sec-manifests"
				id="sec-manifests"
				level={3}
				title={t(LIVE_SECTION_TITLE_KEYS["sec-manifests"])}
				defaultOpen={sectionOpen("sec-manifests")}
				summary={t("status.summaryLinks", {
					count: (row.playbackLinks ?? []).length,
				})}
				tone={playable.length > 0 ? "ok" : "neutral"}
			>
				{/* A running channel is the only time its manifests exist; a
				    stopped one leaves them behind but nothing writes segments,
				    so the player would stall at the last one. */}
				{/*  (owner): the VOD rail's width, and no playback until
				    the output is confirmed while RUNNING. */}
				<div className="max-w-sm">
					<PlayerPreview
						// A new airing is gated again (review-539 R1).
						key={run?.id ?? "no-run"}
						player={player}
						analyticsMeta={{
							videoId: run?.bitmovinEncodingId ?? row.id,
							title: row.name,
							customData5: row.id,
						}}
						jobId={id}
						scope="live"
						links={playable}
						live={row.status === "RUNNING"}
						autoPlay={outputConfirmed}
					/>
				</div>
				{/* The full URL list, one disclosure back (§5.7 keeps "manifest
				    summary" in the open state and "every URL" behind it). Without
				    it a channel whose output is not public showed nothing at all —
				    no URL, no path, no reason — which is every channel authored
				    before the wizard's ACL field, so it stays one click away and
				    never further. */}
				{/* rev433: the one reason with a single-field remedy is said HERE,
				    not only behind the URL disclosure — an MSL channel without an
				    edge base URL showed an empty player and nothing else. */}
				{playable.length === 0 && mslEdgeUrlMissing ? (
					<p className="mt-2 text-sm text-amber-300">
						{t("playback.reasonMslEdgeUrlNotConfigured")}
						<Link
							href="/settings/credentials"
							className="ml-1 text-emerald-400 hover:underline"
						>
							{t("playback.openCredentialSettings")}
						</Link>
					</p>
				) : null}
				<Disclosure
					id="manifest-urls"
					label={t("live.manifestUrlsDisclose")}
					closeLabel={t("live.manifestUrlsDiscloseClose")}
				>
					<ManifestList
						links={row.playbackLinks ?? []}
						playableKeys={playableKeys}
					/>
				</Disclosure>
			</SectionCard>
		),
		"sec-origin": null,
		"sec-slate": (
			<SectionCard
				key="sec-slate"
				id="sec-slate"
				level={3}
				title={t(LIVE_SECTION_TITLE_KEYS["sec-slate"])}
				help={sectionHelp("sec-slate")}
				defaultOpen={sectionOpen("sec-slate")}
			>
				<SlateReservationsPanel
					channelId={id}
					status={row.status}
					bitmovinAccountId={row.bitmovinAccountId}
				/>
			</SectionCard>
		),
		"sec-insertion-stop": (
			<SectionCard
				key="sec-insertion-stop"
				id="sec-insertion-stop"
				level={3}
				title={t(LIVE_SECTION_TITLE_KEYS["sec-insertion-stop"])}
				help={sectionHelp("sec-insertion-stop")}
				defaultOpen={sectionOpen("sec-insertion-stop")}
			>
				{/* The global stop
				    acts on whatever is PLAYING and leaves every reservation alone,
				    so it is its own confirm-gated section — never a button on top
				    of the reservation list above. */}
				<InsertedContentStopPanel
					channelId={id}
					status={row.status}
					bitmovinAccountId={row.bitmovinAccountId}
				/>
			</SectionCard>
		),

		// Programme / scheduling
		"sec-schedule": (
			<SectionCard
				key="sec-schedule"
				id="sec-schedule"
				level={3}
				title={t(LIVE_SECTION_TITLE_KEYS["sec-schedule"])}
				help={sectionHelp("sec-schedule")}
				defaultOpen={sectionOpen("sec-schedule")}
				// A schedule that fired and did not deliver outranks the next
				// armed one: the operator's next question is about the airing
				// that failed, not about tomorrow's start.
				summary={
					schedulesUnavailable
						? t("status.summaryUnavailable")
						: failedOutcomeCount > 0
							? t(
									failedOutcomeCount === 1
										? "schedule.outcomesFailedOne"
										: "schedule.outcomesFailedOther",
									{ count: failedOutcomeCount },
								)
							: nextArmed
								? t("status.summaryNextFire", {
										action: nextArmed.action,
										time: new Date(nextArmed.fireAt).toLocaleString(),
									})
								: t("status.summaryNoneArmed")
				}
				tone={
					schedulesUnavailable
						? "warn"
						: failedOutcomeCount > 0
							? "error"
							: nextArmed
								? "ok"
								: "neutral"
				}
			>
				<SchedulePanel
					channelId={id}
					status={row.status}
					bitmovinAccountId={row.bitmovinAccountId}
					programStartAt={row.programStartAt ?? null}
					programEndAt={row.programEndAt ?? null}
					ingestConnected={ingestConnected}
				/>
			</SectionCard>
		),
		"sec-insertion": (
			<SectionCard
				key="sec-insertion"
				id="sec-insertion"
				level={3}
				title={t(LIVE_SECTION_TITLE_KEYS["sec-insertion"])}
				help={sectionHelp("sec-insertion")}
				defaultOpen={sectionOpen("sec-insertion")}
			>
				<ContentInsertionPanel
					channelId={id}
					status={row.status}
					bitmovinAccountId={row.bitmovinAccountId}
					runId={run?.id ?? null}
					technicalDetailsAllowed={technicalDetailsAllowed}
					outputObservation={
						run &&
						displayTelemetry.current &&
						displayTelemetry.source !== "none"
							? {
									runId: run.id,
									source: displayTelemetry.source,
									advancing:
										reportedOutput.output === "unknown"
											? null
											: reportedOutput.output === "advancing",
								}
							: undefined
					}
					onPreview={
						playable.length > 0
							? () => {
									const target = document.getElementById("sec-manifests");
									if (target instanceof HTMLDetailsElement) target.open = true;
									window.location.hash = "sec-manifests";
									focusLiveSection("sec-manifests");
								}
							: undefined
					}
				/>
			</SectionCard>
		),
		"sec-cue": (
			<RoleAccess control="live.channel.cue">
				<SectionCard
					key="sec-cue"
					id="sec-cue"
					level={3}
					title={t(LIVE_SECTION_TITLE_KEYS["sec-cue"])}
					defaultOpen={sectionOpen("sec-cue")}
				>
					<ChannelCueForm
						channelId={id}
						status={row.status}
						stepEntries={stepEntries}
					/>
				</SectionCard>
			</RoleAccess>
		),
		"sec-esam": (
			<RoleAccess control="live.channel.esam">
				<SectionCard
					key="sec-esam"
					id="sec-esam"
					level={3}
					title={t(LIVE_SECTION_TITLE_KEYS["sec-esam"])}
					defaultOpen={sectionOpen("sec-esam")}
				>
					{/* ESAM sits beside the SCTE-35 cue form: both are ad-signalling
				    insertions into the running encoder. */}
					<EsamPanel
						channelId={id}
						status={row.status}
						bitmovinAccountId={row.bitmovinAccountId}
					/>
				</SectionCard>
			</RoleAccess>
		),

		// Input / pseudo-live
		"sec-ingest": (
			<SectionCard
				key="sec-ingest"
				id="sec-ingest"
				level={3}
				title={t(LIVE_SECTION_TITLE_KEYS["sec-ingest"])}
				help={sectionHelp("sec-ingest")}
				summary={ingestSummary}
				defaultOpen={sectionOpen("sec-ingest")}
			>
				{ingestBody}
			</SectionCard>
		),
		"sec-feeders": (
			<SectionCard
				key="sec-feeders"
				id="sec-feeders"
				level={3}
				title={t(LIVE_SECTION_TITLE_KEYS["sec-feeders"])}
				help={sectionHelp("sec-feeders")}
				defaultOpen={sectionOpen("sec-feeders")}
				summary={
					runningFeeders === "unknown"
						? t("status.summaryUnavailable")
						: t("status.summaryFeeders", { count: runningFeeders })
				}
				tone={
					runningFeeders === "unknown"
						? "warn"
						: runningFeeders > 0
							? "ok"
							: "neutral"
				}
			>
				{plan.success ? (
					<FeederPanel
						channelId={id}
						channelStatus={row.status}
						plan={plan.data}
						streamKey={effectiveStreamKey}
						encoderIp={effectiveEncoderIp}
						ingestConnected={ingestKnown}
						bitmovinAccountId={row.bitmovinAccountId}
						bitmovinEncodingId={
							run === null ? row.bitmovinEncodingId : run.bitmovinEncodingId
						}
						bitmovinEncodingPending={
							run !== null && run.bitmovinEncodingId === null
						}
					/>
				) : (
					<p className="text-sm text-zinc-500">
						{t("live.planUnavailableLadder")}
					</p>
				)}
			</SectionCard>
		),

		// Delivery / QC
		"sec-dvr": (
			<SectionCard
				key="sec-dvr"
				id="sec-dvr"
				level={3}
				title={t(LIVE_SECTION_TITLE_KEYS["sec-dvr"])}
				defaultOpen={sectionOpen("sec-dvr")}
			>
				{plan.success ? (
					<DvrPanel
						channelId={id}
						status={row.status}
						plan={plan.data}
						stepEntries={stepEntries}
					/>
				) : (
					<p className="text-sm text-zinc-500">
						{t("live.planUnavailableDvr")}
					</p>
				)}
			</SectionCard>
		),
		"sec-dns": (
			<SectionCard
				key="sec-dns"
				id="sec-dns"
				level={3}
				title={t(LIVE_SECTION_TITLE_KEYS["sec-dns"])}
				defaultOpen={sectionOpen("sec-dns")}
			>
				<ChannelDnsMappingsPanel
					channelId={id}
					status={row.status}
					bitmovinAccountId={row.bitmovinAccountId}
				/>
			</SectionCard>
		),
		"sec-live-to-vod": (
			<SectionCard
				key="sec-live-to-vod"
				id="sec-live-to-vod"
				level={3}
				title={t(LIVE_SECTION_TITLE_KEYS["sec-live-to-vod"])}
				help={sectionHelp("sec-live-to-vod")}
				defaultOpen={sectionOpen("sec-live-to-vod")}
				summary={effectiveLiveToVod?.status ?? undefined}
			>
				<LiveToVodPanel
					channelId={id}
					status={row.status}
					record={effectiveLiveToVod}
					families={row.liveToVodFamilies ?? null}
					technicalDetailsAllowed={technicalDetailsAllowed}
					onStarted={() => channel.refetch()}
				/>
				<LiveArchivePanel key={run?.id ?? "no-run"} plan={row.plan} run={run} />
			</SectionCard>
		),
		"sec-vmaf": (
			<RoleAccess control="live.channel.vmaf">
				<SectionCard
					key="sec-vmaf"
					id="sec-vmaf"
					level={3}
					title={t(LIVE_SECTION_TITLE_KEYS["sec-vmaf"])}
					help={sectionHelp("sec-vmaf")}
					defaultOpen={sectionOpen("sec-vmaf")}
				>
					<CaptureVmafPanel channelId={id} channelStatus={row.status} />
				</SectionCard>
			</RoleAccess>
		),

		// Diagnostics / history / advanced
		"sec-heartbeat": null,
		"sec-heartbeat-log": (
			<SectionCard
				key="sec-heartbeat-log"
				id="sec-heartbeat-log"
				level={3}
				title={t(LIVE_SECTION_TITLE_KEYS["sec-heartbeat-log"])}
				defaultOpen={sectionOpen("sec-heartbeat-log")}
				summary={t("heartbeatLog.summary")}
				onOpenChange={setHeartbeatLogOpen}
			>
				{/* Push receipts first; separately retained Poll history / ADMIN export. */}
				<HeartbeatLogPanel
					key={id}
					channelId={id}
					currentRunId={run?.id ?? null}
					currentRunStatus={run?.status}
					currentRunActive={run?.status === "RUNNING"}
					open={heartbeatLogOpen}
				/>
			</SectionCard>
		),
		"sec-alert-rules": (
			<SectionCard
				key="sec-alert-rules"
				id="sec-alert-rules"
				level={3}
				title={t(LIVE_SECTION_TITLE_KEYS["sec-alert-rules"])}
				defaultOpen={sectionOpen("sec-alert-rules")}
				summary={t("status.summaryResolvedAlerts", {
					count: (alerts.data?.history ?? []).length,
				})}
			>
				<AlertPanel
					channelId={id}
					mode="manage"
					open={alerts.data?.open ?? []}
					history={alerts.data?.history ?? []}
					onChanged={() => alerts.refetch()}
				/>
			</SectionCard>
		),
		"sec-runs": (
			<SectionCard
				key="sec-runs"
				id="sec-runs"
				level={3}
				title={t(LIVE_SECTION_TITLE_KEYS["sec-runs"])}
				defaultOpen={sectionOpen("sec-runs")}
				summary={t("runs.seq", { n: run?.seq ?? 0 })}
			>
				{/*  PR4 (design §5): the history a 1:1 model
				    never had — each row one encoding's lifetime. */}
				<RunsPanel
					channelId={id}
					currentRunId={run?.id ?? null}
					currentRunStatus={run?.status}
				/>
			</SectionCard>
		),
		"sec-steps": (
			<SectionCard
				key="sec-steps"
				id="sec-steps"
				level={3}
				title={t(LIVE_SECTION_TITLE_KEYS["sec-steps"])}
				summary={t("status.summaryStepsDone", {
					done: doneCount,
					total: provisioningEntries.length,
				})}
				tone={
					hasFailedStep
						? "error"
						: doneCount === provisioningEntries.length &&
								provisioningEntries.length > 0
							? "ok"
							: "neutral"
				}
				defaultOpen={sectionOpen("sec-steps")}
			>
				{entries.success ? (
					<StepTimeline entries={stepEntries} />
				) : (
					<p className="text-sm text-zinc-500">
						{t("live.stepLogUnavailable")}
					</p>
				)}
			</SectionCard>
		),
		"sec-ladder": (
			<SectionCard
				key="sec-ladder"
				id="sec-ladder"
				level={3}
				title={t(LIVE_SECTION_TITLE_KEYS["sec-ladder"])}
				summary={
					plan.success
						? t("status.summaryRenditions", {
								count: plan.data.renditions.length,
							})
						: undefined
				}
				defaultOpen={sectionOpen("sec-ladder")}
			>
				{plan.success ? (
					<LadderPanel plan={plan.data} />
				) : (
					<p className="text-sm text-zinc-500">
						{t("live.planUnavailableLadder")}
					</p>
				)}
			</SectionCard>
		),
		"sec-runtime-cap": (
			<SectionCard
				key="sec-runtime-cap"
				id="sec-runtime-cap"
				level={3}
				title={t(LIVE_SECTION_TITLE_KEYS["sec-runtime-cap"])}
				help={sectionHelp("sec-runtime-cap")}
				defaultOpen={sectionOpen("sec-runtime-cap")}
				summary={
					row.maxRunMinutes
						? t("schedule.capSummary", { minutes: row.maxRunMinutes })
						: t("schedule.capNone")
				}
			>
				<RuntimeCapPanel
					channelId={id}
					status={row.status}
					maxRunMinutes={row.maxRunMinutes ?? null}
					plan={plan.success ? plan.data : null}
					bitmovinAccountId={row.bitmovinAccountId}
					onChannelChanged={() => channel.refetch()}
				/>
			</SectionCard>
		),
		"sec-advanced": (
			<RoleAccess control="live.channel.advanced">
				<SectionCard
					key="sec-advanced"
					id="sec-advanced"
					level={3}
					title={t(LIVE_SECTION_TITLE_KEYS["sec-advanced"])}
					defaultOpen={sectionOpen("sec-advanced")}
				>
					<div className="mt-2 flex flex-wrap items-center gap-2">
						{/* Save a reusable template; copy-and-edit is in the header. */}
						<SaveAsTemplateButton
							kind="LIVE_PLAN"
							plan={row.plan}
							defaultName={row.name}
						/>
					</div>
				</SectionCard>
			</RoleAccess>
		),

		// Danger zone
		"sec-danger": (
			<RoleAccess control="live.channel.delete">
				<SectionCard
					key="sec-danger"
					id="sec-danger"
					level={3}
					title={t(LIVE_SECTION_TITLE_KEYS["sec-danger"])}
					tone="error"
					// Never phase-defaulted: deleting a channel is not what any
					// situation is "about", so the operator opens this deliberately.
					defaultOpen={false}
				>
					<ChannelDangerZone channelId={id} status={row.status} />
				</SectionCard>
			</RoleAccess>
		),
	};

	const bodyLayers = liveBodyLayers(phase, omittedSections);

	return (
		<LiveAnnouncer>
			{/* , the three handoffs that are not a click. All three mount
			    WITH the body, so "the sections exist" is a fact about where they
			    sit rather than a condition they re-derive. */}
			<DeepLinkFocus />
			<RevealFocus revealed={escalated} />
			<StatusAnnouncer
				signal={{
					// review-366 S2: RUNNING and only RUNNING. `channelActive` also
					// holds for PROVISIONING and STOPPING, so both samples stayed
					// "active" across RUNNING → STOPPING and the announcer narrated
					// the very transition its own rule exists to stay quiet for —
					// a Stop disconnects the ingest by definition.
					onAir: displayStatus === "RUNNING" && providerLifecycle === "RUNNING",
					ingestConnected: displayIngestConnected,
					heartbeatFresh: displayTelemetry.current,
					openAlerts,
				}}
			/>
			<section className="space-y-4">
				<header className="flex flex-wrap items-center gap-3">
					<h1 className="font-semibold text-xl text-zinc-50">{row.name}</h1>
					<LiveStatusBadge
						status={displayStatus}
						providerLifecycle={providerLifecycle}
					/>
					{plan.success ? (
						<span className="text-xs text-zinc-500">
							{plan.data.bitmovin.cloudRegion} · {plan.data.liveInput.kind}
						</span>
					) : null}
					<DuplicateChannelButton channelId={id} />
					{/*
: the lifecycle controls, MOVED here — not copied. They
				    used to share a button row with Duplicate and Delete inside the
				    first body section. Start and Stop are the
				    only mutations an operator reaches for while watching the strip
				    above, so they belong in the fixed header; Delete is the last
					    section on the page. Copy settings is a separate header action. `sec-actions`
				    keeps its id because core's `liveNextAction` points at it.
				*/}
					<section
						id="sec-actions"
						aria-label={t(LIVE_SECTION_TITLE_KEYS["sec-actions"])}
						// : the ONE jump target with no heading of its own, and
						// the busiest — five of the twelve next-action codes point here.
						// `focusLiveSection` falls back to the region itself, and that
						// fallback is a silent no-op without this tabindex.
						tabIndex={-1}
						className="ml-auto scroll-mt-6 outline-hidden focus-visible:ring-2 focus-visible:ring-zinc-400"
					>
						<RoleAccess control="live.channel.lifecycle">
							<ChannelLifecycleActions
								channelId={id}
								status={row.status}
								hasEncoding={row.bitmovinEncodingId !== null}
								plan={plan.success ? plan.data : undefined}
								runId={run?.id}
								generation={row.liveEffectFenceVersion}
								cancelRequested={run?.cancelRequested}
							/>
						</RoleAccess>
					</section>
				</header>

				{/* : WHERE in the encoder lifecycle the channel is. */}
				<LifecycleStrip
					// review-260 127-A12 (folded here): ONE status source — the
					// derived run-first status the rest of the page uses; IDLE is
					// the derived word for never-ran, which the strip's stages
					// spell CREATED.
					status={displayStatus === "IDLE" ? "CREATED" : displayStatus}
					ingestConnected={displayIngestConnected}
					hasEncoding={row.bitmovinEncodingId !== null}
					hasError={Boolean(row.error)}
					// : the provider's own view — amber while it cannot be
					// confirmed, and the terminal hint once Bitmovin said it ended.
					provider={{
						unknown: providerUnknown,
						unobserved: providerLifecycle === "UNOBSERVED",
						terminal: providerLifecycle === "TERMINAL",
						observedAt: run?.providerStatusObservedAt ?? null,
						unknownSince: run?.providerUnknownSince ?? null,
						status: run?.providerStatus ?? null,
					}}
				/>

				{/*  layer 1: the one thing to do next. : taking
			    it hands focus to the target's heading, so a keyboard operator
			    lands where the panel just sent the page (audit §5.6). */}
				<NextActionPanel action={nextAction} onJump={jumpToLiveSection} />

				{/* Layer 2: the monitoring line. */}
				<StatusStrip
					openAlerts={openAlerts}
					playableCount={playable.length}
					feederCount={runningFeeders}
					// : the next armed row, as a countdown, in the header —
					// a healthy RUNNING channel's next action is ON_AIR, so nothing
					// above the fold used to say a STOP was four minutes away.
					nextEvent={
						schedulesUnavailable
							? "unknown"
							: nextArmed
								? {
										label: t(SCHEDULE_ACTION_LABEL_KEYS[nextArmed.action]),
										fireAt: nextArmed.fireAt,
										slateDurationSeconds:
											nextArmed.slateDurationSeconds ?? null,
									}
								: null
					}
					runStartedAt={run?.runningSince ?? null}
					// Review of #360: the END stamp too, so a finished run's cell is
					// the frozen `endedAt − runningSince` measurement instead of a
					// figure that keeps growing for as long as the channel stays
					// stopped. The strip gates on `active`; this is what it needs to
					// have something true to say once that gate closes.
					runEndedAt={run?.endedAt ?? null}
					maxRunMinutes={row.maxRunMinutes ?? null}
					programmeHref="#layer-programme"
					// review-366 I2: this cell hands focus over like every other
					// jump on the page. Three docblocks already SAID it did while
					// it was a bare `href` with no handler at all.
					onJump={jumpToLiveSection}
					active={phase === "onair"}
					// review-260 126-A1: the ANCHORED clock — the gate and the age
					// line must read the same now, or a slow viewer clock renders
					// A stale relative timestamp can appear beside a green Connected label. The
					// strip's skewed branch thereby returns to meaning review-234
					// N4's original: a sample stamped in the future by the WORKER.
					nowMs={anchoredNowMs}
				/>

				{/* The contextual lead follows the phase: preparation and provisioning expose ingest coordinates and progress; StatusStrip leads while running; finished broadcasts lead with the last result. */}
				{phase === "prepare" || phase === "starting" ? (
					<div className="space-y-2" data-phase-lead={phase}>
						{phase === "starting" ? (
							<p className="text-xs text-zinc-400">
								{t("status.summaryStepsDone", {
									done: doneCount,
									total: provisioningEntries.length,
								})}
							</p>
						) : null}
						<FlatSection
							id="sec-ingest"
							title={t(LIVE_SECTION_TITLE_KEYS["sec-ingest"])}
							help={sectionHelp("sec-ingest")}
							summary={ingestSummary}
						>
							{ingestBody}
						</FlatSection>
					</div>
				) : null}
				{phase === "finished" && run ? (
					<FlatSection
						id="sec-last-run"
						title={t(LIVE_SECTION_TITLE_KEYS["sec-last-run"])}
						summary={t("runs.seq", { n: run.seq })}
						tone={row.error ? "error" : "neutral"}
					>
						<p className="text-sm text-zinc-300">
							{t("runs.seq", { n: run.seq })} · {run.status}
						</p>
					</FlatSection>
				) : null}
				{phase !== "prepare" ? (
					<DeliveryStatusPanel
						channelId={id}
						run={run}
						mode={phase === "finished" ? "finished" : "live"}
						phase={phase}
						lastHeartbeat={displayPoll}
						heartbeatReception={row.heartbeatReception}
						openAlerts={
							alerts.isPending || alerts.isError
								? "unknown"
								: (alerts.data?.open ?? [])
						}
						alertHistory={alerts.data?.history ?? []}
						playableCount={playable.length}
						manifestCount={(row.playbackLinks ?? []).length}
						region={plan.success ? plan.data.bitmovin.cloudRegion : null}
						encoderIp={effectiveEncoderIp}
						channelStatus={row.status}
						providerStatus={run?.providerStatus ?? null}
						providerObservedAt={run?.providerStatusObservedAt ?? null}
						nowMs={anchoredNowMs}
						detailsOpen={sectionOpen}
						detailsHelp={sectionHelp}
						onJump={jumpToLiveSection}
					/>
				) : null}
				{row.error ? (
					<p role="alert" className="text-red-400 text-sm">
						{t("live.recordedFailure")}
					</p>
				) : null}
				{row.bitmovinEncodingId ? (
					<p className="font-mono text-xs text-zinc-500">
						{t("uiX.encodingIdLine", { id: row.bitmovinEncodingId })}
					</p>
				) : null}

				{/*
			    Rows #248/#249, the body: six LAYERS in operator order, each a
			    named landmark with a visible `h2` and a one-line reason, holding
			    `h3` sections that open according to the phase. The order comes
			    from `section-layout.ts`, not from the shape of this JSX — the
			    page and its hierarchy pin read the same table.

			     added the NAVIGATION over the same table. The rail is a
			    sibling of the body, not a wrapper around it: `xl:flex-row-reverse`
			    puts the DOM-first `<nav>` in the right margin at `xl` (the layout
			    the owner picked over a sticky top bar, ) and above the
			    body below it, where it collapses to a "Jump to" button. Reversing
			    the ROW direction rather than reordering the items keeps the tab
			    sequence and the reading order identical at every width.
			*/}
				<div className="flex flex-col gap-4 xl:flex-row-reverse xl:items-start xl:gap-6">
					<LiveSectionNav layers={bodyLayers} />
					<div className="min-w-0 flex-1 space-y-4">
						{bodyLayers.map((layer) => (
							<section
								key={layer.id}
								id={layer.id}
								aria-labelledby={`${layer.id}-h`}
								className="scroll-mt-6 space-y-2"
							>
								<div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-zinc-800 border-b pt-2 pb-1">
									<h2
										id={`${layer.id}-h`}
										// : a jump target. The heading text IS the
										// announcement — nothing else is said on arrival.
										tabIndex={-1}
										className="font-semibold text-sm text-zinc-100 outline-hidden focus-visible:ring-2 focus-visible:ring-zinc-400"
									>
										{t(layer.titleKey)}
									</h2>
									{layer.helpKey ? (
										<SectionHelp
											title={t(layer.titleKey)}
											help={t(layer.helpKey)}
										/>
									) : null}
									<p className="text-xs text-zinc-500">{t(layer.leadKey)}</p>
								</div>
								{layer.sections.map((sectionId) => (
									<Fragment key={sectionId}>{nodes[sectionId]}</Fragment>
								))}
							</section>
						))}
					</div>
				</div>
			</section>
		</LiveAnnouncer>
	);
}
