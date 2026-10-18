"use client";

import type { LiveNextAction, LiveNextActionCode } from "@bitovp/core";
import { HelpOverlay } from "@/components/ui/help-overlay";
import type { MessageKey } from "@/lib/i18n";
import { useT } from "@/lib/i18n/context";
import type { LiveJumpEvent } from "./section-focus";

/**
 * , layer 1: the ONE thing to do next, at the top of the page.
 *
 * Core derives the code (`liveNextAction` — UI-free); this maps it to copy and
 * to a jump into the card that answers it. It deliberately does NOT duplicate
 * the action buttons: the buttons live in their sections, and two copies of
 * "start the encoder" is how a page grows the second source of truth this
 * redesign exists to remove.
 */
const COPY: Record<
	LiveNextActionCode,
	{ title: MessageKey; body: MessageKey; cta: MessageKey }
> = {
	START_ENCODER: {
		title: "nextAction.startEncoderTitle",
		body: "nextAction.startEncoderBody",
		cta: "nextAction.goActions",
	},
	RECOVER_FROM_ERROR: {
		title: "nextAction.recoverTitle",
		body: "nextAction.recoverBody",
		cta: "nextAction.goActions",
	},
	WAIT_FOR_BOOT: {
		title: "nextAction.bootTitle",
		body: "nextAction.bootBody",
		cta: "nextAction.goActions",
	},
	WAIT_FOR_STOP: {
		title: "nextAction.stoppingTitle",
		body: "nextAction.stoppingBody",
		cta: "nextAction.goSteps",
	},
	CONNECT_INPUT: {
		title: "nextAction.connectInputTitle",
		body: "nextAction.connectInputBody",
		cta: "nextAction.goFeeders",
	},
	WAIT_FOR_OUTPUT: {
		title: "nextAction.outputTitle",
		body: "nextAction.outputBody",
		cta: "nextAction.goManifests",
	},
	REVIEW_ALERTS: {
		title: "nextAction.alertsTitle",
		body: "nextAction.alertsBody",
		cta: "nextAction.goAlerts",
	},
	// the alert list did not load. Separate copy
	// from REVIEW_ALERTS on purpose: that one says an alert IS open, which is
	// a claim we cannot make here.
	ALERTS_UNKNOWN: {
		title: "nextAction.alertsUnknownTitle",
		body: "nextAction.alertsUnknownBody",
		cta: "nextAction.goAlerts",
	},
	//  — the provider's status read is failing. Its own copy, not
	// ON_AIR's and not RECOVER_FROM_ERROR's: the channel is neither known
	// healthy nor known broken, and the honest verbs are "wait, or stop".
	PROVIDER_UNKNOWN: {
		title: "nextAction.providerUnknownTitle",
		body: "nextAction.providerUnknownBody",
		cta: "nextAction.goActions",
	},
	ON_AIR: {
		title: "nextAction.onAirTitle",
		body: "nextAction.onAirBody",
		cta: "nextAction.goActions",
	},
	START_NEW_RUN: {
		title: "nextAction.startNewRunTitle",
		body: "nextAction.startNewRunBody",
		cta: "nextAction.goActions",
	},
	SCHEDULED_ONLY: {
		title: "nextAction.scheduledTitle",
		body: "nextAction.scheduledBody",
		cta: "nextAction.goSchedule",
	},
	NOTHING_TO_DO: {
		title: "nextAction.idleTitle",
		body: "nextAction.idleBody",
		cta: "nextAction.goActions",
	},
};

const TONE = {
	act: {
		box: "border-amber-500/40 bg-amber-500/5",
		dot: "bg-amber-400",
		title: "text-amber-200",
	},
	wait: {
		box: "border-zinc-700 bg-zinc-900/60",
		dot: "bg-zinc-400",
		title: "text-zinc-200",
	},
	watch: {
		box: "border-emerald-500/40 bg-emerald-500/5",
		dot: "bg-emerald-400",
		title: "text-emerald-200",
	},
	idle: {
		box: "border-zinc-800 bg-zinc-900/40",
		dot: "bg-zinc-600",
		title: "text-zinc-300",
	},
} as const;

export function NextActionPanel({
	action,
	onJump,
}: {
	action: LiveNextAction;
	/**
	 * called with the click event and the target section id when the
	 * CTA is taken, so the page can hand focus to that section's heading

	 *
	 * A callback rather than a `hashchange` listener doing the work alone: a
	 * second click on an UNCHANGED action — the operator who scrolled away from
	 * the alerts and wants to go back — fires no `hashchange` at all, because
	 * the fragment is already the current one. The listener still exists for the
	 * hashes this component never produces (Back, a pasted URL); this covers the
	 * one it does, and it needs the EVENT because on that same-fragment path it
	 * must cancel the default action (review-366 I1).
	 */
	onJump?: (event: LiveJumpEvent, section: LiveNextAction["section"]) => void;
}) {
	const { t } = useT();
	const copy = COPY[action.code];
	const tone = TONE[action.tone];
	return (
		<section
			aria-label={t("nextAction.regionLabel")}
			data-next-action={action.code}
			className={`rounded-md border px-4 py-3 ${tone.box}`}
		>
			<div className="flex items-center gap-2">
				<span aria-hidden className={`h-2 w-2 rounded-full ${tone.dot}`} />
				<h2 className={`font-medium text-sm ${tone.title}`}>{t(copy.title)}</h2>
				{action.code === "START_NEW_RUN" ? (
					<HelpOverlay labelFor={t(copy.title)}>{t(copy.body)}</HelpOverlay>
				) : null}
				{/* An in-page anchor, not a button (review-260 126-A5 rewording):
				 * since #126 flattened the page, 13 of 15 targets are always-open
				 * sections — the link simply scrolls. For the two surviving folds
				 * the openByDefault mechanics open the pointed one; otherwise the
			    operator clicks the summary. */}
				<a
					href={`#${action.section}`}
					// The handler decides whether to cancel: on a CHANGED fragment
					// the browser's own navigation is what scrolls and writes the
					// hash, and `hashchange` then restores focus; on a same-fragment
					// click it must cancel, or Blink's default action clears the
					// focus just set (review-366 I1).
					onClick={(event) => onJump?.(event, action.section)}
					className="ml-auto shrink-0 whitespace-nowrap rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
				>
					{t(copy.cta)}
				</a>
			</div>
			{action.code !== "START_NEW_RUN" ? (
				<p className="mt-1 text-sm text-zinc-400">{t(copy.body)}</p>
			) : null}
		</section>
	);
}
