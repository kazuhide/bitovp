"use client";

import type { LiveChannelStatus } from "@/app/live/live-shared";
import { HelpOverlay } from "@/components/ui/help-overlay";
import { formatDateTime } from "@/lib/format";
import { useT } from "@/lib/i18n/context";

/* Present the encoder lifecycle as start, instance boot, ingest waiting, connected input, encoding, output, and stop. Pure rendering depends on status, ingest connection, and encoding presence. Timing hints must identify measured samples and must not invent estimates for unmeasured stages. */

export type LifecycleStage = 1 | 2 | 3 | 4 | 7;

export function lifecycleStage(
	status: LiveChannelStatus,
	ingestConnected: boolean,
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
 *  (audit 5c3d97ca BLOCKER-1): the PROVIDER's view of the current
 * run's encoding, as the page derives it from the run columns.
 */
export type ProviderLifecycleView = {
	/** The status read is failing / stale — amber, never green. */
	unknown: boolean;
	/** No provider read has landed for this run yet — amber, never green. */
	unobserved?: boolean;
	/** Bitmovin reported the encoding ended — the ① hint changes. */
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
	hasEncoding,
	hasError = false,
	provider,
}: {
	status: LiveChannelStatus;
	ingestConnected: boolean;
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
	 * : optional so callers without a run view (and every pre-#280
	 * test) render exactly as before; absent = not unknown, not terminal.
	 */
	provider?: ProviderLifecycleView;
}) {
	const { t } = useT();
	const active = lifecycleStage(status, ingestConnected);
	const activeDef = STAGE_DEFS.find((s) => s.n === active);
	const providerUnknown = provider?.unknown === true;
	// A terminal legacy row is historical, not waiting for a future poll.
	const providerUnobserved =
		provider?.unobserved === true && (status !== "STOPPED" || hasError);
	const providerUnconfirmed = providerUnknown || providerUnobserved;
	const providerTerminal = provider?.terminal === true;
	// review-2 on #268: a STOPPED channel whose stop never CONFIRMED is more
	// exactly the population this hint describes than an ERROR one is — the
	// evidence there is positive and recorded , while ERROR
	// is merely ambiguous. Without this the reset blocks on those rows and
	// explains why, while the channel's own page — where the operator actually
	// goes — showed the raw error string and neither the framing nor the
	// action.
	const errorWithEncoder =
		hasEncoding && (status === "ERROR" || (status === "STOPPED" && hasError));
	/**
	 * : the provider's view outranks the stage hint. UNKNOWN paints the
	 * active stage AMBER (the audit's invariant: a lost observation on a
	 * RUNNING channel is never shown as confirmed green/on-air) and says so,
	 * with the last successful reading and the window's start. A provider-
	 * TERMINAL error run gets the terminal hint instead of "may still be up
	 * on Bitmovin" — Bitmovin has said it is not.
	 */
	const hint = providerUnobserved
		? t("lifecycle.providerUnobservedHint")
		: providerUnknown
			? t("lifecycle.providerUnknownHint", {
					at: provider?.observedAt
						? formatDateTime(provider.observedAt)
						: t("lifecycle.providerUnknownNever"),
					since: provider?.unknownSince
						? formatDateTime(provider.unknownSince)
						: t("lifecycle.providerUnknownNever"),
				})
			: errorWithEncoder && providerTerminal
				? t("lifecycle.providerTerminalHint", {
						status: provider?.status ?? "FINISHED",
						at: provider?.observedAt
							? formatDateTime(provider.observedAt)
							: t("lifecycle.providerUnknownNever"),
					})
				: errorWithEncoder
					? t("lifecycle.s1ErrorHint")
					: t(activeDef?.hintKey ?? "lifecycle.s1Hint");
	return (
		<figure
			aria-label={t("lifecycle.aria")}
			className="space-y-1"
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
			<ol className="flex flex-wrap items-center gap-1 text-xs">
				{STAGE_DEFS.map((stage, i) => {
					const state =
						stage.n === active
							? "active"
							: stage.n < active
								? "past"
								: "future";
					return (
						<li
							key={stage.n}
							data-stage={stage.n}
							data-state={state}
							className="flex items-center gap-1"
						>
							{i > 0 ? <span className="text-zinc-700">→</span> : null}
							<span
								className={
									state === "active"
										? providerUnconfirmed
											? "rounded bg-amber-950 px-2 py-0.5 font-medium text-amber-300 ring-1 ring-amber-700"
											: "rounded bg-sky-950 px-2 py-0.5 font-medium text-sky-300 ring-1 ring-sky-700"
										: state === "past"
											? "rounded px-2 py-0.5 text-zinc-500 line-through decoration-zinc-700"
											: "rounded px-2 py-0.5 text-zinc-600"
								}
							>
								{t(stage.labelKey)}
							</span>
						</li>
					);
				})}
			</ol>
			<figcaption
				className={
					providerUnconfirmed
						? "text-xs text-amber-300"
						: "text-xs text-zinc-400"
				}
			>
				{/* STAGE_DEFS covers the mapper's whole range, so activeDef is
				    total — review-228 caught the defensive ternary surviving
				    the first "removed dead ternary" claim. */}
				{providerUnconfirmed ? (
					<span className="mr-1">
						{t("live.providerStatusUnconfirmed", { status })}
					</span>
				) : errorWithEncoder && !providerTerminal ? (
					<span className="mr-1">{hint}</span>
				) : null}
				<HelpOverlay labelFor={t("lifecycle.aria")}>{hint}</HelpOverlay>
			</figcaption>
		</figure>
	);
}
