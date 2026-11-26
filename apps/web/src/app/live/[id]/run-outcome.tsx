"use client";

import { useT } from "@/lib/i18n/context";
import { FlatSection } from "./flat-section";
import { LIVE_SECTION_TITLE_KEYS } from "./section-layout";
import { useRunHealth } from "./stream-health";

export function RunOutcome({
	channelId,
	runId,
	runSequence,
	canReadHealth,
}: {
	channelId: string;
	runId: string;
	runSequence: number;
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

	return (
		<FlatSection
			id="sec-last-run"
			title={t(LIVE_SECTION_TITLE_KEYS["sec-last-run"])}
			summary={t("runs.seq", { n: runSequence })}
		>
			{outputGenerated ? (
				<p className="text-sm text-zinc-300">{t("live.runOutputGenerated")}</p>
			) : null}
		</FlatSection>
	);
}
