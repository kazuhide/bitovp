"use client";

import { classifyProviderStatusWord } from "@bitovp/core";
import type { LiveChannelStatus } from "@/app/live/live-shared";
import { HelpOverlay } from "@/components/ui/help-overlay";
import { formatDateTime } from "@/lib/format";
import { useT } from "@/lib/i18n/context";

/* Show the current encoder stage and observed input. A connection can return to waiting. */

export type LifecycleStage = 1 | 2 | 3 | 4 | 7;

export function lifecycleStage(
	status: LiveChannelStatus,
	ingestConnected: boolean | null,
): LifecycleStage {
	if (status === "CREATED" || status === "ERROR") {
		return 1;
	}
	if (status === "PROVISIONING") {
		return 2;
	}
	if (status === "RUNNING") {
		return ingestConnected ? 4 : 3;
	}
	// STOPPING / STOPPED and anything terminal.
	return 7;
}

const STAGE_DEFS = [
	{ n: 1, labelKey: "lifecycle.s1", hintKey: "lifecycle.s1Hint" },
	{ n: 2, labelKey: "lifecycle.s2", hintKey: "lifecycle.s2Hint" },
	{ n: 3, labelKey: "lifecycle.s3", hintKey: "lifecycle.s3Hint" },
	{ n: 4, labelKey: "lifecycle.s4", hintKey: "lifecycle.s4Hint" },
	{ n: 7, labelKey: "lifecycle.s7", hintKey: "lifecycle.s7Hint" },
] as const;

/**
 * the PROVIDER's view of the current
 * run's encoding, as the page derives it from the run columns.
 */
export type ProviderLifecycleView = {
	/** The status read is failing or stale. */
	unknown: boolean;
	/** No provider read has landed for this run yet. */
	unobserved?: boolean;
	/** Bitmovin reported that this run's own encoder ended. */
	terminal: boolean;
	/** ISO of the last SUCCESSFUL readback; null = never confirmed. */
	observedAt: string | null;
	/** ISO when the unknown window opened; null = confirmed. */
	unknownSince: string | null;
	/** The provider's last word (FINISHED, ERROR, …) for the terminal hint. */
	status: string | null;
};

export function LifecycleStrip({
	status,
	ingestConnected,
	monitoringAllowed = true,
	hasEncoding,
	hasError = false,
	provider,
}: {
	status: LiveChannelStatus;
	/** null means this run has no input connection observation. */
	ingestConnected: boolean | null;
	monitoringAllowed?: boolean;
	/**
	 * review-228 I3: an ERROR channel can still have an encoder up on
	 * Bitmovin (canStop exists for exactly that) — the ① hint must not
	 * assert "not running" beside a live Stop button. REQUIRED (review-228
	 * B1): an optional-with-default let the wiring be deleted silently —
	 * the same unguarded-prop shape as I1, one prop over; a compile error
	 * is the backstop the status typing already bought.
	 */
	hasEncoding: boolean;
	/** A STOPPED row carrying an error is a stop Bitmovin never confirmed. */
	hasError?: boolean;
	/**
	 * optional so callers without a run view (and every pre-#280
	 * test) render exactly as before; absent = not unknown, not terminal.
	 */
	provider?: ProviderLifecycleView;
}) {
	const { t } = useT();
	const providerTerminal = provider?.terminal === true;
	const inputUnavailable =
		!providerTerminal && status === "RUNNING" && !monitoringAllowed;
	const active = providerTerminal
		? 7
		: inputUnavailable
			? null
			: lifecycleStage(status, ingestConnected);
	const visibleStages = providerTerminal ? STAGE_DEFS.slice(-1) : STAGE_DEFS;
	const showTimelineOnSmallScreens =
		status === "CREATED" || status === "PROVISIONING";
	const activeDef = STAGE_DEFS.find((s) => s.n === active);
	const inputUnobserved =
		!providerTerminal &&
		status === "RUNNING" &&
		monitoringAllowed &&
		ingestConnected === null;
	const providerUnknown = !providerTerminal && provider?.unknown === true;
	// A terminal legacy row is historical, not waiting for a future poll.
	const providerUnobserved =
		hasEncoding &&
		!providerTerminal &&
		provider?.unobserved === true &&
		(status !== "STOPPED" || hasError);
	const providerWord = classifyProviderStatusWord(provider?.status);
	const providerTransitional =
		status === "RUNNING" && providerWord === "TRANSITIONAL";
	const activeUnconfirmed =
		providerUnknown ||
		providerUnobserved ||
		providerTransitional ||
		inputUnobserved;
	// review-2 on #268: a STOPPED channel whose stop never CONFIRMED is more
	// exactly the population this hint describes than an ERROR one is — the
	// evidence there is positive and recorded , while ERROR
	// is merely ambiguous. Without this the reset blocks on those rows and
	// explains why, while the channel's own page — where the operator actually
	// goes — showed the raw error string and neither the framing nor the
	// action.
	const errorWithEncoder =
		hasEncoding && (status === "ERROR" || (status === "STOPPED" && hasError));
	// Keep the provider observation and its timestamp in the stage help.
	const hint = providerUnobserved
		? t("lifecycle.providerUnobservedHint")
		: providerUnknown || providerTransitional
			? provider?.status && provider.observedAt && providerWord !== "UNKNOWN"
				? t("lifecycle.providerUnknownHint", {
						status: provider.status,
						at: formatDateTime(provider.observedAt),
						unavailableSince: provider.unknownSince
							? t("lifecycle.providerUnavailableSince", {
									since: formatDateTime(provider.unknownSince),
								})
							: "",
					})
				: t("lifecycle.providerUnobservedHint")
			: providerTerminal
				? provider.status &&
					classifyProviderStatusWord(provider.status) === "TERMINAL"
					? t("lifecycle.providerTerminalHint", {
							status: provider.status,
							at: provider.observedAt
								? formatDateTime(provider.observedAt)
								: t("lifecycle.providerUnknownNever"),
						})
					: t("lifecycle.s7Hint")
				: errorWithEncoder
					? t("lifecycle.s1ErrorHint")
					: inputUnobserved || inputUnavailable
						? t("lifecycle.inputUnobservedHint")
						: t(activeDef?.hintKey ?? "lifecycle.s1Hint");
	return (
		<figure
			aria-label={t("lifecycle.aria")}
			className="flex flex-wrap items-center gap-x-2 gap-y-1"
			data-provider={
				providerUnobserved
					? "unobserved"
					: providerUnknown
						? "unknown"
						: providerTerminal
							? "terminal"
							: undefined
			}
		>
			{inputUnavailable ? (
				<span className="text-xs text-zinc-400">
					{t("lifecycle.inputUnavailable")}
				</span>
			) : (
				<ol className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
					{visibleStages.map((stage) => {
						const state =
							stage.n === active
								? "active"
								: active !== null && stage.n < active
									? "past"
									: "future";
						return (
							<li
								key={stage.n}
								data-stage={stage.n}
								data-state={state}
								aria-current={state === "active" ? "step" : undefined}
								className={`${state === "active" || showTimelineOnSmallScreens ? "flex" : "hidden sm:flex"} items-center gap-1.5`}
							>
								<span
									aria-hidden
									className={`size-1.5 shrink-0 rounded-full ${
										state === "active" && !activeUnconfirmed
											? "bg-sky-400"
											: state === "future"
												? "border border-zinc-500"
												: "bg-zinc-500"
									}`}
								/>
								<span
									className={
										state === "active"
											? activeUnconfirmed
												? "font-medium text-zinc-200"
												: "font-medium text-sky-300"
											: "text-zinc-400"
									}
								>
									{t(
										inputUnobserved && stage.n === 3
											? "lifecycle.inputUnobserved"
											: stage.n === 7 &&
													status === "STOPPING" &&
													!providerTerminal
												? "nextAction.stoppingTitle"
												: stage.labelKey,
									)}
								</span>
							</li>
						);
					})}
				</ol>
			)}
			<figcaption className="text-xs text-zinc-400">
				<HelpOverlay labelFor={t("lifecycle.aria")}>{hint}</HelpOverlay>
			</figcaption>
		</figure>
	);
}
