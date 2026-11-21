"use client";

import { useT } from "@/lib/i18n/context";
import {
	MOQ_OBSERVATION_LIMITS,
	type MoqObservationEvent,
} from "@/lib/moq-player/observations";

export function MoqPlaybackStages({
	startedAt,
	events,
	latest,
}: {
	startedAt: string;
	events: readonly MoqObservationEvent[];
	latest?: MoqObservationEvent;
}) {
	const { t } = useT();
	const started = Date.parse(startedAt);
	if (!Number.isFinite(started)) return null;

	const savedTail = events.at(-1);
	const liveYear = latest
		? new Date(started + latest.elapsedMs).getUTCFullYear()
		: -1;
	const addLiveEvent =
		latest &&
		Number.isSafeInteger(latest.elapsedMs) &&
		latest.elapsedMs >= (savedTail?.elapsedMs ?? 0) &&
		liveYear >= 0 &&
		liveYear <= 9999 &&
		(latest.elapsedMs !== savedTail?.elapsedMs ||
			latest.type !== savedTail?.type);
	const timeline = addLiveEvent
		? [...events.slice(0, MOQ_OBSERVATION_LIMITS.events - 1), latest]
		: events;
	const last = timeline.at(-1);
	if (!last) return null;

	const latestUtc = new Date(started + last.elapsedMs).toISOString();
	const beforeFailure = last.type === "failed" ? timeline.at(-2) : undefined;
	function eventLabel(event: MoqObservationEvent) {
		if (
			latest === undefined &&
			event.type === "ended" &&
			event.elapsedMs === MOQ_OBSERVATION_LIMITS.durationMs
		) {
			// Legacy saved sessions used "ended" at the cap for both cases.
			return t("moqPlayback.observationWindowEnded");
		}
		return t(`moqPlayback.event.${event.type}`);
	}
	return (
		<details data-moq-playback-stages className="text-xs">
			<summary className="cursor-pointer text-zinc-400">
				<span>{t("moqPlayback.stagesTitle")}</span>
				<span aria-live="polite" className="text-zinc-200">
					{" · "}
					{beforeFailure ? (
						<>
							{eventLabel(beforeFailure)}
							{" → "}
						</>
					) : null}
					{eventLabel(last)}
					{" · "}
					<time className="whitespace-nowrap tabular-nums" dateTime={latestUtc}>
						{latestUtc.slice(11, 23)} UTC
					</time>
				</span>
			</summary>
			<ol className="mt-2 space-y-1">
				{timeline.map((event, index) => {
					const epoch = started + event.elapsedMs;
					const iso = new Date(epoch).toISOString();
					const label = eventLabel(event);
					const time = `${iso.slice(11, 23)} UTC`;
					return (
						<li
							// Several valid milestones may occur in the same millisecond.
							key={`${event.type}:${event.elapsedMs}:${index}`}
							className="flex flex-wrap items-baseline justify-between gap-x-4 text-zinc-300"
							data-moq-playback-stage={event.type}
						>
							<span>{label}</span>
							<time
								className="whitespace-nowrap text-zinc-400 tabular-nums"
								dateTime={iso}
							>
								{time}
							</time>
						</li>
					);
				})}
			</ol>
		</details>
	);
}
