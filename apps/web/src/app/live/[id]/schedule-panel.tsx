"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import type { LiveChannelStatus } from "@/app/live/live-shared";
import { ProgramTimeline } from "@/app/live/program-timeline";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldRowAction } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { apiFetch } from "@/lib/api";
import { RoleAccess } from "@/lib/auth/use-role-access";
import { localizedCustomerError } from "@/lib/customer-error";
import { formatDateTime } from "@/lib/format";
import type { MessageKey } from "@/lib/i18n";
import { useT } from "@/lib/i18n/context";
import { feederErrorMessage } from "@/lib/i18n/feeder-error";
import { zodIssueMessage } from "@/lib/i18n/zod-issue-message";
import {
	hasCurrentScheduleOutcomeEvidence,
	type InsertableContentDto,
	LIST_LIMIT_MAX,
	type LiveScheduleActionKind,
	type LiveScheduleDto,
	type LiveScheduleOutcomeKind,
	type LiveScheduleStatusKind,
	liveScheduleArmSchema,
	type PageDto,
} from "@/lib/live-runtime/schemas";
import { Disclosure } from "./disclosure";
import { useAnnounce } from "./live-announcer";
import {
	SCHEDULE_ACTION_LABEL_KEYS,
	SCHEDULE_OUTCOME_LABEL_KEYS,
	SCHEDULE_STATUS_LABEL_KEYS,
} from "./schedule-labels";

type Tone = "neutral" | "ok" | "warn" | "error";

/* FIRED means dispatch, not delivery, and has no success tone of its own. Excluding it from this map forces callers to derive its tone from the observed outcome. */
const STATUS_TONE: Record<Exclude<LiveScheduleStatusKind, "FIRED">, Tone> = {
	ARMED: "neutral",
	COMPLETED: "ok",
	CANCELED: "neutral",
	MISSED: "error",
	ERROR: "error",
	// : amber, not red. Refusing a row armed for a previous airing is
	// the guard WORKING; painting it as a failure would send an operator
	// looking for a fault. It is still not "ok" — a scheduled action did not
	// happen, and the note says which airing it wanted.
	SKIPPED_STALE_GENERATION: "warn",
};

/**
 * the badge TEXT.
 *
 * gave only `SKIPPED_STALE_GENERATION` a sentence and let the six
 * short statuses render their raw enum name. (HIGH-10)
 * measured what that reads like to an operator who did not write the
 * scheduler: `MISSED` as a primary state. Every status is now a catalogued
 * word — the PRIMARY — with the raw code beside it as a secondary
 * `<code>` (`statusChip` below), which is the "Japanese primary + raw code
 * secondary" shape §8.3 asks for.
 *
 * Exhaustive on purpose: a future status must make a deliberate choice here
 * instead of silently inheriting the raw name — which is exactly how
 * `program-timeline`'s untyped chain would have rendered this one as an
 * unremarkable grey tick.
 *
 * ANNOTATED rather than trailing-`satisfies`, which is the idiom the plain
 * `.ts` catalogues use: inside a `.tsx` file the untranslated-JSX scanner
 * reads a closing brace followed by a generic as a bare English text node
 * between two angle brackets. Both forms make a missing key a compile error,
 * and nothing here needs the literal types the other one would preserve.
 */
/**
 * What a fired row's DELIVERY looks like.
 *
 * Green (`ok`) is reserved for OBSERVED media: INGEST_CONNECTED (the provider's
 * encoder reports a fresh CONNECTED ingest while a feed pushes) and DELIVERED
 * (a START reached RUNNING, or a STOP was observed terminal). The in-progress
 * positives — PROCESS_PUSHING (our ffmpeg is up, provider unconfirmed) and
 * SLATE_ARMED (the provider armed an insertion we cannot witness airing) — are
 * amber: the row has moved past PENDING but has NOT earned a success colour.
 * PENDING and UNKNOWN stay amber "we cannot tell you it aired". The note
 * beneath the badge carries the distinction between same-toned states.
 */
const OUTCOME_TONE: Record<LiveScheduleOutcomeKind, Tone> = {
	PENDING: "warn",
	PROCESS_PUSHING: "warn",
	INGEST_CONNECTED: "ok",
	SLATE_ARMED: "warn",
	DELIVERED: "ok",
	FAILED: "error",
	UNKNOWN: "warn",
};

/** The sentence beside the badge — one per outcome, both catalogues. */
/**
 *  — an ARMED FEEDER_SWITCH row is one of four things, and "armed"
 * used to say only the first: SCHEDULED (its source is not staged yet),
 * STAGING (the source is being downloaded and gated), READY (staged and
 * holding — the only state that switches at fire time; anything else lands
 * MISSED, "not staged"), or STAGE_FAILED (the staged session ended or is
 * gone — this row will not switch).
 *
 * The verdict reads the SESSION the route attaches (rev367 S-2), because the
 * row's own `readyAt` is a write-once RECORD: a takeover re-stages the
 * session — its readiness cleared, the download running again — without
 * touching the record, and a chip on the record kept saying "ready to
 * switch" over a source nobody held. The row's fields are only the fallback
 * for a response that predates the join.
 */
type SwitchPhase = "SCHEDULED" | "STAGING" | "READY" | "STAGE_FAILED";

function switchPhase(row: LiveScheduleDto): SwitchPhase {
	const session = row.stagedSession;
	if (session) {
		if (session.status === "STOPPED" || session.status === "ERROR") {
			return "STAGE_FAILED";
		}
		return session.readyAt || session.committedAt ? "READY" : "STAGING";
	}
	if (session === null) {
		// The row names a session that no longer exists: it cannot switch.
		return "STAGE_FAILED";
	}
	if (row.readyAt) {
		return "READY";
	}
	return row.stagedAt ? "STAGING" : "SCHEDULED";
}

const SWITCH_PHASE_MESSAGE: Record<SwitchPhase, MessageKey> = {
	SCHEDULED: "schedule.switchScheduled",
	STAGING: "schedule.switchStaging",
	READY: "schedule.switchReady",
	STAGE_FAILED: "schedule.switchStageFailed",
};

const SWITCH_PHASE_CLASS: Record<SwitchPhase, string> = {
	SCHEDULED: "text-xs text-zinc-400",
	STAGING: "text-xs text-zinc-400",
	READY: "text-emerald-400 text-xs",
	STAGE_FAILED: "text-red-400 text-xs",
};

/**
 * An absent `outcome` reads as PENDING, never as delivered: a response from a
 * server without the column must fall to amber, which is the direction that
 * cannot invent a success.
 */
function rowTone(row: LiveScheduleDto): Tone {
	if (row.status !== "FIRED") {
		return STATUS_TONE[row.status];
	}
	const outcome = row.outcome ?? "PENDING";
	if (
		(outcome === "DELIVERED" || outcome === "INGEST_CONNECTED") &&
		!hasCurrentScheduleOutcomeEvidence(row)
	) {
		return "warn";
	}
	return OUTCOME_TONE[outcome];
}

function outcomeMessage(row: LiveScheduleDto): MessageKey {
	const outcome = row.outcome ?? "PENDING";
	return (outcome === "DELIVERED" || outcome === "INGEST_CONNECTED") &&
		!hasCurrentScheduleOutcomeEvidence(row)
		? "schedule.outcomeLegacyUnverified"
		: SCHEDULE_OUTCOME_LABEL_KEYS[outcome];
}

const SELECT_CLASS =
	"h-9 w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 text-sm text-zinc-200";

/* Arm or cancel one-shot START, STOP, and SLATE_IN schedules. Runtime limits are configured separately. Schedules can be prepared in any channel state, while slate content belongs to the current encoding and requires one. */
export function SchedulePanel({
	channelId,
	status,
	bitmovinAccountId,
	programStartAt,
	programEndAt,
	ingestConnected,
}: {
	channelId: string;
	status: LiveChannelStatus;
	bitmovinAccountId: string | null;
	/** : the creation-time slot, when the channel has one. */
	programStartAt?: string | null;
	programEndAt?: string | null;
	/**
	 * is the encoder's ingest CONNECTED right now (from the
	 * channel's last heartbeat)? An armed slate on a RUNNING channel with no
	 * input will WAIT — and the operator must hear that from the page, not
	 * discover it as a black stream at air time (the 2026-08-15 incident).
	 */
	ingestConnected?: boolean;
}) {
	const { t } = useT();
	/**
	 * The status as an operator reads it: the catalogued word in the toned
	 * `Badge`, and the raw code as a plain sibling — outside the badge, so the
	 * tone is the WORD's and a screen reader hears the word first.
	 */
	const statusChip = (row: LiveScheduleDto) => (
		<>
			<Badge tone={rowTone(row)}>
				{t(SCHEDULE_STATUS_LABEL_KEYS[row.status])}
			</Badge>
			<code className="font-mono text-[10px] text-zinc-500">{row.status}</code>
		</>
	);
	const queryClient = useQueryClient();
	const announce = useAnnounce();
	const actionId = useId();
	const fireAtId = useId();
	const airAtId = useId();
	const marginId = useId();
	const contentId = useId();
	const durationId = useId();

	const [action, setAction] = useState<LiveScheduleActionKind>("START");
	const [fireAt, setFireAt] = useState("");
	// #160 PR2: intended air time — arms the not-RUNNING-by-deadline alert.
	const [airAt, setAirAt] = useState("");
	// the arm schema accepts a per-row margin (30..3600s);
	// API-parity says the form must reach it too. Blank = the default 300.
	const [deadlineMargin, setDeadlineMargin] = useState("");
	// #160 PR3: derive fireAt from airAt − lead at arm time (server-side).
	const [autoLead, setAutoLead] = useState(false);
	const [leadResolution, setLeadResolution] = useState<{
		source: "P90" | "DEFAULT";
		leadSeconds: number;
		p90Seconds: number | null;
		n: number;
		fireAtMs: number;
	} | null>(null);
	const [slateContentId, setSlateContentId] = useState("");
	const [slateDuration, setSlateDuration] = useState("");
	const [issues, setIssues] = useState<string[]>([]);

	const schedulesKey = ["live-schedules", channelId];
	const schedules = useQuery({
		queryKey: schedulesKey,
		// The sweep runs every 30s; half that keeps FIRED/MISSED visible
		// without hammering.
		refetchInterval: 15_000,
		queryFn: () =>
			apiFetch<LiveScheduleDto[]>(`/api/live-channels/${channelId}/schedules`),
	});

	// Slate content picker: READY rows on the CURRENT encoding. Reads work on
	// non-running channels too (requireRunning=false route) — the query only
	// needs an account id.
	const contentEnabled = action === "SLATE_IN" && bitmovinAccountId !== null;
	const content = useQuery({
		queryKey: ["live-insertable-content", channelId],
		enabled: contentEnabled,
		queryFn: () =>
			apiFetch<PageDto<InsertableContentDto>>(
				`/api/live-channels/${channelId}/insertable-content?bitmovinAccountId=${bitmovinAccountId}&limit=${LIST_LIMIT_MAX}`,
			),
	});
	const readyContent = (content.data?.items ?? []).filter(
		(item) => item.status === "READY",
	);

	const arm = useMutation({
		mutationFn: (payload: unknown) =>
			apiFetch<LiveScheduleDto>(`/api/live-channels/${channelId}/schedules`, {
				method: "POST",
				body: JSON.stringify(payload),
			}),
		onSuccess: (created) => {
			const resolved = (created as { autoLead?: typeof leadResolution })
				.autoLead;
			setLeadResolution(resolved ?? null);
			setFireAt("");
			setAirAt("");
			setAutoLead(false);
			setDeadlineMargin("");
			setSlateContentId("");
			setSlateDuration("");
			queryClient.invalidateQueries({ queryKey: schedulesKey });
			//  (audit §5.6): arming succeeds by CLEARING the form and
			// letting a row appear in the list above it — visible, and silent to
			// anyone not looking at that list. The one polite region says what
			// was armed and when.
			//
			// GUARDED, and being last is not the guard. The first cut reasoned
			// that putting this after the reset and the refetch meant a response
			// missing a field would "cost the announcement and nothing else" —
			// wrong in mechanism (review-366 S3): `t(SCHEDULE_ACTION_LABEL_KEYS
			// [undefined])` THROWS, TanStack Query 5 catches a throwing
			// `onSuccess` and dispatches it as an error, and `arm.isError` then
			// renders a failure over a schedule that WAS armed. Position cannot
			// contain a throw; a condition can.
			//
			// The route returns the persisted row, so both fields are on the
			// wire — this is belt for a wire contract, not a substitute for it.
			if (created.action && created.fireAt) {
				announce(
					t("liveAnnounce.scheduleArmed", {
						action: t(SCHEDULE_ACTION_LABEL_KEYS[created.action]),
						time: formatDateTime(created.fireAt),
					}),
				);
			}
		},
	});

	const cancel = useMutation({
		mutationFn: (scheduleId: string) =>
			apiFetch<{ id: string }>(
				`/api/live-channels/${channelId}/schedules/${scheduleId}`,
				{ method: "DELETE" },
			),
		onSuccess: () => {
			announce(t("liveAnnounce.scheduleCancelled"));
			queryClient.invalidateQueries({ queryKey: schedulesKey });
		},
		// review-84b I1: the 409 race (sweep claims the row as the operator
		// clicks Cancel) is the exact case the route exists for — refetch so
		// the row's TRUE state replaces the stale ARMED immediately instead
		// of after the next poll, while the alert below says why.
		onError: () => queryClient.invalidateQueries({ queryKey: schedulesKey }),
	});

	const submitArm = () => {
		setIssues([]);
		setLeadResolution(null);
		const autoLeadActive = action === "START" && autoLead && airAt !== "";
		const date = fireAt === "" ? null : new Date(fireAt);
		if (!autoLeadActive) {
			if (!date || Number.isNaN(date.getTime())) {
				setIssues([t("schedule.invalidFireAt")]);
				return;
			}
			if (date.getTime() <= Date.now()) {
				setIssues([t("schedule.fireAtPast")]);
				return;
			}
		} else if (date !== null && Number.isNaN(date.getTime())) {
			setIssues([t("schedule.invalidFireAt")]);
			return;
		}
		const airDate = airAt === "" ? null : new Date(airAt);
		if (airAt !== "" && (!airDate || Number.isNaN(airDate.getTime()))) {
			setIssues([t("schedule.invalidAirAt")]);
			return;
		}
		const parsed = liveScheduleArmSchema.safeParse({
			action,
			...(date !== null ? { fireAt: date.toISOString() } : {}),
			...(action === "START" && airDate
				? {
						airAt: airDate.toISOString(),
						...(autoLeadActive ? { autoLeadTime: true } : {}),
						...(deadlineMargin !== ""
							? { deadlineMarginSeconds: Number(deadlineMargin) }
							: {}),
					}
				: {}),
			...(action === "SLATE_IN"
				? {
						bitmovinAccountId: bitmovinAccountId ?? undefined,
						insertableContentId: slateContentId || undefined,
						slateDurationSeconds:
							slateDuration === "" ? undefined : Number(slateDuration),
					}
				: {}),
		});
		if (!parsed.success) {
			setIssues(
				parsed.error.issues.map(
					(issue) =>
						`${issue.path.join(".") || "input"}: ${zodIssueMessage(issue, t)}`,
				),
			);
			return;
		}
		arm.mutate(parsed.data);
	};

	const rows = schedules.data ?? [];
	/* A failed schedule query must not become an empty list. TanStack retains old data after background refresh failure, so isError marks the displayed rows as stale even when data remains available. */
	const unavailable = schedules.isError;
	/** The one line, rendered in place of each section's empty-state copy. */
	const unavailableLine = (
		<p
			role="status"
			data-schedule-unavailable="true"
			className="mt-1 rounded border border-amber-700/60 bg-amber-950/30 px-2 py-1.5 text-amber-300 text-xs"
		>
			{t("status.readUnavailable")}
		</p>
	);
	const upcoming = rows
		.filter((row) => row.status === "ARMED")
		.sort((a, b) => a.fireAt.localeCompare(b.fireAt));
	const history = rows
		.filter((row) => row.status !== "ARMED")
		.sort((a, b) => b.fireAt.localeCompare(a.fireAt))
		.slice(0, 20);

	// : the map moved to `schedule-labels.ts` — the header's next-event
	// cell reads it too, and two copies would drift.
	const actionLabel = (action: LiveScheduleActionKind) =>
		t(SCHEDULE_ACTION_LABEL_KEYS[action]);

	return (
		<div className="mt-2 space-y-4">
			<p className="text-xs text-zinc-500">{t("schedule.explainer")}</p>

			{/* : an armed slate cannot display without a CONNECTED
			    input — say so while there is still time to fix the feed. */}
			{status === "RUNNING" &&
			ingestConnected === false &&
			rows.some((r) => r.action === "SLATE_IN" && r.status === "ARMED") ? (
				<p
					role="alert"
					className="rounded border border-amber-700 bg-amber-950/40 p-2 text-amber-300 text-xs"
				>
					{t("schedule.slateNeedsIngest")}
				</p>
			) : null}

			{/* Reuse the wizard timeline with observed channel events. Anchor stream-up to the earliest event or program start: creation provisions immediately and may produce no separate START row. Legacy channels retain their earlier stream-up event through the same minimum. */}
			{programStartAt && programEndAt ? (
				<ProgramTimeline
					streamUpAt={
						new Date(
							Math.min(
								...rows.map((r) => Date.parse(r.fireAt)),
								Date.parse(programStartAt),
							),
						)
					}
					programStartAt={new Date(programStartAt)}
					programEndAt={new Date(programEndAt)}
					slate={rows.some((r) => r.action === "SLATE_IN")}
					rows={rows.map((r) => ({
						action: r.action,
						status: r.status,
						// the timeline paints the OUTCOME of a
						// fired row, not a blanket FIRED-green. Absent = PENDING (the
						// direction that cannot invent a success), exactly as the
						// history list reads it.
						outcome: r.outcome ?? "PENDING",
						outcomeEvidenceVersion: r.outcomeEvidenceVersion,
						outcomeEvidenceKind: r.outcomeEvidenceKind,
						outcomeEvidenceAt: r.outcomeEvidenceAt,
						fireAt: r.fireAt,
					}))}
					now={new Date()}
				/>
			) : null}

			{/* Upcoming */}
			<div>
				<h4 className="font-medium text-xs text-zinc-300">
					{t("schedule.upcoming")}
				</h4>
				{unavailable ? unavailableLine : null}
				{schedules.isLoading ? (
					<p className="mt-1 text-xs text-zinc-500">{t("common.loading")}</p>
				) : upcoming.length === 0 ? (
					unavailable ? null : (
						<p className="mt-1 text-xs text-zinc-500">
							{t("schedule.noneUpcoming")}
						</p>
					)
				) : (
					<ul className="mt-2 space-y-2">
						{upcoming.map((row) => (
							<li
								key={row.id}
								className="flex flex-wrap items-center gap-3 rounded-md border border-zinc-800 px-3 py-2"
							>
								{statusChip(row)}
								<span className="text-sm text-zinc-200">
									{actionLabel(row.action)}
								</span>
								<span className="font-mono text-xs text-zinc-400">
									{formatDateTime(row.fireAt)}
								</span>
								{row.action === "SLATE_IN" &&
								row.slateDurationSeconds !== null ? (
									<span className="text-xs text-zinc-500">
										{t("schedule.slateDurationLine", {
											seconds: row.slateDurationSeconds,
										})}
									</span>
								) : null}
								{row.airAt ? (
									<span className="text-xs text-zinc-500">
										{t("schedule.airAtLine", {
											at: formatDateTime(row.airAt),
										})}
									</span>
								) : null}
								{row.action === "FEEDER_SWITCH" ? (
									<span
										data-switch-phase={switchPhase(row)}
										className={SWITCH_PHASE_CLASS[switchPhase(row)]}
									>
										{t(SWITCH_PHASE_MESSAGE[switchPhase(row)])}
									</span>
								) : null}
								<span className="grow" />
								<RoleAccess control="live.channel.schedule">
									<Button
										type="button"
										variant="secondary"
										onClick={() => cancel.mutate(row.id)}
										disabled={cancel.isPending && cancel.variables === row.id}
									>
										{t("schedule.cancel")}
									</Button>
								</RoleAccess>
							</li>
						))}
					</ul>
				)}
				{cancel.isError ? (
					<p role="alert" className="mt-2 text-red-400 text-xs">
						{t("schedule.cancelFailed", {
							error: localizedCustomerError(
								t,
								cancel.error,
								"common.requestFailed",
							),
						})}
					</p>
				) : null}
			</div>

			{/*
			 * the arm form is now DISCLOSED, and it used to be the
			 * first thing in this panel. The order was
			 * `arm form -> runtime cap -> cost estimate -> upcoming -> history`,
			 * so an operator asking "what fires next?" — the everyday question —
			 * scrolled past three authoring surfaces to reach the answer
			 * . Arming a one-shot is a deliberate act, taken once
			 * per broadcast; reading the upcoming rows happens every time the
			 * page is opened. The disclosure carries `aria-expanded` /
			 * `aria-controls`, so the form appearing is announced rather than
			 * merely rendered.
			 */}
			<RoleAccess control="live.channel.schedule">
				<Disclosure
					id="schedule-arm"
					label={t("schedule.armDisclose")}
					closeLabel={t("schedule.armDiscloseClose")}
				>
					<div className="rounded-md border border-zinc-800 p-3">
						<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
							<Field label={t("schedule.action")} htmlFor={actionId}>
								<select
									id={actionId}
									value={action}
									onChange={(e) =>
										setAction(e.target.value as LiveScheduleActionKind)
									}
									className={SELECT_CLASS}
								>
									<option value="START">{actionLabel("START")}</option>
									<option value="STOP">{actionLabel("STOP")}</option>
									<option value="SLATE_IN">{actionLabel("SLATE_IN")}</option>
								</select>
							</Field>
							<Field label={t("schedule.fireAt")} htmlFor={fireAtId}>
								<Input
									id={fireAtId}
									type="datetime-local"
									value={fireAt}
									onChange={(e) => setFireAt(e.target.value)}
								/>
							</Field>
							{action === "START" ? (
								<Field label={t("schedule.airAt")} htmlFor={airAtId}>
									<Input
										id={airAtId}
										type="datetime-local"
										value={airAt}
										onChange={(e) => setAirAt(e.target.value)}
									/>
								</Field>
							) : null}
							{action === "START" && airAt !== "" ? (
								<FieldRowAction>
									<label className="flex items-center gap-2 py-2 text-xs text-zinc-300">
										<input
											type="checkbox"
											checked={autoLead}
											onChange={(e) => setAutoLead(e.target.checked)}
										/>
										{t("schedule.autoLead")}
									</label>
								</FieldRowAction>
							) : null}
							{action === "START" && airAt !== "" ? (
								<Field label={t("schedule.deadlineMargin")} htmlFor={marginId}>
									<Input
										id={marginId}
										type="number"
										min={30}
										max={3600}
										value={deadlineMargin}
										onChange={(e) => setDeadlineMargin(e.target.value)}
										placeholder="300"
									/>
								</Field>
							) : null}
							{action === "SLATE_IN" ? (
								<>
									<Field label={t("schedule.content")} htmlFor={contentId}>
										<select
											id={contentId}
											value={slateContentId}
											onChange={(e) => setSlateContentId(e.target.value)}
											className={SELECT_CLASS}
										>
											<option value="">
												{content.isLoading
													? t("common.loading")
													: readyContent.length === 0
														? t("schedule.contentNoneReady")
														: t("schedule.contentPlaceholder")}
											</option>
											{readyContent.map((item) => (
												<option key={item.id} value={item.id}>
													{item.name ?? item.id}
												</option>
											))}
										</select>
									</Field>
									<Field
										label={t("schedule.durationSeconds")}
										htmlFor={durationId}
									>
										<Input
											id={durationId}
											type="number"
											min={1}
											max={86400}
											value={slateDuration}
											onChange={(e) => setSlateDuration(e.target.value)}
											placeholder="300"
										/>
									</Field>
								</>
							) : null}
						</div>
						{action === "SLATE_IN" && bitmovinAccountId === null ? (
							<p className="mt-2 text-xs text-zinc-500">
								{t("schedule.slateNeedsAccount")}
							</p>
						) : null}
						{action === "SLATE_IN" ? (
							<p className="mt-2 text-xs text-zinc-500">
								{t("schedule.slateExplainer")}
							</p>
						) : null}
						{action === "START" ? (
							<p className="mt-2 text-xs text-zinc-500">
								{t("schedule.airAtExplainer")}
							</p>
						) : null}
						{action === "START" && autoLead && airAt !== "" ? (
							<p className="mt-2 text-xs text-zinc-500">
								{t("schedule.autoLeadExplainer")}
							</p>
						) : null}
						{leadResolution ? (
							<p className="mt-2 text-emerald-400 text-xs">
								{leadResolution.source === "P90"
									? t("schedule.autoLeadResolvedP90", {
											at: formatDateTime(
												new Date(leadResolution.fireAtMs).toISOString(),
											),
											p90: leadResolution.p90Seconds ?? 0,
											n: leadResolution.n,
										})
									: t("schedule.autoLeadResolvedDefault", {
											at: formatDateTime(
												new Date(leadResolution.fireAtMs).toISOString(),
											),
											lead: leadResolution.leadSeconds,
										})}
							</p>
						) : null}
						{issues.length > 0 ? (
							<ul role="alert" className="mt-2 space-y-1">
								{issues.map((issue) => (
									<li key={issue} className="text-red-400 text-xs">
										{issue}
									</li>
								))}
							</ul>
						) : null}
						{arm.isError ? (
							<p role="alert" className="mt-2 text-red-400 text-xs">
								{localizedCustomerError(t, arm.error, "schedule.armFailed")}
							</p>
						) : null}
						<div className="mt-3">
							<Button
								type="button"
								onClick={submitArm}
								disabled={arm.isPending}
							>
								{arm.isPending ? t("schedule.arming") : t("schedule.armButton")}
							</Button>
						</div>
					</div>
				</Disclosure>
			</RoleAccess>

			<Disclosure
				id="schedule-history"
				label={t("schedule.historyDisclose")}
				closeLabel={t("schedule.historyDiscloseClose")}
			>
				<div>
					<h4 className="font-medium text-xs text-zinc-300">
						{t("schedule.history")}
					</h4>
					{unavailable ? unavailableLine : null}
					{history.length === 0 ? (
						unavailable ? null : (
							<p className="mt-1 text-xs text-zinc-500">
								{t("schedule.noneHistory")}
							</p>
						)
					) : (
						<ul className="mt-2 space-y-2">
							{history.map((row) => (
								<li
									key={row.id}
									className="flex flex-wrap items-center gap-3 rounded-md border border-zinc-900 px-3 py-2"
								>
									{statusChip(row)}
									<span className="text-sm text-zinc-300">
										{actionLabel(row.action)}
									</span>
									<span className="font-mono text-xs text-zinc-500">
										{formatDateTime(row.fireAt)}
									</span>
									{row.status === "FIRED" ? (
										<span
											className={
												rowTone(row) === "ok"
													? "text-emerald-400 text-xs"
													: rowTone(row) === "error"
														? "text-red-400 text-xs"
														: "text-amber-400 text-xs"
											}
										>
											{t(outcomeMessage(row))}
										</span>
									) : null}
									{row.status === "FIRED" && row.outcomeNote ? (
										<span className="break-words text-xs text-zinc-500">
											{row.outcomeNote}
										</span>
									) : null}
									{row.action === "FEEDER_SWITCH" &&
									row.switchSeamMs !== null &&
									row.switchSeamMs !== undefined ? (
										<span className="text-xs text-zinc-500">
											{t("schedule.switchSeam", { ms: row.switchSeamMs })}
										</span>
									) : null}
									{row.note ? (
										<span className="text-xs text-zinc-500">{row.note}</span>
									) : null}
									{row.error ? (
										// : a slate ingest-mismatch refusal is a
										// structured `{code, params}` payload — localized here;
										// every other schedule error is a plain string, rendered
										// verbatim by the same helper.
										<span className="break-words text-red-400 text-xs">
											{feederErrorMessage(t, row.error)}
										</span>
									) : null}
								</li>
							))}
						</ul>
					)}
				</div>
			</Disclosure>
		</div>
	);
}
