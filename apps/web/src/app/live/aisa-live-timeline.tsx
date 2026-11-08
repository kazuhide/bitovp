"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { AisaResultSnapshot } from "@/lib/aisa-live/contracts";
import { resolveMomentPlaybackRange } from "@/lib/aisa-live/playback";
import { readAisaRecordingTimeline } from "@/lib/aisa-live/recording-timeline";
import {
	formatMomentTime,
	recordingTimeWindows,
} from "@/lib/aisa-live/timeline-layout";
import {
	type AisaTranslationsResponse,
	translationForObservation,
} from "@/lib/aisa-live/translations";
import { useT } from "@/lib/i18n/context";
import { AisaMomentInfo, type AisaTimelineItem } from "./aisa-live-moment-info";
import { AisaMomentPreview } from "./aisa-live-player";
import { AisaTimelineTrack } from "./aisa-live-timeline-track";
import {
	type AisaMomentPlayRequest,
	momentPlaybackIdentity,
	useAisaRecordingUrl,
} from "./aisa-recording-scope";

type Props = {
	accountId: string;
	analysisId: string;
	encodingId: string;
	snapshot: AisaResultSnapshot;
	translations?: AisaTranslationsResponse;
	language?: "ja" | "original";
};

export function AisaMomentTimeline(props: Props) {
	const { t } = useT();
	const url = useAisaRecordingUrl(
		props.accountId,
		props.analysisId,
		props.encodingId,
	);
	if (
		props.snapshot.analysisId !== props.analysisId ||
		props.snapshot.encodingId !== props.encodingId
	) {
		return <p role="alert">{t("aisaLive.invalidResult")}</p>;
	}
	return (
		<Timeline
			key={`${url}:${props.snapshot.mediaTimeOriginUnixMs}`}
			{...props}
			url={url}
		/>
	);
}

function Timeline({
	accountId,
	analysisId,
	encodingId,
	snapshot,
	translations,
	language,
	url,
}: Props & { url: string }) {
	const { t } = useT();
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [request, setRequest] = useState<AisaMomentPlayRequest | undefined>(
		undefined,
	);
	const counter = useRef(0);
	const recording = useQuery({
		queryKey: ["aisa-recording-timeline", url],
		enabled: Boolean(url),
		queryFn: ({ signal }) => readAisaRecordingTimeline(url, signal),
		refetchInterval: (query) =>
			snapshot.isFinal &&
			query.state.status === "success" &&
			query.state.data?.endList
				? false
				: 10000,
		staleTime: 5000,
		retry: false,
	});
	const known = recording.status === "success";
	const fragments = known ? recording.data.fragments : [];
	const windows = recordingTimeWindows(
		fragments,
		snapshot.mediaTimeOriginUnixMs,
	);
	const duration = Math.max(
		1,
		snapshot.analyzedEndTimeSeconds,
		...snapshot.keyMoments.map((moment) => moment.endInSeconds),
	);
	const observations = new Map(
		snapshot.observations.map((item) => [item.id, item]),
	);
	const items = snapshot.keyMoments.map(
		(moment): AisaTimelineItem => ({
			moment,
			playable: known
				? Boolean(
						resolveMomentPlaybackRange(
							moment,
							snapshot.mediaTimeOriginUnixMs,
							fragments,
						),
					)
				: null,
			descriptions: moment.observations.flatMap((id) => {
				const observation = observations.get(id);
				if (!observation) return [];
				const translated =
					language === "ja"
						? translationForObservation(translations, {
								analysisId,
								encodingId,
								...observation,
							})
						: undefined;
				return [
					{
						id,
						text: translated?.text ?? observation.text,
						language: translated ? "ja" : "en",
						pending: language === "ja" && !translated,
					},
				];
			}),
		}),
	);
	const selected = items.find((item) => item.moment.id === selectedId);
	const selectedIdentity = selected
		? momentPlaybackIdentity(
				url,
				snapshot.mediaTimeOriginUnixMs,
				selected.moment,
			)
		: undefined;
	const selectedPresent = Boolean(selected);
	const selectedPlayable = selected?.playable;
	useEffect(() => {
		if (!selectedPresent) setSelectedId(null);
		if (selectedPlayable !== true) setRequest(undefined);
	}, [selectedPresent, selectedPlayable]);
	const choose = (item: AisaTimelineItem) => {
		setSelectedId(item.moment.id);
		setRequest(
			item.playable
				? {
						identity: momentPlaybackIdentity(
							url,
							snapshot.mediaTimeOriginUnixMs,
							item.moment,
						),
						token: ++counter.current,
					}
				: undefined,
		);
	};
	const stateLabel = (playable: boolean | null) =>
		t(
			playable === true
				? "aisaLive.timelinePlayable"
				: playable === false
					? "aisaLive.timelineOutside"
					: "aisaLive.timelineRecordingUnknown",
		);
	return (
		<div className="min-w-0 space-y-3">
			<div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-1 text-xs text-zinc-400">
				{known && windows.length ? (
					<span className="tabular-nums text-emerald-400">
						{t("aisaLive.timelineWindow", {
							start: formatMomentTime(windows[0]?.start ?? 0),
							end: formatMomentTime(windows.at(-1)?.end ?? 0),
						})}
					</span>
				) : (
					<span role="status">
						{t(
							recording.isError
								? "aisaLive.timelineRecordingUnknown"
								: "aisaLive.timelineRecordingPending",
						)}
					</span>
				)}
				<span className="inline-flex items-center gap-1">
					<span
						className="size-1.5 rounded-full bg-zinc-500"
						aria-hidden="true"
					/>
					{t("aisaLive.timelineOutside")}
				</span>
			</div>
			<AisaTimelineTrack
				items={items}
				duration={duration}
				windows={windows}
				selectedId={selectedId}
				url={url}
				origin={snapshot.mediaTimeOriginUnixMs}
				onSelect={choose}
			/>
			{selected ? (
				<section
					aria-label={t("aisaLive.timelineSelection")}
					data-aisa-selected-moment={selected.moment.id}
					className="grid gap-4 rounded-md border border-zinc-800 bg-zinc-900/30 p-3 md:grid-cols-[minmax(14rem,24rem)_minmax(0,1fr)]"
				>
					{selected.playable ? (
						<AisaMomentPreview
							accountId={accountId}
							analysisId={analysisId}
							encodingId={encodingId}
							mediaTimeOriginUnixMs={snapshot.mediaTimeOriginUnixMs}
							moment={selected.moment}
							playRequest={
								request?.identity === selectedIdentity ? request : undefined
							}
							labels={{
								play: t("aisaLive.previewPlay"),
								pause: t("aisaLive.previewPause"),
								replay: t("aisaLive.previewReplay"),
								loading: t("aisaLive.previewLoading"),
								unavailable: t("aisaLive.previewUnavailableMedia"),
								failed: t("aisaLive.previewFailed"),
								seek: t("aisaLive.previewSeek"),
								mute: t("aisaLive.previewMute"),
								unmute: t("aisaLive.previewUnmute"),
								thumbnailAlt: t("aisaLive.previewThumbnail"),
							}}
						/>
					) : (
						<div
							className="flex aspect-video items-center justify-center rounded bg-zinc-950 text-sm text-zinc-400"
							role="status"
						>
							{stateLabel(selected.playable)}
						</div>
					)}
					<AisaMomentInfo item={selected} />
				</section>
			) : null}
		</div>
	);
}
