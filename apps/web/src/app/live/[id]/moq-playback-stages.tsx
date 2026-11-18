"use client";

import Link from "next/link";
import { useT } from "@/lib/i18n/context";
import {
	MOQ_OBSERVATION_LIMITS,
	type MoqObservationEvent,
} from "@/lib/moq-player/observations";
import { buildHeartbeatCorrelationUrl } from "./heartbeat-correlation";

const HEARTBEAT_MARGIN_MS = 30_000;

export function MoqPlaybackStages({
	channelId,
	runId,
	startedAt,
	events,
	latest,
}: {
	channelId: string;
	runId: string;
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
	return (
		<details data-moq-playback-stages className="text-xs">
			<summary className="cursor-pointer text-zinc-400">
				<span>{t("moqPlayback.stagesTitle")}</span>
				<span aria-live="polite" className="text-zinc-200">
					{" · "}
					{beforeFailure ? (
						<>
							{t(`moqPlayback.event.${beforeFailure.type}`)}
							{" → "}
						</>
					) : null}
					{t(`moqPlayback.event.${last.type}`)}
					{" · "}
					<time className="tabular-nums" dateTime={latestUtc}>
						{latestUtc.slice(11, 23)} UTC
					</time>
				</span>
			</summary>
			<ol className="mt-1 space-y-1">
				{timeline.map((event, index) => {
					const epoch = started + event.elapsedMs;
					const iso = new Date(epoch).toISOString();
					const label = t(`moqPlayback.event.${event.type}`);
					const time = `${iso.slice(11, 23)} UTC`;
					const heartbeat = buildHeartbeatCorrelationUrl(
						channelId,
						runId,
						new Date(epoch - HEARTBEAT_MARGIN_MS).toISOString(),
						new Date(epoch + HEARTBEAT_MARGIN_MS).toISOString(),
					);
					const stamp = (
						<time className="tabular-nums" dateTime={iso}>
							{time}
						</time>
					);
					return (
						<li
							// Several valid milestones may occur in the same millisecond.
							key={`${event.type}:${event.elapsedMs}:${index}`}
							className="flex flex-wrap items-baseline gap-x-2 text-zinc-300"
							data-moq-playback-stage={event.type}
						>
							<span>{label}</span>
							{heartbeat ? (
								<Link
									aria-label={`${label} · ${time} · ${t("moqPlayback.encoderCorrelation")}`}
									className="text-zinc-400 underline underline-offset-2"
									href={heartbeat}
									prefetch={false}
								>
									{stamp}
								</Link>
							) : (
								stamp
							)}
						</li>
					);
				})}
			</ol>
		</details>
	);
}
