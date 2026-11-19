"use client";

import { useT } from "@/lib/i18n/context";
import { useRunHealth } from "./stream-health";

export function RunOutcome({
	channelId,
	runId,
	canReadHealth,
}: {
	channelId: string;
	runId: string;
	canReadHealth: boolean;
}) {
	const { t } = useT();
	// The delivery timeline already observes this exact run. A historical
	// output event is evidence of generation, independent of current playback.
	const health = useRunHealth(
		channelId,
		canReadHealth && runId ? runId : null,
		false,
	);
	const outputGenerated =
		health.data?.run?.id === runId &&
		health.data?.timeline?.events.some(
			(event) => event.kind === "OUTPUT_ACTIVE",
		);

	return outputGenerated ? (
		<p className="text-sm text-zinc-300">{t("live.runOutputGenerated")}</p>
	) : null;
}
