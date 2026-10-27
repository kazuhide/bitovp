"use client";

import { CODEC_OPTIONS } from "@bitovp/core";
import { AUDIO_CHANNEL_LAYOUTS } from "@/app/vod/new/audio-channel-layouts";
import {
	audioKeys,
	audioMuxingRelPath,
	videoKeys,
	videoMuxingRelPath,
} from "@/app/vod/new/build-plan";
import { AudioCutoffEditor } from "@/app/vod/new/codec-detail-editor";
import { HlsVideoUriField } from "@/app/vod/new/hls-video-uri-field";
import {
	audioCopyLabel,
	RenditionAddControls,
	videoCopyLabel,
} from "@/app/vod/new/rendition-add-controls";
import { copyRendition } from "@/app/vod/new/rendition-copy";
import {
	H264AdvancedEditor,
	H265AdvancedEditor,
} from "@/app/vod/new/rendition-editors";
import { Collapsible } from "@/app/vod/new/wizard-fields";
import { Field, FieldRowAction } from "@/components/ui/field";
import { Input, SelectNative } from "@/components/ui/input";
import { useT } from "@/lib/i18n/context";
import type {
	LiveAudioRendition,
	LiveVideoRendition,
	LiveWizardState,
} from "./build-live-plan";
import { liveBasePath, liveVideoPreset } from "./build-live-plan";
import { LiveInputFields } from "./live-rendition-fields";

/**
 * Live ladder — the VOD ladder narrowed to the live codec rails
 * (H264/H265 video, AAC/DD/DDPLUS audio; VP9/Atmos/WebVTT are VOD-only)
 * with the shared H264/H265 advanced editors and one Live preset selector.
 * VOD choices retain their warning; other saved values remain visible for validation.
 */

const LIVE_PRESETS = CODEC_OPTIONS.PresetConfiguration.filter((preset) =>
	preset.startsWith("LIVE_"),
);
const VOD_PRESETS = [
	"VOD_HIGH_QUALITY",
	"VOD_QUALITY",
	"VOD_STANDARD",
	"VOD_SPEED",
	"VOD_HIGH_SPEED",
].filter((preset) => CODEC_OPTIONS.PresetConfiguration.includes(preset));
const PRESET_CHOICES = [...LIVE_PRESETS, ...VOD_PRESETS];
const H264_NO_PRESET = "__none__";

/** Retained unknown presets must not collide with the UI-only None value. */
function h264NoPresetOption(video: LiveVideoRendition): string {
	return liveVideoPreset(video) === H264_NO_PRESET
		? `${H264_NO_PRESET}_`
		: H264_NO_PRESET;
}

type LadderSectionProps = {
	state: LiveWizardState;
	onPatch: (partial: Partial<LiveWizardState>) => void;
};

export function LiveLadderSection({ state, onPatch }: LadderSectionProps) {
	const { t } = useT();
	// Freeze all derived keys together before any edit can change the derivation
	// of a sibling. Archive and bundled-audio references keep their identities.
	const vKeys = videoKeys(state.videos);
	const aKeys = audioKeys(state.audios);
	const stableVideos: LiveVideoRendition[] = state.videos.map(
		(video, index) => ({
			...video,
			extras: { ...video.extras, key: vKeys[index] },
		}),
	);
	const stableAudios: LiveAudioRendition[] = state.audios.map(
		(audio, index) => ({
			...audio,
			extras: { key: aKeys[index] },
		}),
	);
	const patchLadder = (partial: Partial<LiveWizardState>) =>
		onPatch({ videos: stableVideos, audios: stableAudios, ...partial });
	const copyLive = <T extends LiveVideoRendition | LiveAudioRendition>(
		row: T,
		key: string,
		uris: Iterable<string | undefined> = [],
	): T => {
		const copy = copyRendition(row, key, uris);
		if (copy.muxing?.path !== undefined) {
			const normalize = (path: string) =>
				path.split("/").filter(Boolean).join("/");
			const base = liveBasePath(state);
			const reserved = new Set(
				[
					...stableVideos.map(
						(video, index) =>
							video.muxing?.path ??
							`${base}/${videoMuxingRelPath({ ...video, extras: undefined }, vKeys[index] ?? "")}`,
					),
					...stableAudios.map(
						(audio, index) =>
							audio.muxing?.path ??
							`${base}/${audioMuxingRelPath({ ...audio, extras: undefined }, aKeys[index] ?? "")}`,
					),
				].map(normalize),
			);
			const prefix = `${copy.muxing.path.replace(/\/+$/, "") || "media"}-${key}`;
			let path = prefix,
				n = 2;
			while (reserved.has(normalize(path))) path = `${prefix}-${n++}`;
			copy.muxing = { ...copy.muxing, path };
		}
		return copy;
	};
	const nextKey = (prefix: "v" | "a") => {
		const reserved = new Set([
			...vKeys,
			...aKeys,
			...state.videos.flatMap((video) => video.muxedAudioKeys ?? []),
			state.archive?.muxing.streamKey,
			...(state.archive?.muxing.additionalStreamKeys ?? []),
		]);
		let n = 1;
		while (reserved.has(`${prefix}${n}`)) n += 1;
		return `${prefix}${n}`;
	};
	const patchVideo = (index: number, partial: Partial<LiveVideoRendition>) => {
		const next = [...stableVideos];
		const current = next[index];
		if (!current) {
			return;
		}
		next[index] = { ...current, ...partial };
		patchLadder({ videos: next });
	};
	const patchPreset = (index: number, presetConfiguration: string) => {
		const video = stableVideos[index];
		if (!video) return;
		const noPreset =
			video.codec === "H264" &&
			presetConfiguration === h264NoPresetOption(video);
		const h264 = video.h264 ? { ...video.h264 } : undefined;
		const h265 = video.h265 ? { ...video.h265 } : undefined;
		if (h264) delete h264.presetConfiguration;
		if (h265) delete h265.presetConfiguration;
		patchVideo(index, {
			presetConfiguration: noPreset ? undefined : presetConfiguration,
			h264: noPreset ? { ...h264, presetConfiguration: null } : h264,
			h265,
		});
	};

	const patchAudio = (index: number, partial: Partial<LiveAudioRendition>) => {
		const next = [...stableAudios];
		const current = next[index];
		if (!current) {
			return;
		}
		next[index] = { ...current, ...partial };
		patchLadder({ audios: next });
	};

	return (
		<div className="space-y-6">
			<div>
				<div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
					<h2 className="shrink-0 font-medium text-sm text-zinc-200">
						{t("wizard.videoRenditions")}
					</h2>
					<RenditionAddControls
						kind="video"
						label={t("wizard.addVideo")}
						choices={state.videos.map((video, index) => ({
							key: vKeys[index] ?? String(index),
							index,
							label: videoCopyLabel(video, index),
						}))}
						onAdd={(index) =>
							patchLadder({
								videos: [
									...stableVideos,
									copyLive<LiveVideoRendition>(
										stableVideos[index ?? -1] ?? {
											codec: "H264",
											width: 1280,
											height: 720,
											bitrate: 1_500_000,
											presetConfiguration: "LIVE_STANDARD",
											h264: { rate: 30 },
										},
										nextKey("v"),
										[
											...stableVideos.map(
												(video) => video.extras?.hlsVariantUri,
											),
											state.manifests.hls.manifestName || "stream.m3u8",
											state.manifests.dash.manifestName,
											...(state.manifests.additionalHls ?? []).map(
												(manifest) => manifest.manifestName,
											),
											...(state.manifests.additionalDash ?? []).map(
												(manifest) => manifest.manifestName,
											),
										],
									),
								],
							})
						}
					/>
				</div>
				<div className="mt-2 space-y-3">
					{state.videos.map((video, index) => (
						<div
							key={index}
							className="space-y-3 rounded-md border border-zinc-800 p-3"
						>
							<div className="flex flex-wrap items-start gap-2">
								<Field
									label={t("wizard.codec")}
									htmlFor={`lw-v-${index}-codec`}
								>
									<SelectNative
										id={`lw-v-${index}-codec`}
										className="w-24"
										value={video.codec}
										onChange={(e) =>
											patchVideo(index, {
												codec: e.target.value as "H264" | "H265",
											})
										}
									>
										<option value="H264">H264</option>
										<option value="H265">H265</option>
									</SelectNative>
								</Field>

								<div className="min-w-24 flex-1">
									<Field
										label={t("liveWizard.outputWidth")}
										htmlFor={`lw-v-${index}-width`}
										tooltip={t("liveWizard.outputWidthHint")}
									>
										<Input
											id={`lw-v-${index}-width`}
											type="number"
											min={1}
											value={video.width ?? ""}
											onChange={(e) =>
												patchVideo(index, {
													width:
														e.target.value === ""
															? undefined
															: Number(e.target.value),
												})
											}
										/>
									</Field>
								</div>

								<div className="min-w-24 flex-1">
									<Field
										label={t("wizard.heightP")}
										htmlFor={`lw-v-${index}-height`}
									>
										<Input
											id={`lw-v-${index}-height`}
											type="number"
											value={video.height ?? ""}
											onChange={(e) =>
												patchVideo(index, {
													height:
														e.target.value === ""
															? null
															: Math.max(0, Math.round(Number(e.target.value))),
												})
											}
										/>
									</Field>
								</div>
								<div className="min-w-28 flex-1">
									<Field
										label={t("wizard.bitrateBps")}
										htmlFor={`lw-v-${index}-bitrate`}
										tooltip={t("ui.requiredForLiveFixedLaddersOnly")}
									>
										<Input
											id={`lw-v-${index}-bitrate`}
											type="number"
											value={video.bitrate ?? ""}
											onChange={(e) =>
												patchVideo(index, {
													bitrate:
														e.target.value === ""
															? null
															: Math.max(0, Math.round(Number(e.target.value))),
												})
											}
										/>
									</Field>
								</div>
								<div className="min-w-44 flex-1">
									<Field
										label={t("wizard.presetConfiguration")}
										htmlFor={`lw-v-${index}-preset`}
										help={
											liveVideoPreset(video) &&
											!PRESET_CHOICES.includes(liveVideoPreset(video) ?? "")
												? t("liveWizard.presetRetained")
												: t("ui.pickALivePresetTheValidatorWarns")
										}
									>
										<SelectNative
											id={`lw-v-${index}-preset`}
											value={
												video.codec === "H264" &&
												liveVideoPreset(video) === null
													? h264NoPresetOption(video)
													: (liveVideoPreset(video) ?? "")
											}
											onChange={(e) => patchPreset(index, e.target.value)}
										>
											<option value="">
												{video.codec === "H264"
													? t("ui.schemaDefaultVodWarns")
													: t("wizard.defaultApi")}
											</option>
											{video.codec === "H264" ? (
												<option value={h264NoPresetOption(video)}>
													{t("wizard.noPreset")}
												</option>
											) : null}
											{liveVideoPreset(video) &&
											!PRESET_CHOICES.includes(liveVideoPreset(video) ?? "") ? (
												<option value={liveVideoPreset(video) ?? ""}>
													{liveVideoPreset(video)}
												</option>
											) : null}
											<optgroup label={t("ui.livePresets")}>
												{LIVE_PRESETS.map((preset) => (
													<option key={preset} value={preset}>
														{preset}
													</option>
												))}
											</optgroup>
											<optgroup label={t("ui.vodPresetsLivePresetVodWarning")}>
												{VOD_PRESETS.map((preset) => (
													<option key={preset} value={preset}>
														{preset}
													</option>
												))}
											</optgroup>
										</SelectNative>
									</Field>
								</div>
								<FieldRowAction>
									<button
										type="button"
										aria-label={t("uiX.removeNamedN", {
											item: t("uiX.videoRendition"),
											n: index + 1,
										})}
										className="rounded-md border border-zinc-800 px-2 py-1 text-xs text-zinc-400 hover:border-red-900 hover:text-red-400"
										onClick={() =>
											patchLadder({
												videos: stableVideos.filter((_, i) => i !== index),
											})
										}
									>
										{t("ui.remove")}
									</button>
								</FieldRowAction>
							</div>
							<div className="max-w-md">
								<HlsVideoUriField
									id={`lw-v-${index}-hls-video-uri`}
									live
									value={video.extras?.hlsVariantUri}
									onChange={(hlsVariantUri) =>
										patchVideo(index, {
											extras: { ...stableVideos[index]?.extras, hlsVariantUri },
										})
									}
								/>
							</div>
							{video.codec === "H264" ? (
								<H264AdvancedEditor
									allowCrf={false}
									showPreset={false}
									idBase={`lw-v-${index}-h264`}
									value={video.h264}
									onChange={(h264) => patchVideo(index, { h264 })}
								>
									<LiveInputFields
										idBase={`lw-v-${index}`}
										state={state}
										input={video.input}
										onInputChange={(input) => patchVideo(index, { input })}
									/>
								</H264AdvancedEditor>
							) : (
								<H265AdvancedEditor
									allowCrf={false}
									showPreset={false}
									idBase={`lw-v-${index}-h265`}
									value={video.h265}
									visionMetadataKeys={[]}
									onChange={(h265) => patchVideo(index, { h265 })}
								>
									<LiveInputFields
										idBase={`lw-v-${index}`}
										state={state}
										input={video.input}
										onInputChange={(input) => patchVideo(index, { input })}
									/>
								</H265AdvancedEditor>
							)}
						</div>
					))}
					{state.videos.length === 0 ? (
						<p className="text-xs text-zinc-500">
							{t("ui.noVideoRenditionsAudioOnlyChannelsAre")}
						</p>
					) : null}
				</div>
			</div>

			<div>
				<div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
					<h2 className="shrink-0 font-medium text-sm text-zinc-200">
						{t("wizard.audioRenditions")}
					</h2>
					<RenditionAddControls
						kind="audio"
						label={t("wizard.addAudio")}
						choices={state.audios.map((audio, index) => ({
							key: aKeys[index] ?? String(index),
							index,
							label: audioCopyLabel(audio, index),
						}))}
						onAdd={(index) =>
							patchLadder({
								audios: [
									...stableAudios,
									copyLive<LiveAudioRendition>(
										stableAudios[index ?? -1] ?? {
											codec: "AAC",
											bitrate: 128_000,
											rate: 48_000,
										},
										nextKey("a"),
									),
								],
							})
						}
					/>
				</div>
				<div className="mt-2 space-y-3">
					{state.audios.map((audio, index) => (
						<div
							key={index}
							className="flex flex-wrap items-start gap-2 rounded-md border border-zinc-800 p-3"
						>
							<Field label={t("wizard.codec")} htmlFor={`lw-a-${index}-codec`}>
								<SelectNative
									id={`lw-a-${index}-codec`}
									className="w-28"
									value={audio.codec}
									onChange={(e) =>
										patchAudio(index, {
											codec: e.target.value as LiveAudioRendition["codec"],
											cutoffFrequency: undefined,
											channelLayout: undefined,
										})
									}
								>
									<option value="AAC">AAC</option>
									<option value="DDPLUS">{t("ui.dolbyDigital")}</option>
									<option value="DD">{t("ui.dolbyDigital2")}</option>
								</SelectNative>
							</Field>
							<div className="min-w-28 flex-1">
								<Field
									label={t("wizard.bitrateBps")}
									htmlFor={`lw-a-${index}-bitrate`}
								>
									<Input
										id={`lw-a-${index}-bitrate`}
										type="number"
										value={audio.bitrate}
										onChange={(e) =>
											patchAudio(index, {
												bitrate: Math.max(
													0,
													Math.round(Number(e.target.value)),
												),
											})
										}
									/>
								</Field>
							</div>
							{/* Allow enough label width for the localized sampling-frequency label on one line. Let the outer flex row wrap on narrow screens instead of misaligning this control. */}
							<div className="min-w-40 flex-1">
								<Field
									label={t("wizard.sampleRateHz")}
									htmlFor={`lw-a-${index}-rate`}
								>
									<Input
										id={`lw-a-${index}-rate`}
										type="number"
										value={audio.rate}
										onChange={(e) =>
											patchAudio(index, {
												rate: Math.max(0, Math.round(Number(e.target.value))),
											})
										}
									/>
								</Field>
							</div>
							<div className="min-w-32 flex-1">
								<Field
									label={t("wizard.channelLayout")}
									htmlFor={`lw-a-${index}-layout`}
									tooltip={t("ui.emptyClStereo")}
								>
									<SelectNative
										id={`lw-a-${index}-layout`}
										value={audio.channelLayout ?? ""}
										onChange={(e) =>
											patchAudio(index, {
												channelLayout:
													e.target.value === "" ? undefined : e.target.value,
											})
										}
									>
										<option value="">{t("wizard.default")}</option>
										{audio.channelLayout &&
										!AUDIO_CHANNEL_LAYOUTS[audio.codec].includes(
											audio.channelLayout,
										) ? (
											<option value={audio.channelLayout}>
												{audio.channelLayout}
											</option>
										) : null}
										{AUDIO_CHANNEL_LAYOUTS[audio.codec].map((layout) => (
											<option key={layout} value={layout}>
												{layout}
											</option>
										))}
									</SelectNative>
								</Field>
							</div>
							{audio.codec === "AAC" ? (
								<AudioCutoffEditor
									id={`lw-a-${index}-cutoff`}
									value={audio.cutoffFrequency}
									onChange={(cutoffFrequency) =>
										patchAudio(index, { cutoffFrequency })
									}
								/>
							) : null}
							<FieldRowAction>
								<button
									type="button"
									aria-label={t("uiX.removeNamedN", {
										item: t("uiX.audioRendition"),
										n: index + 1,
									})}
									className="rounded-md border border-zinc-800 px-2 py-1 text-xs text-zinc-400 hover:border-red-900 hover:text-red-400"
									onClick={() =>
										patchLadder({
											audios: stableAudios.filter((_, i) => i !== index),
										})
									}
								>
									{t("ui.remove")}
								</button>
							</FieldRowAction>
							<div className="w-full">
								<Collapsible summary={t("wizard.advanced")}>
									<LiveInputFields
										idBase={`lw-a-${index}`}
										state={state}
										input={audio.input}
										audio
										onInputChange={(input) => patchAudio(index, { input })}
									/>
								</Collapsible>
							</div>
						</div>
					))}
				</div>
			</div>
		</div>
	);
}
