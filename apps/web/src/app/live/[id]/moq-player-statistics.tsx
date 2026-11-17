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
		: "—";
const quality = (value: MoqVideoQuality | null) =>
	value
		? [
				value.name,
				value.width && value.height ? `${value.width}×${value.height}` : null,
			]
				.filter(Boolean)
				.join(" · ") || "—"
		: "—";
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
	const row = (label: string, value: ReactNode) => (
		<div key={label} className="min-w-0">
			<dt className="text-zinc-500">{label}</dt>
			<dd className="break-words text-zinc-200 tabular-nums">{value}</dd>
		</div>
	);
	return (
		<div className="space-y-2 text-xs">
			<dl
				aria-label={t("moqPlayback.statistics")}
				className="grid grid-cols-2 gap-x-3 gap-y-2"
			>
				{row(t("moqPlayback.namespace"), configuration?.namespace ?? "—")}
				{row(t("moqPlayback.draft"), configuration?.draftVersion ?? "—")}
				{row(t("moqPlayback.catalog"), configuration?.catalogTrackName ?? "—")}
				{row(t("moqPlayback.targetBuffer"), "2.00 s")}
				{row(
					t("moqPlayback.renderingSource"),
					s.renderingSource === "canvas"
						? t("moqPlayback.renderingCanvas")
						: s.renderingSource === "video"
							? t("moqPlayback.renderingVideo")
							: "—",
				)}
				{row(t("moqPlayback.resolution"), s.resolution ?? "—")}
				{row(
					t(
						s.renderingSource === "canvas"
							? "moqPlayback.canvasUpdates"
							: "moqPlayback.fps",
					),
					format(s.fps, 1, s.renderingSource === "canvas" ? " /s" : " fps"),
				)}
				{row(t("moqPlayback.dropped"), format(s.droppedFrames, 0))}
				{row(t("moqPlayback.startup"), format(s.startupMs, 0, " ms"))}
				{row(
					t(
						s.bufferSource === "player"
							? "moqPlayback.bufferPlayer"
							: s.bufferSource === "video"
								? "moqPlayback.bufferVideo"
								: "moqPlayback.buffer",
					),
					format(s.bufferSeconds, 2, " s"),
				)}
				{row(
					t("moqPlayback.latency"),
					s.latencySeconds === null
						? t("moqPlayback.unmeasured")
						: format(s.latencySeconds * 1000, 0, " ms"),
				)}
				{row(t("moqPlayback.decoded"), format(s.decodedFrames, 0))}
				{row(t("moqPlayback.presented"), format(s.presentedFrames, 0))}
				{row(t("moqPlayback.totalFrames"), format(s.totalFrames, 0))}
				{row(t("moqPlayback.currentQuality"), quality(s.currentQuality))}
				{row(
					t("moqPlayback.availableQualities"),
					s.availableQualities === null
						? "—"
						: s.availableQualities.length
							? s.availableQualities.map(quality).join(", ")
							: t("common.none"),
				)}
			</dl>
			<p className="text-zinc-500">{t("moqPlayback.latencyMethod")}</p>
			{s.renderingSource === "canvas" ? (
				<p className="text-zinc-500">{t("moqPlayback.canvasMeasurement")}</p>
			) : null}
			{relay ? (
				<details className="border-t border-zinc-800 pt-2">
					<summary className="cursor-pointer text-zinc-300">
						{t("moqPlayback.relayConfigured")}
					</summary>
					<p className="mt-2 text-zinc-500">{t("moqPlayback.relayClaims")}</p>
					<dl className="mt-2 grid grid-cols-1 gap-2">
						{row(t("moqPlayback.relayOrigin"), relay.endpointOrigin)}
						{row(t("moqPlayback.relayId"), relay.configuredRelayId)}
						{row(t("moqPlayback.relayExpiry"), relay.tokenExpiresAt)}
						{row(
							t("moqPlayback.relayOperations"),
							relay.tokenOperations.join(", "),
						)}
					</dl>
				</details>
			) : null}
		</div>
	);
}
