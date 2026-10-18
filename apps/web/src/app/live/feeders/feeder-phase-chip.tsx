"use client";

import { useT } from "@/lib/i18n/context";
import {
	FEEDER_PHASE_KEY,
	type FeederSessionListItem,
	feederSwitchPhase,
} from "./feeder-shared";

/**
 * : beside a DOWNLOADING badge, what a two-phase session is really
 * doing — staging its source, or READY and holding for the switch. Renders
 * nothing for an ordinary session, so every list that shows a status badge
 * can drop it in without a branch of its own.
 */
export function FeederPhaseChip({
	session,
}: {
	session: Pick<
		FeederSessionListItem,
		"status" | "commitAt" | "readyAt" | "committedAt"
	>;
}) {
	const { t } = useT();
	const phase = feederSwitchPhase(session);
	if (phase === null) {
		return null;
	}
	return (
		<span data-feeder-phase={phase} className="ml-1 text-xs text-zinc-400">
			{t(FEEDER_PHASE_KEY[phase])}
		</span>
	);
}
