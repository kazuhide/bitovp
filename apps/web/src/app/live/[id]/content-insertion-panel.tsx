"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import type { LiveChannelStatus } from "@/app/live/live-shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { HelpOverlay } from "@/components/ui/help-overlay";
import { Input } from "@/components/ui/input";
import { apiFetch } from "@/lib/api";
import { RoleAccess } from "@/lib/auth/use-role-access";
import { localizedCustomerError } from "@/lib/customer-error";
import type { MessageKey } from "@/lib/i18n";
import { useT } from "@/lib/i18n/context";
import { zodIssueMessage } from "@/lib/i18n/zod-issue-message";
import {
	type InsertableContentDto,
	type InsertableContentStatus,
	LIST_LIMIT_MAX,
	type PageDto,
	type ScheduledContentDto,
	type SlateNormalizationDto,
	type SlateNormalizationStatus,
	scheduleContentCreateSchema,
} from "@/lib/live-runtime/schemas";
import { SlateRegisterForm } from "./slate-register-form";
import {
	parseReservationStatus,
	RESERVATION_STATUS_LABEL_KEYS,
} from "./slate-reservation-labels";

type ContentInsertionPanelProps = {
	channelId: string;
	status: LiveChannelStatus;
	bitmovinAccountId: string | null;
	runId?: string | null;
	/** Already freshness-selected by the delivery panel; never a content witness. */
	outputObservation?: {
		runId: string;
		source: "push" | "poll";
		advancing: boolean | null;
	};
	/** Supplied only when the parent's existing preview eligibility permits it. */
	onPreview?: () => void;
	/**
	 * : the server-authorized ADMIN disclosure. A failed conversion's
	 * raw reason (ffmpeg's last lines, a storage refusal) is technical text and
	 * shows only under it; everyone else reads the localized outcome.
	 */
	technicalDetailsAllowed?: boolean;
};

const CONTENT_TONE: Record<
	InsertableContentStatus,
	"neutral" | "ok" | "error"
> = {
	CREATED: "neutral",
	DOWNLOADING: "neutral",
	READY: "ok",
	ERROR: "error",
};

/** : the worker's registration states, in the operator's words. */
const NORMALIZATION_LABEL: Record<SlateNormalizationStatus, MessageKey> = {
	WAITING_FOR_INPUT: "contentInsertion.normStatusWaiting",
	QUEUED: "contentInsertion.normStatusQueued",
	NORMALIZING: "contentInsertion.normStatusNormalizing",
	REGISTERING: "contentInsertion.normStatusRegistering",
	READY: "contentInsertion.normStatusReady",
	ERROR: "contentInsertion.normStatusError",
};
const NORMALIZATION_TONE: Record<
	SlateNormalizationStatus,
	"neutral" | "ok" | "warn" | "error"
> = {
	WAITING_FOR_INPUT: "warn",
	QUEUED: "neutral",
	NORMALIZING: "neutral",
	REGISTERING: "neutral",
	READY: "ok",
	ERROR: "error",
};

/**
 * Scheduled content insertion, AUTHORING half: register media once (Bitmovin
 * downloads it — CREATED → DOWNLOADING → READY), then schedule a READY item to
 * play instead of the live feed.
 *
 * READY is REGISTERED, not playable (C36): the provider checks the clip
 * against the live stream at insert time, not at registration. Registration
 * therefore goes through `SlateRegisterForm` — pick the file, check it against
 * the ingest, then register — and the list says what READY means.
 *
 *  moved the other half — the scheduled queue and the global stop —
 * out of here into the Operations layer;  then split THAT in two,
 * because the queue is a list of reservations and the stop acts on whatever
 * is playing: `SlateReservationsPanel` (the queue, cancelled per row) and
 * `InsertedContentStopPanel` (the confirm-gated emergency stop). This panel
 * stays preparation. All three share the query keys, so the split costs no
 * extra request, and no control exists twice.
 *
 * RUNNING-gated: registering and scheduling both 409 on a non-running channel,
 * so the whole panel collapses to an explanation instead.
 */
export function ContentInsertionPanel(props: ContentInsertionPanelProps) {
	// Also discards a late response from a previous airing: its mutation observer
	// is unmounted, not reused for the new run's form or acceptance feedback.
	return (
		<ContentInsertionForm
			key={`${props.channelId}:${props.bitmovinAccountId}:${props.runId ?? "unbound"}`}
			{...props}
		/>
	);
}

function ContentInsertionForm({
	channelId,
	status,
	bitmovinAccountId,
	runId,
	outputObservation,
	onPreview,
	technicalDetailsAllowed = false,
}: ContentInsertionPanelProps) {
	const { t } = useT();
	const queryClient = useQueryClient();
	const [scheduleFor, setScheduleFor] = useState<string | null>(null);
	const [runAt, setRunAt] = useState("");
	const [duration, setDuration] = useState("");
	const [issues, setIssues] = useState<string[]>([]);
	const [accepted, setAccepted] = useState<{
		contentId: string;
		reservation: ScheduledContentDto;
	} | null>(null);
	const scheduleRequest = useRef<{
		fingerprint: string;
		requestId: string;
	} | null>(null);

	const base = `/api/live-channels/${channelId}/insertable-content`;
	const enabled = status === "RUNNING" && bitmovinAccountId !== null;
	const accountQuery = `bitmovinAccountId=${bitmovinAccountId}`;

	const contentKey = ["live-insertable-content", channelId];
	const scheduledKey = ["live-scheduled-content", channelId];
	const normalizationsKey = ["live-slate-normalizations", channelId];

	const content = useQuery({
		queryKey: contentKey,
		enabled,
		// Downloads finish asynchronously — poll so CREATED→READY appears.
		refetchInterval: 10_000,
		queryFn: () =>
			apiFetch<PageDto<InsertableContentDto>>(
				`${base}?${accountQuery}&limit=${LIST_LIMIT_MAX}`,
			),
	});

	// : registrations the worker is still converting or waiting on.
	// Polled like the content list, because the states change without us.
	const normalizations = useQuery({
		queryKey: normalizationsKey,
		enabled,
		refetchInterval: 10_000,
		queryFn: () =>
			apiFetch<{ items: SlateNormalizationDto[] }>(`${base}/normalizations`),
	});

	const invalidateAll = () => {
		queryClient.invalidateQueries({ queryKey: contentKey });
		queryClient.invalidateQueries({ queryKey: scheduledKey });
		queryClient.invalidateQueries({ queryKey: normalizationsKey });
	};

	const schedule = useMutation({
		mutationFn: (payload: {
			contentId: string;
			runAt?: string;
			durationInSeconds?: number;
		}) => {
			const fingerprint = JSON.stringify(payload);
			if (scheduleRequest.current?.fingerprint !== fingerprint) {
				scheduleRequest.current = {
					fingerprint,
					requestId: crypto.randomUUID(),
				};
			}
			return apiFetch<ScheduledContentDto>(`${base}/schedule`, {
				method: "POST",
				body: JSON.stringify({
					bitmovinAccountId,
					requestId: scheduleRequest.current.requestId,
					schedule: payload,
				}),
			});
		},
		onSuccess: (reservation, payload) => {
			if (runId) setAccepted({ contentId: payload.contentId, reservation });
			scheduleRequest.current = null;
			setScheduleFor(null);
			setRunAt("");
			setDuration("");
			invalidateAll();
		},
	});

	if (status !== "RUNNING") {
		return (
			<p className="mt-2 text-sm text-zinc-500">
				{t("contentInsertion.needsRunning")}
			</p>
		);
	}
	if (!bitmovinAccountId) {
		return (
			<p className="mt-2 text-sm text-zinc-500">
				{t("prose.contentNoAccount")}
			</p>
		);
	}

	const submitSchedule = (contentId: string) => {
		setIssues([]);
		let iso: string | undefined;
		if (runAt !== "") {
			const date = new Date(runAt);
			if (Number.isNaN(date.getTime())) {
				//  (UX-02e): was a hard-coded English sentence that
				// rendered inside the Japanese page.
				setIssues([t("contentInsertion.runAtInvalid")]);
				return;
			}
			iso = date.toISOString();
		}
		const parsed = scheduleContentCreateSchema.safeParse({
			contentId,
			...(iso ? { runAt: iso } : {}),
			...(duration !== "" ? { durationInSeconds: Number(duration) } : {}),
		});
		if (!parsed.success) {
			setIssues(
				parsed.error.issues.map(
					(issue) =>
						`${issue.path.join(".") || "schedule"}: ${zodIssueMessage(issue, t)}`,
				),
			);
			return;
		}
		schedule.mutate(parsed.data);
	};

	const mutationError = schedule.error;
	const contentItems = content.data?.items ?? [];
	// READY rows are in the provider list by now; what remains is in flight
	// or failed, which is what the operator needs to see here.
	const pendingNormalizations = (normalizations.data?.items ?? []).filter(
		(row): row is SlateNormalizationDto =>
			typeof row?.status === "string" &&
			row.status in NORMALIZATION_LABEL &&
			row.status !== "READY",
	);
	const reservationStatus = parseReservationStatus(
		accepted?.reservation.status,
	);
	const output =
		outputObservation?.runId === runId ? outputObservation : undefined;

	return (
		<div className="mt-2 space-y-4">
			{accepted ? (
				<div
					role="status"
					aria-label={t("contentInsertion.feedbackAccepted")}
					className="space-y-1 border-l-2 border-amber-600 pl-3 text-xs text-zinc-300"
				>
					<p className="font-medium">
						{t("contentInsertion.feedbackAccepted")}
					</p>
					<p className="break-all">
						{t("contentInsertion.feedbackIdentity", {
							contentId: accepted.contentId,
							reservationId: accepted.reservation.id ?? t("common.unknown"),
						})}
					</p>
					<p>
						{t("contentInsertion.feedbackProvider", {
							status: t(
								reservationStatus
									? RESERVATION_STATUS_LABEL_KEYS[reservationStatus]
									: "contentInsertion.statusUnknown",
							),
						})}
					</p>
					<p>
						{output?.advancing == null
							? t("contentInsertion.feedbackOutputUnknown")
							: t(
									output.advancing
										? "contentInsertion.feedbackOutputAdvancing"
										: "contentInsertion.feedbackOutputNotAdvancing",
									{ source: output.source === "push" ? "Push" : "Poll" },
								)}
					</p>
					<p className="text-amber-300">
						{t("contentInsertion.feedbackUnconfirmed")}
					</p>
					{onPreview ? (
						<Button variant="secondary" size="sm" onClick={onPreview}>
							{t("contentInsertion.feedbackPreview")}
						</Button>
					) : null}
				</div>
			) : null}

			{issues.length > 0 ? (
				<ul role="alert" className="space-y-0.5 text-red-400 text-xs">
					{issues.map((issue) => (
						<li key={issue}>{issue}</li>
					))}
				</ul>
			) : null}
			{mutationError ? (
				<p role="alert" className="text-red-400 text-sm">
					{localizedCustomerError(
						t,
						mutationError,
						"contentInsertion.requestFailed",
					)}
				</p>
			) : null}

			{pendingNormalizations.length > 0 ? (
				<fieldset className="m-0 border-0 p-0">
					<legend className="font-medium text-xs text-zinc-300">
						{t("contentInsertion.normalizationsTitle")}
					</legend>
					<p className="mt-1 text-xs text-zinc-500">
						{t("contentInsertion.normalizationsLead")}
					</p>
					<ul className="mt-2 divide-y divide-zinc-800 rounded-md border border-zinc-800">
						{pendingNormalizations.map((row) => (
							<li key={row.id} className="px-3 py-2">
								<div className="flex flex-wrap items-center gap-2">
									<span className="font-medium text-sm text-zinc-100">
										{row.name || row.sourceKey.split("/").pop() || row.id}
									</span>
									<Badge tone={NORMALIZATION_TONE[row.status]}>
										{t(NORMALIZATION_LABEL[row.status])}
									</Badge>
								</div>
								<p className="mt-0.5 truncate font-mono text-[11px] text-zinc-500">
									{row.bucket}/{row.sourceKey}
								</p>
								{row.status === "ERROR" ? (
									<p role="alert" className="mt-1 text-red-300 text-xs">
										{t("contentInsertion.normFailed")}
										{technicalDetailsAllowed && row.error ? (
											<span className="ml-1 font-mono text-zinc-400">
												{" "}
												{row.error}
											</span>
										) : null}
									</p>
								) : technicalDetailsAllowed && row.note ? (
									<p className="mt-1 font-mono text-xs text-zinc-500">
										{row.note}
									</p>
								) : null}
							</li>
						))}
					</ul>
				</fieldset>
			) : null}

			<section>
				<div className="flex items-center gap-1.5">
					<h4 className="font-medium text-xs text-zinc-300">
						{t("contentInsertion.registered")}
					</h4>
					<HelpOverlay labelFor={t("contentInsertion.registered")}>
						<p>{t("prose.contentIntro")}</p>
						<p>{t("ui.aMovieFileNeedsItsVideoStream")}</p>
					</HelpOverlay>
				</div>
				<p className="mt-1 text-xs text-zinc-500">
					{t("contentInsertion.readyMeansRegistered")}
				</p>
				{content.isLoading ? (
					<div
						role="status"
						aria-busy="true"
						aria-label={t("contentInsertion.loadingInsertable")}
						className="mt-2 h-14 animate-pulse rounded-md bg-zinc-900"
					/>
				) : content.isError ? (
					<p role="alert" className="mt-2 text-red-400 text-sm">
						{t("uiX.failedToLoadRegisteredContent")}
						{content.error
							? `: ${localizedCustomerError(t, content.error, "contentInsertion.requestFailed")}`
							: t("common.sentenceEnd")}
					</p>
				) : contentItems.length > 0 ? (
					<ul className="mt-2 divide-y divide-zinc-800 rounded-md border border-zinc-800">
						{contentItems.map((item) => (
							<li key={item.id} className="px-3 py-2">
								<div className="flex flex-wrap items-center gap-2">
									<span className="font-medium text-sm text-zinc-100">
										{item.name || item.id}
									</span>
									{item.status ? (
										<Badge tone={CONTENT_TONE[item.status]}>
											{item.status}
										</Badge>
									) : null}
									<RoleAccess control="live.channel.content-insertion">
										{item.status === "READY" ? (
											<Button
												variant="secondary"
												size="sm"
												onClick={() =>
													setScheduleFor(
														scheduleFor === item.id ? null : item.id,
													)
												}
											>
												{t("contentInsertion.schedule")}
											</Button>
										) : null}
									</RoleAccess>
								</div>
								<p className="mt-0.5 truncate font-mono text-[11px] text-zinc-500">
									{item.inputs?.map((i) => i.inputPath).join(", ")}
								</p>
								<RoleAccess control="live.channel.content-insertion">
									{scheduleFor === item.id ? (
										<div className="mt-2 grid grid-cols-1 gap-2 rounded-md border border-zinc-800 p-2 sm:grid-cols-2">
											<Field
												label={t("contentInsertion.runAt")}
												htmlFor={`sched-runat-${item.id}`}
												help={t("ui.localTimeSentAsUtc")}
											>
												<Input
													id={`sched-runat-${item.id}`}
													type="datetime-local"
													value={runAt}
													onChange={(e) => setRunAt(e.target.value)}
												/>
											</Field>
											<Field
												label={t("contentInsertion.durationSeconds")}
												htmlFor={`sched-duration-${item.id}`}
												help={t(
													"ui.requiredForImageContentTruncatesLoopsMovies",
												)}
												trailing={
													<Button
														size="sm"
														disabled={schedule.isPending}
														onClick={() => submitSchedule(item.id)}
													>
														{schedule.isPending
															? t("contentInsertion.scheduling")
															: t("common.confirm")}
													</Button>
												}
											>
												<Input
													id={`sched-duration-${item.id}`}
													type="number"
													min={1}
													value={duration}
													onChange={(e) => setDuration(e.target.value)}
												/>
											</Field>
										</div>
									) : null}
								</RoleAccess>
							</li>
						))}
					</ul>
				) : (
					<p role="status" className="mt-2 text-sm text-zinc-500">
						{t("contentInsertion.noneRegistered")}
					</p>
				)}
			</section>

			<RoleAccess control="live.channel.content-insertion">
				<SlateRegisterForm
					channelId={channelId}
					bitmovinAccountId={bitmovinAccountId}
					onRegistered={invalidateAll}
				/>
			</RoleAccess>
		</div>
	);
}
