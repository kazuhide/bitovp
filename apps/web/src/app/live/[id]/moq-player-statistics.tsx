"use client";

import type { ReactNode } from "react";
import { useT } from "@/lib/i18n/context";
import type { MoqPlaybackDescriptor } from "@/lib/moq-player/types";
import type {
	MoqVideoQuality,
	MoqVideoStatistics,
} from "@/lib/moq-player/video-statistics";

const format = (value: number | null, decimals: number, suffix = "") =>
	value !== null && Number.isFinite(value) && value >= 0
		? `${value.toFixed(decimals)}${suffix}`
		: null;
const quality = (value: MoqVideoQuality | null) =>
	value
		? [
				value.name,
				value.width && value.height ? `${value.width}×${value.height}` : null,
			]
				.filter(Boolean)
				.join(" · ") || null
		: null;
type Props = {
	statistics: MoqVideoStatistics;
	configuration: MoqPlaybackDescriptor["resource"]["metadata"] | null;
	relay?: MoqPlaybackDescriptor["relay"];
};

export function MoqPlayerStatistics({
	statistics: s,
	configuration,
	relay,
}: Props) {
	const { t } = useT();
	const row = (label: string, value: ReactNode) =>
		value === null ? null : (
			<div key={label} className="flex min-w-0 items-baseline gap-1.5">
				<dt className="text-zinc-500">{label}</dt>
				<dd className="break-words text-zinc-200 tabular-nums">{value}</dd>
			</div>
		);
	const extra = [
		row(t("moqPlayback.startup"), format(s.startupMs, 0, " ms")),
		row(t("moqPlayback.dropped"), format(s.droppedFrames, 0)),
		row(t("moqPlayback.decoded"), format(s.decodedFrames, 0)),
		row(t("moqPlayback.presented"), format(s.presentedFrames, 0)),
		row(t("moqPlayback.totalFrames"), format(s.totalFrames, 0)),
		row(t("moqPlayback.currentQuality"), quality(s.currentQuality)),
		row(
			t("moqPlayback.availableQualities"),
			s.availableQualities === null
				? null
				: s.availableQualities.length
					? s.availableQualities.map(quality).filter(Boolean).join(", ")
					: t("common.none"),
		),
	].filter((value) => value !== null);
	const configured = configuration || relay || s.renderingSource;
	if (!configured && !extra.length) return null;
	return (
		<div className="space-y-2 text-xs">
			{extra.length ? (
				<details>
					<summary className="cursor-pointer text-zinc-400">
						{t("moqPlayback.moreMeasurements")}
					</summary>
					<dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1">{extra}</dl>
				</details>
			) : null}
			{configured ? (
				<details>
					<summary className="cursor-pointer text-zinc-400">
						{t("moqPlayback.configuration")}
					</summary>
					<dl className="mt-2 grid gap-2 sm:grid-cols-2">
						{configuration ? (
							<>
								{row(t("moqPlayback.namespace"), configuration.namespace)}
								{row(t("moqPlayback.draft"), configuration.draftVersion)}
								{row(t("moqPlayback.catalog"), configuration.catalogTrackName)}
							</>
						) : null}
						{row(
							t("moqPlayback.renderingSource"),
							s.renderingSource === "canvas"
								? t("moqPlayback.renderingCanvas")
								: s.renderingSource === "video"
									? t("moqPlayback.renderingVideo")
									: null,
						)}
						{relay ? (
							<>
								{row(t("moqPlayback.relayOrigin"), relay.endpointOrigin)}
								{row(t("moqPlayback.relayId"), relay.configuredRelayId)}
								{row(t("moqPlayback.relayExpiry"), relay.tokenExpiresAt)}
								{row(
									t("moqPlayback.relayOperations"),
									relay.tokenOperations.join(", "),
								)}
							</>
						) : null}
					</dl>
					<p className="mt-2 text-zinc-500">{t("moqPlayback.latencyMethod")}</p>
					{s.renderingSource === "canvas" ? (
						<p className="mt-1 text-zinc-500">
							{t("moqPlayback.canvasMeasurement")}
						</p>
					) : null}
					{relay ? (
						<p className="mt-1 text-zinc-500">{t("moqPlayback.relayClaims")}</p>
					) : null}
				</details>
			) : null}
		</div>
	);
}
