"use client";

import { audioKeys, videoKeys } from "@/app/vod/new/build-plan";
import { CMAF_CHUNK_FIELDS } from "@/app/vod/new/cmaf-fields";
import {
	audioCopyLabel,
	videoCopyLabel,
} from "@/app/vod/new/rendition-add-controls";
import { Collapsible, OptionsGrid } from "@/app/vod/new/wizard-fields";
import { Field } from "@/components/ui/field";
import { SelectNative } from "@/components/ui/input";
import { useT } from "@/lib/i18n/context";
import type {
	LiveAudioRendition,
	LiveVideoRendition,
	LiveWizardState,
} from "./build-live-plan";
import { LiveMuxingFields } from "./live-rendition-fields";

/** Container and file settings share the existing rendition state. */
export function LiveMuxingsSection({
	state,
	onPatch,
}: {
	state: LiveWizardState;
	onPatch: (partial: Partial<LiveWizardState>) => void;
}) {
	const { t } = useT();
	// Freeze derived identities before changing any packaging or audio relation.
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
	const patchPackaging = (partial: Partial<LiveWizardState>) =>
		onPatch({ videos: stableVideos, audios: stableAudios, ...partial });
	const patchVideo = (index: number, partial: Partial<LiveVideoRendition>) => {
		const next = [...stableVideos];
		const current = next[index];
		if (!current) {
			return;
		}
		next[index] = { ...current, ...partial };
		patchPackaging({ videos: next });
	};
	const audioChoices = state.audios.map((audio, index) => ({
		key: aKeys[index] ?? `audio${index + 1}`,
		label: `${audio.codec} ${Math.round(audio.bitrate / 1000)}k`,
	}));
	/**
	 * This track's selection, resolved against the tracks that CURRENTLY exist —
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
		patchPackaging({ audios: next });
	};

	const selectBundledAudio = (index: number, key: string) => {
		// Selecting a bundled track defaults to one delivery. The separate
		// checkbox remains available for an explicit standalone copy.
		patchPackaging({
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
			<section className="space-y-3" aria-labelledby="lw-video-muxings">
				<h2 id="lw-video-muxings" className="font-medium text-sm text-zinc-200">
					{t("wizard.videoRenditions")}
				</h2>
				{state.videos.map((video, index) => (
					<div
						key={vKeys[index]}
						className="space-y-3 rounded-md border border-zinc-800 p-3"
					>
						<div className="flex flex-wrap items-center gap-2">
							<span className="font-mono text-xs text-zinc-300">
								{vKeys[index]}
							</span>
							<span className="text-xs text-zinc-500">
								{videoCopyLabel(video, index)}
							</span>
						</div>

						<Field
							label={t("wizard.container")}
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
						{video.container === "CMAF" ? (
							<OptionsGrid
								idBase={`lw-v-${index}-cmaf`}
								value={video.cmaf ?? {}}
								fields={CMAF_CHUNK_FIELDS}
								onChange={(cmaf) => patchVideo(index, { cmaf })}
							/>
						) : null}
						{(video.container ?? "FMP4") === "TS" && audioChoices.length > 0 ? (
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
										onChange={(e) => selectBundledAudio(index, e.target.value)}
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
						<Collapsible summary={t("wizard.advanced")}>
							<LiveMuxingFields
								idBase={`lw-v-${index}`}
								state={state}
								muxing={video.muxing}
								container={video.container ?? "FMP4"}
								onMuxingChange={(muxing) => patchVideo(index, { muxing })}
							/>
						</Collapsible>
					</div>
				))}
			</section>
			<section className="space-y-3" aria-labelledby="lw-audio-muxings">
				<h2 id="lw-audio-muxings" className="font-medium text-sm text-zinc-200">
					{t("wizard.audioRenditions")}
				</h2>
				{state.audios.map((audio, index) => (
					<div
						key={aKeys[index]}
						className="space-y-3 rounded-md border border-zinc-800 p-3"
					>
						<div className="flex flex-wrap items-center gap-2">
							<span className="font-mono text-xs text-zinc-300">
								{aKeys[index]}
							</span>
							<span className="text-xs text-zinc-500">
								{audioCopyLabel(audio, index)}
							</span>
						</div>
						<div className="flex flex-wrap items-start gap-3">
							<Field
								label={t("wizard.container")}
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
						</div>

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
						<Collapsible summary={t("wizard.advanced")}>
							<LiveMuxingFields
								idBase={`lw-a-${index}`}
								state={state}
								muxing={audio.muxing}
								container={audio.container ?? "FMP4"}
								ownsContainer={
									audio.ownContainer !== false ||
									!carriedAudioKeys.has(aKeys[index] ?? "")
								}
								onMuxingChange={(muxing) => patchAudio(index, { muxing })}
							/>
						</Collapsible>
					</div>
				))}
			</section>
		</div>
	);
}
