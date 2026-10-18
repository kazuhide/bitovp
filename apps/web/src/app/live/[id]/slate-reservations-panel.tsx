"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { LiveChannelStatus } from "@/app/live/live-shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api";
import { RoleAccess } from "@/lib/auth/use-role-access";
import { localizedCustomerError } from "@/lib/customer-error";
import type { Locale } from "@/lib/i18n";
import { useT } from "@/lib/i18n/context";
import {
	LIST_LIMIT_MAX,
	type PageDto,
	type ScheduledContentDto,
	type ScheduledContentStatus,
} from "@/lib/live-runtime/schemas";
import { Disclosure } from "./disclosure";
import {
	parseReservationStatus,
	RESERVATION_STATUS_LABEL_KEYS,
	RESERVATION_STATUS_TONE,
	type ReservationTone,
} from "./slate-reservation-labels";

/**
 * `Badge` has no blue or muted tone of its own, so those two ride `className`
 * on the neutral tone. `ok` is unreachable from here by type — the tone table
 * (`slate-reservation-labels.ts`) has no such member.
 */
const RESERVATION_BADGE_PROPS: Record<
	ReservationTone,
	{ tone: "neutral" | "error"; className?: string }
> = {
	neutral: { tone: "neutral" },
	reserved: {
		tone: "neutral",
		className: "border-sky-800 bg-sky-950/40 text-sky-300",
	},
	// Badge text is 11px: zinc-400 over the open-card composite is 7.05:1.
	muted: { tone: "neutral", className: "border-zinc-800 text-zinc-400" },
	error: { tone: "error" },
};

/**
 * The statuses a reservation can still be cancelled FROM. A cancel offered on
 * a row that is already cancelling, cancelled or errored is a button whose
 * only outcome is a provider 4xx.
 */
const CANCELLABLE_STATUSES: ReadonlySet<ScheduledContentStatus> = new Set([
	"CREATED",
	"SCHEDULED",
]);

const RESERVATION_DATE_TIME_FORMATTERS: Record<Locale, Intl.DateTimeFormat> = {
	en: new Intl.DateTimeFormat("en", {
		dateStyle: "medium",
		timeStyle: "short",
	}),
	ja: new Intl.DateTimeFormat("ja", {
		dateStyle: "medium",
		timeStyle: "short",
	}),
};

/**
 * The reservation time is customer-facing identity, so it follows the app
 * locale rather than the browser's independent default locale. `null` keeps a
 * malformed provider timestamp visibly unknown instead of rendering an
 * `Invalid Date`; an omitted timestamp is the provider's intentional ASAP.
 */
function reservationRunAt(
	runAt: string | undefined,
	locale: Locale,
	runAsap: string,
): string | null {
	if (!runAt) {
		return runAsap;
	}
	const date = new Date(runAt);
	return Number.isNaN(date.getTime())
		? null
		: RESERVATION_DATE_TIME_FORMATTERS[locale].format(date);
}

/** The provider row, verbatim, for the technical-details disclosure. */
function rawReservationLine(item: ScheduledContentDto): string {
	const runtimeStatus = (item as { status?: unknown }).status;
	return [
		`id=${item.id}`,
		`contentId=${item.contentId ?? "-"}`,
		`status=${runtimeStatus == null ? "-" : String(runtimeStatus)}`,
		`runAt=${item.runAt ?? "-"}`,
		`durationInSeconds=${item.durationInSeconds ?? "-"}`,
	].join(" · ");
}

/**
 * A reservation action must name the content it will affect. The provider model
 * inherits an optional name through `BitmovinResource`, but rows may omit it, so
 * keep a short stable id visible and the complete id in the accessible name.
 */
function reservationIdentity(item: ScheduledContentDto): {
	primary: string;
	secondary: string | null;
	accessible: string;
} {
	const runtimeName = (item as { name?: unknown }).name;
	const name = typeof runtimeName === "string" ? runtimeName.trim() : "";
	const runtimeContentId = (item as { contentId?: unknown }).contentId;
	const id =
		typeof runtimeContentId === "string" && runtimeContentId.length > 0
			? runtimeContentId
			: item.id;
	const shortId = id.length > 8 ? `${id.slice(0, 8)}…` : id;
	return name
		? {
				primary: name,
				secondary: shortId,
				accessible: `${name} (${id})`,
			}
		: { primary: shortId, secondary: null, accessible: id };
}

/* This panel lists provider content-insertion reservations. The API has no ACTIVE status, activation time, or current-content ID, so runAt cannot establish what is playing. Per-row deletion cancels one reservation. Stopping playing content is a separate, confirmed operation and leaves reservations intact. Both insertion panels share the same query key to avoid duplicate polling. An active-content view would require independent, fresh playback evidence. */
export function SlateReservationsPanel({
	channelId,
	status,
	bitmovinAccountId,
}: {
	channelId: string;
	status: LiveChannelStatus;
	bitmovinAccountId: string | null;
}) {
	const { locale, t } = useT();
	const queryClient = useQueryClient();

	const base = `/api/live-channels/${channelId}/insertable-content`;
	const enabled = status === "RUNNING" && bitmovinAccountId !== null;
	const accountQuery = `bitmovinAccountId=${bitmovinAccountId}`;
	const scheduledKey = ["live-scheduled-content", channelId];

	const scheduled = useQuery({
		queryKey: scheduledKey,
		enabled,
		refetchInterval: 10_000,
		queryFn: () =>
			apiFetch<PageDto<ScheduledContentDto>>(
				`${base}/scheduled?${accountQuery}&limit=${LIST_LIMIT_MAX}`,
			),
	});

	const cancel = useMutation({
		mutationFn: ({
			scheduledId,
			contentId,
		}: {
			scheduledId: string;
			contentId: string;
		}) =>
			apiFetch<{ id: string }>(
				`${base}/schedule/${scheduledId}?${accountQuery}&contentId=${contentId}`,
				{ method: "DELETE" },
			),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: ["live-insertable-content", channelId],
			});
			queryClient.invalidateQueries({ queryKey: scheduledKey });
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

	const items = scheduled.data?.items ?? [];

	return (
		<div className="mt-2 space-y-3">
			<p className="text-xs text-zinc-500">{t("contentInsertion.slateLead")}</p>

			{cancel.error ? (
				<p role="alert" className="text-red-400 text-sm">
					{localizedCustomerError(
						t,
						cancel.error,
						"contentInsertion.requestFailed",
					)}
				</p>
			) : null}

			{scheduled.isLoading ? (
				<div
					role="status"
					aria-busy="true"
					aria-label={t("contentInsertion.loadingScheduled")}
					className="h-12 animate-pulse rounded-md bg-zinc-900"
				/>
			) : scheduled.isError ? (
				<p role="alert" className="text-red-400 text-sm">
					{t("uiX.failedToLoadSchedule")}
					{` ${localizedCustomerError(t, scheduled.error, "contentInsertion.requestFailed")}`}
				</p>
			) : items.length > 0 ? (
				<ul className="divide-y divide-zinc-800 rounded-md border border-zinc-800">
					{items.map((item) => {
						const runtimeStatus = (item as { status?: unknown }).status;
						const reservationStatus = parseReservationStatus(runtimeStatus);
						const badge =
							RESERVATION_BADGE_PROPS[
								reservationStatus
									? RESERVATION_STATUS_TONE[reservationStatus]
									: "neutral"
							];
						const contentId = item.contentId;
						const identity = reservationIdentity(item);
						const localizedRunAt = reservationRunAt(
							item.runAt,
							locale,
							t("contentInsertion.runAsap"),
						);
						const cancellable =
							reservationStatus !== null &&
							CANCELLABLE_STATUSES.has(reservationStatus);
						return (
							<li key={item.id} className="flex items-center gap-3 px-3 py-2">
								<Badge tone={badge.tone} className={badge.className}>
									{reservationStatus
										? t(RESERVATION_STATUS_LABEL_KEYS[reservationStatus])
										: t("contentInsertion.statusUnknown")}
								</Badge>
								<div className="min-w-0 flex-1">
									<p
										className="flex min-w-0 items-baseline gap-2 text-xs"
										title={identity.accessible}
									>
										<span className="truncate font-medium text-zinc-200">
											{identity.primary}
										</span>
										{identity.secondary ? (
											<span className="shrink-0 font-mono text-[11px] text-zinc-500">
												{identity.secondary}
											</span>
										) : null}
									</p>
									<p className="truncate text-xs text-zinc-400">
										{localizedRunAt ?? "—"}
										{item.durationInSeconds !== undefined
											? ` · ${t("contentInsertion.reservationDuration", {
													seconds: item.durationInSeconds,
												})}`
											: ""}
									</p>
								</div>
								{contentId && cancellable ? (
									<RoleAccess control="live.channel.slate">
										<Button
											variant="destructive"
											size="sm"
											disabled={cancel.isPending}
											aria-label={t("contentInsertion.descheduleNamed", {
												name: identity.accessible,
												runAt: localizedRunAt ?? t("common.unknown"),
												scheduledId: item.id,
											})}
											onClick={() =>
												cancel.mutate({ scheduledId: item.id, contentId })
											}
										>
											{t("contentInsertion.deschedule")}
										</Button>
									</RoleAccess>
								) : null}
							</li>
						);
					})}
				</ul>
			) : (
				<p role="status" className="text-sm text-zinc-500">
					{t("contentInsertion.nothingScheduled")}
				</p>
			)}

			{items.length > 0 ? (
				<Disclosure
					id="slate-technical"
					label={t("contentInsertion.technicalDisclose")}
					closeLabel={t("contentInsertion.technicalDiscloseClose")}
				>
					<p className="text-xs text-zinc-500">
						{t("contentInsertion.technicalLead")}
					</p>
					<ul className="mt-2 space-y-1 font-mono text-[11px] text-zinc-400">
						{items.map((item) => (
							<li key={item.id} className="truncate">
								{rawReservationLine(item)}
							</li>
						))}
					</ul>
				</Disclosure>
			) : null}
		</div>
	);
}
