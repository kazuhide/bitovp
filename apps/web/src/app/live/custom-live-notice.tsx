"use client";

import {
	type LiveChannelPlan,
	type LiveEncodingOptionReasonCode,
	resolveLiveEncodingOption,
} from "@bitovp/core";
import { HelpOverlay } from "@/components/ui/help-overlay";
import type { MessageKey } from "@/lib/i18n";
import { useT } from "@/lib/i18n/context";

const REASON_KEYS: Readonly<Record<LiveEncodingOptionReasonCode, MessageKey>> =
	{
		LEGACY_CUSTOM: "liveWizard.customLegacy",
		CUSTOM_REQUESTED: "liveWizard.customRequested",
		CODEC_UNSUPPORTED: "liveWizard.customCodec",
		INPUT_PROTOCOL: "liveWizard.customInputProtocol",
		INPUT_DEPENDENT: "liveWizard.customInput",
		VIDEO_COUNT: "liveWizard.customVideoCount",
		HD_VIDEO_COUNT: "liveWizard.customHdCount",
		VIDEO_LONG_EDGE: "liveWizard.customLongEdge",
		VIDEO_SHORT_EDGE: "liveWizard.customShortEdge",
		VIDEO_FRAME_RATE: "liveWizard.customFps",
		VIDEO_BITRATE: "liveWizard.customVideoBitrate",
		TOTAL_VIDEO_PIXELS: "liveWizard.customPixels",
		TOTAL_VIDEO_BITRATE: "liveWizard.customTotalBitrate",
		AUDIO_COUNT: "liveWizard.customAudioCount",
		AUDIO_BITRATE: "liveWizard.customAudioBitrate",
		AUDIO_SAMPLE_RATE: "liveWizard.customSampleRate",
		AUDIO_CHANNELS: "liveWizard.customChannels",
		ENCODING_MODE: "liveWizard.customMode",
		PRESET_UNSUPPORTED: "liveWizard.customPreset",
		MANIFEST_COUNT: "liveWizard.customManifests",
	};

const INPUT_KEYS: Readonly<Record<string, MessageKey>> = {
	width: "liveWizard.outputWidth",
	height: "ui.heightP",
	rate: "wizard.frameRateFps",
	bitrate: "ui.bitrateBps",
	channelLayout: "ui.channelLayout",
	colorConfig: "wizard.colorConfig",
};

/** The normal HD path stays quiet. The same core policy selects the actual endpoint. */
export function CustomLiveNotice({
	plan,
	compact = false,
}: {
	plan: LiveChannelPlan;
	compact?: boolean;
}) {
	const { t, locale } = useT();
	const choice = resolveLiveEncodingOption(plan);
	// Explicit HD violations are blocking validation errors, never a Custom fallback.
	if (choice.encodingOption === "HD" || plan.start.encodingOption === "HD")
		return null;
	const details = (
		<>
			{plan.start.encodingOption === "AUTO" ? (
				<p>{t("liveWizard.customLiveExplanation")}</p>
			) : null}
			<ul className="list-inside list-disc space-y-1">
				{choice.reasons.map((reason, index) => {
					const inputKey =
						reason.code === "INPUT_DEPENDENT" &&
						typeof reason.actual === "string" &&
						Object.hasOwn(INPUT_KEYS, reason.actual)
							? INPUT_KEYS[reason.actual]
							: undefined;
					const actual = inputKey
						? t(inputKey)
						: typeof reason.actual === "number"
							? reason.actual.toLocaleString(locale)
							: (reason.actual ?? "");
					return (
						<li
							key={`${reason.code}:${reason.renditionKey ?? "plan"}:${index}`}
						>
							{reason.renditionKey ? `${reason.renditionKey}: ` : ""}
							{t(REASON_KEYS[reason.code], {
								actual,
								limit: reason.limit?.toLocaleString(locale) ?? "",
							})}
						</li>
					);
				})}
			</ul>
		</>
	);
	return (
		<div
			role="note"
			aria-label={t("liveWizard.customLiveNotice")}
			className="space-y-2 rounded-md border border-amber-800 bg-amber-950/20 p-3 text-amber-200 text-xs"
		>
			<p className="font-medium">
				{t("liveWizard.customLiveNotice")}{" "}
				{compact ? (
					<HelpOverlay labelFor={t("liveWizard.customLiveNotice")}>
						{details}
					</HelpOverlay>
				) : null}
			</p>
			{compact ? null : details}
		</div>
	);
}
