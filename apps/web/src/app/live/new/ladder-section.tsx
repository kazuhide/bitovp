"use client";

import { AUDIO_CHANNEL_LAYOUTS } from "@/app/vod/new/audio-channel-layouts";
import { audioKeys, videoKeys } from "@/app/vod/new/build-plan";
import { CMAF_CHUNK_FIELDS } from "@/app/vod/new/cmaf-fields";
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
import { OptionsGrid } from "@/app/vod/new/wizard-fields";
import { Field, FieldRowAction } from "@/components/ui/field";
import { Input, SelectNative } from "@/components/ui/input";
import { useT } from "@/lib/i18n/context";
import type {
	LiveAudioRendition,
	LiveVideoRendition,
	LiveWizardState,
} from "./build-live-plan";

/**
 * Live ladder — the VOD ladder narrowed to the live codec rails
 * (H264/H265 video, AAC/DD/DDPLUS audio; VP9/Atmos/WebVTT are VOD-only)
 * with the H264/H265 advanced editors reused verbatim. The
 * presetConfiguration select surfaces LIVE_* presets first because the
 * shared schema defaults to VOD_HIGH_QUALITY and the validator warns on
 * VOD presets (LIVE_PRESET_VOD).
 */

const LIVE_PRESETS = [
	"LIVE_STANDARD",
	"LIVE_LOW_LATENCY",
	"LIVE_LOWER_LATENCY",
	"LIVE_VERYLOW_LATENCY",
	"LIVE_ULTRALOW_LATENCY",
	"LIVE_HIGH_QUALITY",
	"LIVE_VERYHIGH_QUALITY",
	"LIVE_ULTRAHIGH_QUALITY",
] as const;

const VOD_PRESETS = [
	"VOD_HIGH_QUALITY",
	"VOD_QUALITY",
	"VOD_STANDARD",
	"VOD_SPEED",
	"VOD_HIGH_SPEED",
] as const;

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
	/**
	 * The relation, derived from the SAME state the builder reads :
	 * the tracks a rung may carry, and the tracks something already carries.
	 */
	const audioChoices = state.audios.map((audio, index) => ({
		key: aKeys[index] ?? `audio${index + 1}`,
		label: `${audio.codec} ${Math.round(audio.bitrate / 1000)}k`,
	}));
	/**
	 * This rung's selection, resolved against the tracks that CURRENTLY exist —
	 * a stored key outlives the rendition it named, and a stale key is not a
	 * selection. `buildLiveChannelPlan` filters the same way.
	 */
	const selectedFor = (video: LiveVideoRendition): string | undefined =>
		(video.muxedAudioKeys ?? []).find((key) =>
			audioChoices.some((choice) => choice.key === key),
		);
	const carriedAudioKeys = new Set(
		state.videos.flatMap((video) =>
			(video.container ?? "FMP4") === "TS" ? (video.muxedAudioKeys ?? []) : [],
		),
	);

	const patchAudio = (index: number, partial: Partial<LiveAudioRendition>) => {
		const next = [...stableAudios];
		const current = next[index];
		if (!current) {
			return;
		}
		next[index] = { ...current, ...partial };
		patchLadder({ audios: next });
	};

	const selectBundledAudio = (index: number, key: string) => {
		// Selecting a bundled track defaults to one delivery. The separate
		// checkbox remains available for an explicit standalone copy.
		patchLadder({
			videos: stableVideos.map((video, i) =>
				i === index
					? { ...video, muxedAudioKeys: key ? [key] : undefined }
					: video,
			),
			audios: stableAudios.map((audio, i) =>
				key && aKeys[i] === key ? { ...audio, ownContainer: false } : audio,
			),
		});
	};

	return (
		<div className="space-y-6">
			<div>
				<div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
					<h2 className="shrink-0 font-medium text-sm text-zinc-200">
						{t("ui.videoRenditionsH264H265")}
					</h2>
					<RenditionAddControls
						kind="video"
						label={t("ui.addVideo")}
						choices={state.videos.map((video, index) => ({
							key: vKeys[index] ?? String(index),
							index,
							label: videoCopyLabel(video, index),
						}))}
						onAdd={(index) =>
							patchLadder({
								videos: [
									...stableVideos,
									copyRendition<LiveVideoRendition>(
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
								<Field label={t("ui.codec")} htmlFor={`lw-v-${index}-codec`}>
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
										label={t("ui.heightP")}
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
										label={t("ui.bitrateBps")}
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
										label={t("ui.preset")}
										htmlFor={`lw-v-${index}-preset`}
										help={t("ui.pickALivePresetTheValidatorWarns")}
									>
										<SelectNative
											id={`lw-v-${index}-preset`}
											value={video.presetConfiguration ?? ""}
											onChange={(e) =>
												patchVideo(index, {
													presetConfiguration: e.target.value,
												})
											}
										>
											<option value="">{t("ui.schemaDefaultVodWarns")}</option>
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
								<Field
									label={t("ui.container")}
									htmlFor={`lw-v-${index}-container`}
									tooltip={`${t("ui.tsHlsOnlyH264Only")} ${t("wizard.cmafCompatibility")}`}
								>
									<SelectNative
										id={`lw-v-${index}-container`}
										className="w-24"
										value={video.container ?? "FMP4"}
										onChange={(e) =>
											patchVideo(index, {
												container: e.target.value as "FMP4" | "CMAF" | "TS",
											})
										}
									>
										<option value="FMP4">fMP4</option>
										{video.codec === "H264" ? (
											<option value="CMAF">CMAF</option>
										) : null}
										<option value="TS">{t("ui.ts")}</option>
									</SelectNative>
								</Field>
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
							{video.container === "CMAF" ? (
								<OptionsGrid
									idBase={`lw-v-${index}-cmaf`}
									value={video.cmaf ?? {}}
									fields={CMAF_CHUNK_FIELDS}
									onChange={(cmaf) => patchVideo(index, { cmaf })}
								/>
							) : null}
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
							{/*
							 * Which track rides inside THIS rung  — TS only,
							 * because `additionalStreamKeys` is on the TS schema; single,
							 * because a manifest references the container and cannot pick
							 * between tracks inside it. Its own row under the rung (row
							 * #326, owner): inline it widened the flex row and reflowed
							 * width/height/bitrate/preset/container whenever TS was chosen.
							 */}
							{(video.container ?? "FMP4") === "TS" &&
							audioChoices.length > 0 ? (
								<div className="max-w-md">
									<Field
										label={t("wizard.muxedAudio")}
										htmlFor={`lw-v-${index}-muxaudio`}
										tooltip={
											selectedFor(video)
												? t("wizardX.muxedAudioCarrying", {
														key: selectedFor(video) ?? "",
													})
												: t("wizard.muxedAudioHint")
										}
									>
										<SelectNative
											id={`lw-v-${index}-muxaudio`}
											value={selectedFor(video) ?? ""}
											onChange={(e) =>
												selectBundledAudio(index, e.target.value)
											}
										>
											<option value="">{t("wizard.muxedAudioNone")}</option>
											{audioChoices.map((choice) => (
												<option key={choice.key} value={choice.key}>
													{choice.key} · {choice.label}
												</option>
											))}
										</SelectNative>
									</Field>
								</div>
							) : null}
							{video.codec === "H264" ? (
								<H264AdvancedEditor
									allowCrf={false}
									idBase={`lw-v-${index}-h264`}
									value={video.h264}
									onChange={(h264) => patchVideo(index, { h264 })}
								/>
							) : (
								<H265AdvancedEditor
									allowCrf={false}
									idBase={`lw-v-${index}-h265`}
									value={video.h265}
									visionMetadataKeys={[]}
									onChange={(h265) => patchVideo(index, { h265 })}
								/>
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
						{t("ui.audioRenditionsAacDdDd")}
					</h2>
					<RenditionAddControls
						kind="audio"
						label={t("ui.addAudio")}
						choices={state.audios.map((audio, index) => ({
							key: aKeys[index] ?? String(index),
							index,
							label: audioCopyLabel(audio, index),
						}))}
						onAdd={(index) =>
							patchLadder({
								audios: [
									...stableAudios,
									copyRendition<LiveAudioRendition>(
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
							<Field label={t("ui.codec")} htmlFor={`lw-a-${index}-codec`}>
								<SelectNative
									id={`lw-a-${index}-codec`}
									className="w-28"
									value={audio.codec}
									onChange={(e) =>
										patchAudio(index, {
											codec: e.target.value as LiveAudioRendition["codec"],
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
									label={t("ui.bitrateBps")}
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
									label={t("ui.sampleRateHz")}
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
									label={t("ui.channelLayout")}
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
							<Field
								label={t("ui.container")}
								htmlFor={`lw-a-${index}-container`}
								tooltip={`${t("ui.tsHlsOnlyAacOnly")} ${t("wizard.cmafCompatibility")}`}
							>
								<SelectNative
									id={`lw-a-${index}-container`}
									className="w-24"
									value={audio.container ?? "FMP4"}
									onChange={(e) =>
										patchAudio(index, {
											container: e.target.value as "FMP4" | "CMAF" | "TS",
										})
									}
								>
									<option value="FMP4">fMP4</option>
									{audio.codec === "AAC" ? (
										<option value="CMAF">CMAF</option>
									) : null}
									<option value="TS">{t("ui.ts")}</option>
								</SelectNative>
							</Field>
							{/*
							 * Does this track ALSO ship standalone?
							 *
							 * WHICH rungs carry it is stated on the video rows, not
							 * here — a flag on the audio row can only broadcast one
							 * track to every rung, and a channel may well want
							 * v540←a128, v720←a64 and a48 standalone.
							 */}
							{/*  (owner): the explanation lives in the ⓘ mark — it
							    changes with the checkbox, and as an always-on hint it
							    reflowed the row on every toggle. */}
							<Field
								label={t("wizard.ownContainer")}
								htmlFor={`lw-a-${index}-own`}
								tooltip={
									audio.ownContainer === false
										? carriedAudioKeys.has(aKeys[index] ?? "")
											? t("wizard.ownContainerOffHint")
											: t("wizard.ownContainerOffUncarriedHint")
										: t("wizard.ownContainerOnHint")
								}
							>
								<label
									htmlFor={`lw-a-${index}-own`}
									className="flex items-center gap-2 text-xs text-zinc-300"
								>
									<input
										id={`lw-a-${index}-own`}
										type="checkbox"
										className="h-3.5 w-3.5 accent-emerald-600"
										checked={audio.ownContainer !== false}
										onChange={(e) =>
											patchAudio(index, {
												ownContainer: e.target.checked ? undefined : false,
											})
										}
									/>
									{t("wizard.ownContainerLabel")}
								</label>
							</Field>
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
							{audio.container === "CMAF" ? (
								<div className="basis-full">
									<OptionsGrid
										idBase={`lw-a-${index}-cmaf`}
										value={audio.cmaf ?? {}}
										fields={CMAF_CHUNK_FIELDS}
										onChange={(cmaf) => patchAudio(index, { cmaf })}
									/>
								</div>
							) : null}
						</div>
					))}
				</div>
			</div>

			<Field
				label={t("ui.segmentLengthS")}
				htmlFor="lw-seglen"
				help={t("ui.sharedByEveryMuxingFeedsTheC8")}
			>
				<Input
					id="lw-seglen"
					type="number"
					className="w-32"
					value={state.segmentLength}
					onChange={(e) =>
						onPatch({ segmentLength: Math.max(0, Number(e.target.value)) })
					}
				/>
			</Field>
		</div>
	);
}
