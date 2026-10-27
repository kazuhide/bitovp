"use client";

import type { CredentialSummaryWire } from "@bitovp/core";
import {
	filterFamily,
	INTERNAL_HEVC_V2_BCF_VERSION,
	QC_GATE_METRICS,
} from "@bitovp/core";
import { useEffect, useId } from "react";
import { InfrastructureIdPicker } from "@/components/infrastructure-pickers";
import { PrewarmedPoolPicker } from "@/components/prewarmed-pool-picker";
import { RegionSelect } from "@/components/region-select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldRowAction } from "@/components/ui/field";
import { HelpOverlay } from "@/components/ui/help-overlay";
import { InfoHint } from "@/components/ui/info-hint";
import { Input, SelectNative } from "@/components/ui/input";
import { NewCredentialLink } from "@/components/ui/new-credential-link";
import { useQcVmafEnabled } from "@/lib/feature-flags/context";
import { useT } from "@/lib/i18n/context";
import { AisaScheduleEditor } from "./aisa-schedule";
import { AUDIO_CHANNEL_LAYOUTS } from "./audio-channel-layouts";
import { AudioMixEditor } from "./audio-mix-editor";
import type {
	WizardAudioCodec,
	WizardAudioRendition,
	WizardDashOptions,
	WizardDeinterlaceFilter,
	WizardExtraManifest,
	WizardHlsOptions,
	WizardJitPlacement,
	WizardKantar,
	WizardPerTitleCodec,
	WizardQc,
	WizardRenditionExtras,
	WizardStartOptions,
	WizardState,
	WizardSubtitle,
	WizardVideoCodec,
	WizardVideoRendition,
} from "./build-plan";
import {
	audioKeys,
	DEFAULT_WIZARD_QC,
	subtitleKeys,
	videoKeys,
	wizardUsesCodecEncodingMode,
} from "./build-plan";
import { AudioCutoffEditor } from "./codec-detail-editor";
import { editFilter } from "./filter-editing";
import { MediaFilterEditor } from "./media-filter-editor";
import { PerTitleSimulatorLauncher } from "./per-title-simulator-launcher";
import {
	audioCopyLabel,
	RenditionAddControls,
	videoCopyLabel,
} from "./rendition-add-controls";
import {
	addVodAudio,
	addVodVideo,
	updateVodVideoHeight,
	updateVodVideoModePaths,
} from "./rendition-copy";
import {
	Av1AdvancedEditor,
	ExtrasEditor,
	H264AdvancedEditor,
	H265AdvancedEditor,
	H265V2AdvancedEditor,
	LoudnessEditor,
	manifestPlacement,
	RenditionPlacement,
	type SourceOption,
	Vp9AdvancedEditor,
} from "./rendition-editors";
import {
	flattenStreams,
	inputFileOptions,
	streamReferenceLabel,
} from "./stream-model";
import { VmafExecutionSettings } from "./vmaf-execution-settings";
import {
	CodesInput,
	Collapsible,
	type OptionFieldSpec,
	OptionsGrid,
	ResourceKeyInput,
	RowRemoveButton,
} from "./wizard-fields";

type LadderSectionProps = {
	hevcV2Available?: boolean;
	state: WizardState;
	credentials: CredentialSummaryWire[];
	onPatch: (partial: Partial<WizardState>) => void;
};

const VIDEO_CODECS: WizardVideoCodec[] = ["H264", "H265", "VP9", "AV1"];
const AUDIO_CODECS: WizardAudioCodec[] = [
	"AAC",
	"AC3",
	"EAC3",
	"OPUS",
	"DOLBY_ATMOS",
	"DDPLUS",
	"DD",
];

/**
 * VMAF models the worker can score with. Two families:
 *  - vmaf_v0.6.1 / neg / 4k: libvmaf built-ins — reachable on any worker.
 *  - "VMAF v1" (vmaf_v1.0.16_*, Netflix vmaf 3.2.0): NOT libvmaf built-ins and
 *    there is no plain `vmaf_v1.0.16` — each carries a viewing-distance suffix
 *    (_3d0h = 3.0 display-heights / standard, _5d0h = farther, _2160 = tuned for
 *    4k displays, _hfr = high frame rate). The Docker worker bundles their JSONs
 *    and the runner loads them by FILE (`model=path=`); they need no libvmaf
 *    upgrade. **`vmaf_v1.0.16_3d0h` is the default** (core's
 *    `DEFAULT_VMAF_MODEL`, owner directive 2026-08-16): v1's standard viewing
 *    condition. The v0.6.1 built-ins stay listed FIRST — they are the fallback
 *    for a worker image without the bundled model files.
 */
/*
 * Exported so `vmaf-models.test.ts` can check every entry against
 * `docker/vmaf-models.sha256`, the repo-side manifest of what the worker image
 * downloads. Nothing connected the two sides before, so a typo here would ship as
 * a live option that fails only after a full encode.
 */
export const VMAF_MODELS = [
	"vmaf_v0.6.1",
	"vmaf_v0.6.1neg",
	"vmaf_4k_v0.6.1",
	// VMAF v1 (bundled model files; Docker worker). All eight are offered because
	// all eight were MEASURED loading and scoring through the product's own command
	// builder on 2026-08-11 (scripts/vmaf-model-matrix.ts) — before that only
	// vmaf_v1.0.16_3d0h had ever produced a score and the other entries here were a
	// promise. Ordered close → far, sdr before hfr, so the list reads as the scale
	// it is.
	"vmaf_v1.0.16_1d5h_2160",
	"vmaf_v1.0.16_3d0h",
	"vmaf_v1.0.16_3d0h_2160",
	"vmaf_v1.0.16_5d0h",
	"vmaf_v1.0.16_hfr_1d5h_2160",
	"vmaf_v1.0.16_hfr_3d0h",
	"vmaf_v1.0.16_hfr_3d0h_2160",
	"vmaf_v1.0.16_hfr_5d0h",
	// Deliberately NOT offered: the float_ variants. Measured at ~4.4x the scoring
	// time (3.1s vs 0.7s on a 120-frame pair) for a ~0.02 score difference, which is
	// not a trade an operator would knowingly make. Still reachable via expert
	// raw-JSON — resolveModelPath finds any bundled <name>.json.
] as const;

const DEINTERLACE_FIELDS: OptionFieldSpec[] = [
	{
		key: "parity",
		labelKey: "wizard.parity",
		control: { options: ["AUTO", "TOP_FIELD_FIRST", "BOTTOM_FIELD_FIRST"] },
	},
	{
		key: "mode",
		labelKey: "wizard.mode",
		control: {
			options: ["FRAME", "FIELD", "FRAME_NOSPATIAL", "FIELD_NOSPATIAL"],
		},
	},
	{
		key: "frameSelectionMode",
		labelKey: "wizard.frameSelection",
		control: { options: ["ALL", "INTERLACED"] },
	},
	{
		key: "autoEnable",
		labelKey: "wizard.autoEnable",
		control: {
			options: ["ALWAYS_ON", "META_DATA_BASED", "META_DATA_AND_CONTENT_BASED"],
		},
	},
];

function isPerTitle(extras: WizardRenditionExtras | undefined): boolean {
	return extras?.mode !== undefined && extras.mode !== "STANDARD";
}

/** Ladder editor — full P2 codec families plus per-rendition extras. */
export function LadderSection({
	hevcV2Available = false,
	state,
	credentials,
	onPatch,
}: LadderSectionProps) {
	const { t, locale } = useT();
	const ja = locale === "ja";
	const { videos, audios } = state;
	const perTitleSelected =
		videos.length > 0 && videos.every((video) => isPerTitle(video.extras));
	const vKeys = videoKeys(videos);
	const aKeys = audioKeys(audios);
	const subtitles = state.subtitles ?? [];
	const filters = state.filters ?? [];
	const sources = state.sources ?? {};
	const encodingKeys = (sources.encodings ?? []).map((e) => e.key);
	const filterKeys = filters.map((f) => f.key);
	let filterNumber = 1;
	while (filterKeys.includes(`deint${filterNumber}`)) filterNumber += 1;
	const visionMetadataKeys = (sources.dolbyStreams ?? [])
		.filter((s) => s.kind === "VISION_METADATA")
		.map((s) => s.key);
	const nexguardCredentials = credentials.filter(
		(c) => c.provider === "NEXGUARD",
	);
	// What the Manifests step declared — drives the conditional placement
	// guidance (HLS audio-group fields, declared DASH adaptation sets with
	// per-manifest context and cross-manifest type-conflict warnings).

	// Reference streams by a human-readable label (type · input file / object),
	// not the hidden internal key. The select still stores the key — only the
	// visible text changes, so the emitted plan is unaffected. WEBVTT streams
	// are subtitle-only, so they stay out of the video/audio source lists.
	const allStreams = flattenStreams(sources);
	// Trimming/concatenation intermediate streams aren't in flattenStreams (they
	// reference other input streams, not input files) — surface them as selectable
	// sources so a rendition can read a trim/concat result by key.
	const trimConcatSources: SourceOption[] = [
		// `trim`, not `t` — the callback parameter used to be `t`, which shadowed the
		// translator inside this block.
		...(sources.trimmingStreams ?? []).map((trim) => ({
			value: trim.key,
			label: t("wizardX.trimSourceKey", {
				source: trim.sourceKey,
				key: trim.key,
			}),
		})),
		...(sources.concatenationStreams ?? []).map((c) => ({
			value: c.key,
			label: t("wizardX.concatenationKey", { key: c.key }),
		})),
	];
	const namedSources: SourceOption[] = [
		...allStreams
			.filter((s) => s.type !== "WEBVTT")
			.map((s) => ({ value: s.key, label: streamReferenceLabel(state, s) })),
		...trimConcatSources,
	];
	const videoSources: SourceOption[] = [
		{ value: "", label: t("wizard.inputVideoTrackImplicit") },
		...namedSources,
	];
	const audioSources: SourceOption[] = [
		...(sources.audioMixStreams ?? []).map((s) => ({
			value: s.key,
			label: `${t("audioMix.title")} · ${s.key}`,
		})),
		{ value: "", label: t("wizard.inputAudioTrackImplicit") },
		...namedSources,
	];

	const patchVideos = (
		next: WizardVideoRendition[],
		enableDefaults = false,
		activateHevcV2 = false,
		referencePatch: Partial<WizardState> = {},
	) => {
		const perTitle = { ...state.startOptions?.perTitle };
		let enteredPerTitle = false;
		const normalized = next.map((video, index) => {
			if (!isPerTitle(video.extras)) return video;
			if (
				enableDefaults ||
				!isPerTitle(videos[index]?.extras) ||
				(video.codec === "H265V2" ? "H265" : (video.codec ?? "H264")) !==
					(videos[index]?.codec === "H265V2"
						? "H265"
						: (videos[index]?.codec ?? "H264"))
			) {
				const codec = (
					video.codec === "H265V2" ? "H265" : (video.codec ?? "H264")
				).toLowerCase() as keyof typeof perTitle;
				perTitle[codec] = { ...perTitle[codec], autoRepresentations: true };
				enteredPerTitle = true;
			}
			return { ...video, bitrate: null };
		});
		const modePaths = updateVodVideoModePaths(
			{ ...state, ...referencePatch, videos },
			normalized,
		);
		onPatch({
			...referencePatch,
			...modePaths,
			internal: normalized.some((video) => video.codec === "H265V2")
				? (state.internal ??
					(activateHevcV2
						? { hevcV2: { bcfVersion: INTERNAL_HEVC_V2_BCF_VERSION } }
						: undefined))
				: videos.some((video) => video.codec === "H265V2")
					? undefined
					: state.internal,
			...(enteredPerTitle
				? {
						startOptions: { ...state.startOptions, perTitle },
						timing: "POST_ENCODING" as const,
					}
				: {}),
		});
	};
	const patchVideo = (
		index: number,
		partial: Partial<WizardVideoRendition>,
	) => {
		const current = videos[index];
		if (!current) {
			return;
		}
		const heightPatch =
			partial.height !== undefined && partial.height !== current.height
				? updateVodVideoHeight(state, index, partial.height)
				: {};
		const next = [...(heightPatch.videos ?? videos)];
		const switchingV2 =
			partial.codec !== undefined &&
			partial.codec !== current.codec &&
			(partial.codec === "H265V2" || current.codec === "H265V2");
		next[index] = {
			...(next[index] ?? current),
			...partial,
			...(switchingV2
				? {
						h265: current.h265,
						encodingMode: partial.codec === "H265V2" ? "SMART_PASS" : undefined,
					}
				: {}),
		};
		patchVideos(
			next,
			false,
			partial.codec === "H265V2" && current.codec !== "H265V2",
			heightPatch,
		);
	};
	const patchAudio = (
		index: number,
		partial: Partial<WizardAudioRendition>,
	) => {
		const next = [...audios];
		const current = next[index];
		if (!current) {
			return;
		}
		next[index] = { ...current, ...partial };
		onPatch({ audios: next });
	};
	const patchSubtitle = (index: number, partial: Partial<WizardSubtitle>) => {
		const next = [...subtitles];
		const current = next[index];
		if (!current) {
			return;
		}
		next[index] = { ...current, ...partial };
		onPatch({ subtitles: next });
	};

	return (
		<div className="space-y-6">
			<div>
				<div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
					<h2 className="shrink-0 font-medium text-sm text-zinc-200">
						{t("wizard.videoRenditions")}
					</h2>
					{perTitleSelected ? (
						<PerTitleSimulatorLauncher
							state={state}
							onPatch={onPatch}
							hevcV2Available={hevcV2Available}
						/>
					) : null}
					{/* (a): PER_TITLE vs STANDARD reshapes the whole ladder,
					    yet lived one disclosure deep PER RENDITION. This writes every
					    video rendition's mode at once; the per-rendition select stays
					    as the override, and a mixed ladder says so instead of lying
					    with either value. C1 wiring is untouched — mode still rides
					    extras.mode per rendition. */}
					<fieldset className="flex flex-wrap items-center gap-3">
						<legend className="sr-only">{t("wizard.streamModeAll")}</legend>
						<span className="text-xs text-zinc-500">
							{t("wizard.streamModeAll")}
						</span>
						{(
							[
								["STANDARD", t("wizard.modeStandard")],
								["PER_TITLE_TEMPLATE", t("wizard.modePerTitle")],
							] as const
						).map(([mode, label]) => {
							const modes = videos.map((v) => v.extras?.mode ?? "STANDARD");
							const allThis = modes.every((m) =>
								mode === "STANDARD"
									? m === "STANDARD"
									: m.startsWith("PER_TITLE"),
							);
							return (
								<label
									key={mode}
									className="flex items-center gap-1.5 text-xs text-zinc-300"
								>
									<input
										type="radio"
										name="wz-ladder-mode"
										className="h-3.5 w-3.5 accent-emerald-600"
										checked={videos.length > 0 && allThis}
										onChange={() =>
											patchVideos(
												videos.map((v) => ({
													...v,
													extras: {
														...v.extras,
														// review-255 119-A1: the radio sets the FAMILY — a
														// rendition already Per-Title keeps its more-specific
														// FIXED variant instead of a silent downgrade.
														mode:
															mode === "STANDARD"
																? undefined
																: v.extras?.mode?.startsWith("PER_TITLE")
																	? v.extras.mode
																	: mode,
													},
												})),
												mode !== "STANDARD",
											)
										}
									/>
									{label}
								</label>
							);
						})}
						{videos.length > 0 &&
						!videos.every(
							(v) => (v.extras?.mode ?? "STANDARD") === "STANDARD",
						) &&
						!videos.every((v) =>
							(v.extras?.mode ?? "STANDARD").startsWith("PER_TITLE"),
						) ? (
							<Badge tone="neutral">{t("wizard.modeMixed")}</Badge>
						) : null}
					</fieldset>
					<RenditionAddControls
						kind="video"
						label={t("wizard.addVideo")}
						choices={videos.flatMap((video, index) =>
							video.codec === "H265V2" && !hevcV2Available
								? []
								: [
										{
											key: vKeys[index] ?? String(index),
											index,
											label: videoCopyLabel(video, index),
										},
									],
						)}
						onAdd={(index) => onPatch(addVodVideo(state, index))}
					/>
				</div>
				<div className="mt-2 space-y-3">
					{videos.map((video, index) => {
						const codec = video.codec ?? "H264";
						const perTitle = isPerTitle(video.extras);
						return (
							<div
								key={index}
								className="space-y-3 rounded-md border border-zinc-800 p-3"
							>
								<div className="flex flex-wrap items-start gap-2">
									<Field
										label={t("wizard.codec")}
										htmlFor={`wz-v-${index}-codec`}
									>
										<SelectNative
											id={`wz-v-${index}-codec`}
											className="w-28"
											value={codec}
											onChange={(e) =>
												patchVideo(index, {
													codec: e.target.value as WizardVideoCodec,
												})
											}
										>
											{[
												...VIDEO_CODECS,
												...(hevcV2Available ? ["H265V2" as const] : []),
											].map((c) => (
												<option key={c} value={c}>
													{c === "H265V2" ? "HEVCv2" : c}
												</option>
											))}
										</SelectNative>
									</Field>
									<Field
										label={t("wizard.encodingMode")}
										htmlFor={`wz-v-${index}-encoding-mode`}
									>
										<SelectNative
											id={`wz-v-${index}-encoding-mode`}
											className="w-36"
											disabled={codec === "H265V2"}
											value={
												codec === "H265V2"
													? "SMART_PASS"
													: (video.encodingMode ?? "")
											}
											onChange={(event) =>
												patchVideo(index, {
													encodingMode:
														event.target.value === ""
															? undefined
															: (event.target
																	.value as WizardVideoRendition["encodingMode"]),
												})
											}
										>
											{codec === "H265V2" ? (
												<option value="SMART_PASS">SMART_PASS</option>
											) : (
												<>
													<option value="">{t("wizard.default")}</option>
													{[
														"STANDARD",
														"SINGLE_PASS",
														"TWO_PASS",
														"THREE_PASS",
													].map((mode) => (
														<option key={mode} value={mode}>
															{mode}
														</option>
													))}
												</>
											)}
										</SelectNative>
									</Field>
									<div className="flex-1">
										<Field
											label={t("wizard.heightP")}
											htmlFor={`wz-v-${index}-height`}
										>
											<Input
												id={`wz-v-${index}-height`}
												type="number"
												aria-label={t("wizardX.videoNHeight", { n: index + 1 })}
												value={video.height ?? ""}
												onChange={(e) =>
													patchVideo(index, {
														height:
															e.target.value === ""
																? null
																: Math.max(
																		0,
																		Math.round(Number(e.target.value)),
																	),
													})
												}
											/>
										</Field>
									</div>
									<div className="flex-1">
										<Field
											label={t("wizard.bitrateBps")}
											htmlFor={`wz-v-${index}-bitrate`}
											hint={
												perTitle
													? t("wizard.perTitleLeavesBitrateToTheAlgorithm")
													: undefined
											}
										>
											<Input
												id={`wz-v-${index}-bitrate`}
												type="number"
												aria-label={t("wizardX.videoNBitrate", {
													n: index + 1,
												})}
												disabled={perTitle}
												value={perTitle ? "" : (video.bitrate ?? "")}
												onChange={(e) =>
													patchVideo(index, {
														bitrate:
															e.target.value === ""
																? null
																: Math.max(
																		0,
																		Math.round(Number(e.target.value)),
																	),
													})
												}
											/>
										</Field>
									</div>
									<FieldRowAction>
										<Button
											variant="destructive"
											size="sm"
											aria-label={t("wizardX.removeVideoN", { n: index + 1 })}
											onClick={() =>
												patchVideos(videos.filter((_, i) => i !== index))
											}
										>
											{t("wizard.remove")}
										</Button>
									</FieldRowAction>
								</div>
								{codec === "H264" ? (
									<H264AdvancedEditor
										idBase={`wz-v-${index}-h264`}
										value={video.h264}
										onChange={(h264) => patchVideo(index, { h264 })}
									/>
								) : codec === "H265V2" ? (
									<H265V2AdvancedEditor
										idBase={`wz-v-${index}-h265v2`}
										qualityControlsAvailable={hevcV2Available}
										value={video.h265}
										onChange={(h265) => patchVideo(index, { h265 })}
									/>
								) : codec === "H265" ? (
									<H265AdvancedEditor
										idBase={`wz-v-${index}-h265`}
										value={video.h265}
										visionMetadataKeys={visionMetadataKeys}
										onChange={(h265) => patchVideo(index, { h265 })}
									/>
								) : codec === "VP9" ? (
									<Vp9AdvancedEditor
										idBase={`wz-v-${index}-vp9`}
										value={video.vp9}
										onChange={(vp9) => patchVideo(index, { vp9 })}
									/>
								) : (
									<Av1AdvancedEditor
										idBase={`wz-v-${index}-av1`}
										value={video.av1}
										onChange={(av1) => patchVideo(index, { av1 })}
									/>
								)}
								<ExtrasEditor
									idBase={`wz-v-${index}-x`}
									family="video"
									videoWidth={video.width ?? undefined}
									onVideoWidthChange={(width) => patchVideo(index, { width })}
									onDefineDeinterlace={() => {
										// (b): one gesture — the plan-level resource is
										// created here (key din-N, first free) and the caller
										// attaches it. The definitions section beside the ladder
										// shows it immediately for parameter edits.
										let n = 1;
										while (filters.some((f) => f.key === `din-${n}`)) {
											n += 1;
										}
										const key = `din-${n}`;
										onPatch({
											filters: [...filters, { key }],
										});
										return key;
									}}
									inputFiles={inputFileOptions(state)}
									extras={video.extras}
									sourceOptions={videoSources}
									encodingKeys={encodingKeys}
									filterKeys={filters
										.filter(
											(f) => filterFamily(f.kind ?? "DEINTERLACE") === "video",
										)
										.map((f) => f.key)}
									nexguardCredentials={nexguardCredentials}
									onChange={(extras) =>
										patchVideo(index, {
											extras,
											// Switching into a per-title mode hands bitrate to the
											// algorithm — the plan carries an explicit null.
											...(isPerTitle(extras) && !isPerTitle(video.extras)
												? { bitrate: null }
												: {}),
										})
									}
								/>
							</div>
						);
					})}
					{videos.length === 0 ? (
						<p className="text-xs text-zinc-500">
							{t("wizard.noVideoRenditionsAudioOnlyPlansAre")}
						</p>
					) : null}
				</div>
			</div>

			{/* (b): the plan-level filter DEFINITIONS lived below the
			    WebVTT block — the owner found them there. They now sit beside the
			    video renditions they serve, framed as advanced (the common path
			    is the per-rendition inline define; API parity keeps every SDK
			    field reachable here). */}
			<Collapsible
				summary={t("wizardX.deinterlaceFiltersCount", {
					count: filters.length,
				})}
				help={t("ui.planLevelFilterResourcesAttachThemPer")}
			>
				{filters.map((filter, index) => (
					<div
						key={index}
						className="space-y-3 rounded-md border border-zinc-800 p-3"
					>
						<div className="flex items-start gap-2">
							<div className="flex-1">
								<Field
									label={t("wizard.filterKey")}
									htmlFor={`wz-flt-${index}-key`}
								>
									<ResourceKeyInput
										id={`wz-flt-${index}-key`}
										value={filter.key}
										onCommit={(key) =>
											onPatch(
												editFilter(state, index, { ...filter, key }, true),
											)
										}
									/>
								</Field>
							</div>
							<FieldRowAction>
								<RowRemoveButton
									label={t("wizardX.removeFilterN", { n: index + 1 })}
									onClick={() =>
										onPatch({
											filters: filters.filter((_, i) => i !== index),
											manualFilterKeys: state.manualFilterKeys?.filter(
												(key) => key !== filter.key,
											),
										})
									}
								/>
							</FieldRowAction>
						</div>
						<MediaFilterEditor
							idBase={`wz-flt-${index}`}
							filter={filter}
							inputFiles={state.inputFiles}
							onChange={(next) => onPatch(editFilter(state, index, next))}
						/>
						{!filter.kind || filter.kind === "DEINTERLACE" ? (
							<OptionsGrid
								idBase={`wz-flt-${index}-deinterlace`}
								value={filter}
								fields={DEINTERLACE_FIELDS}
								onChange={(next: WizardDeinterlaceFilter) => {
									const list = [...filters];
									list[index] = next;
									onPatch({ filters: list });
								}}
							/>
						) : null}
					</div>
				))}
				<Button
					variant="secondary"
					size="sm"
					onClick={() =>
						onPatch({
							filters: [...filters, { key: `deint${filterNumber}` }],
						})
					}
				>
					{t("wizard.addDeinterlaceFilter")}
				</Button>
			</Collapsible>

			<div>
				<div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
					<h2 className="shrink-0 font-medium text-sm text-zinc-200">
						{t("wizard.audioRenditions")}
					</h2>
					<RenditionAddControls
						kind="audio"
						label={t("wizard.addAudio")}
						choices={audios.map((audio, index) => ({
							key: aKeys[index] ?? String(index),
							index,
							label: audioCopyLabel(audio, index),
						}))}
						onAdd={(index) => onPatch(addVodAudio(state, index))}
					/>
				</div>
				<div className="mt-2 space-y-3">
					{audios.map((audio, index) => {
						const codec = audio.codec ?? "AAC";
						return (
							<div
								key={index}
								className="space-y-3 rounded-md border border-zinc-800 p-3"
							>
								<div className="flex items-start gap-2">
									<Field
										label={t("wizard.codec")}
										htmlFor={`wz-a-${index}-codec`}
										tooltip={
											codec === "OPUS"
												? ja
													? "WebMに出力します。DASHの音声コンテナーもWEBMを選択してください。HLSにはAACなどの別トラックを使用してください。"
													: "Use WebM packaging and WEBM as the DASH audio muxing kind. Use a separate AAC or other supported track for HLS."
												: undefined
										}
									>
										<SelectNative
											id={`wz-a-${index}-codec`}
											className="w-36"
											value={codec}
											onChange={(e) =>
												patchAudio(index, {
													codec: e.target.value as WizardAudioCodec,
													channelLayout: undefined,
													cutoffFrequency: undefined,
													...(e.target.value === "OPUS"
														? {
																rate: 48000,
																muxing: { ...audio.muxing, kind: "WEBM" },
															}
														: codec === "OPUS"
															? { muxing: { ...audio.muxing, kind: "FMP4" } }
															: {}),
												})
											}
										>
											{AUDIO_CODECS.map((c) => (
												<option key={c} value={c}>
													{c}
												</option>
											))}
										</SelectNative>
									</Field>
									<div className="flex-1">
										<Field
											label={t("wizard.bitrateBps")}
											htmlFor={`wz-a-${index}-bitrate`}
										>
											<Input
												id={`wz-a-${index}-bitrate`}
												type="number"
												aria-label={t("wizardX.audioNBitrate", {
													n: index + 1,
												})}
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
									<div className="flex-1">
										<Field
											label={t("wizard.sampleRateHz")}
											htmlFor={`wz-a-${index}-rate`}
										>
											<Input
												id={`wz-a-${index}-rate`}
												type="number"
												aria-label={t("wizardX.audioNSampleRate", {
													n: index + 1,
												})}
												value={audio.rate}
												onChange={(e) =>
													patchAudio(index, {
														rate: Math.max(
															0,
															Math.round(Number(e.target.value)),
														),
													})
												}
											/>
										</Field>
									</div>
									<FieldRowAction>
										<Button
											variant="destructive"
											size="sm"
											aria-label={t("wizardX.removeAudioN", { n: index + 1 })}
											onClick={() =>
												onPatch({
													audios: audios.filter((_, i) => i !== index),
												})
											}
										>
											{t("wizard.remove")}
										</Button>
									</FieldRowAction>
								</div>
								{codec === "DOLBY_ATMOS" ? (
									<LoudnessEditor
										idBase={`wz-a-${index}-loud`}
										value={audio.loudness}
										onChange={(loudness) => patchAudio(index, { loudness })}
									/>
								) : (
									<Field
										label={t("wizard.channelLayout")}
										htmlFor={`wz-a-${index}-cl`}
										help={t("wizard.clEnumEmptyClStereo")}
									>
										<SelectNative
											id={`wz-a-${index}-cl`}
											value={audio.channelLayout ?? ""}
											onChange={(e) =>
												patchAudio(index, {
													channelLayout: e.target.value || undefined,
												})
											}
										>
											<option value="">{t("wizard.default")}</option>
											{audio.channelLayout &&
											!AUDIO_CHANNEL_LAYOUTS[codec].includes(
												audio.channelLayout,
											) ? (
												<option value={audio.channelLayout}>
													{audio.channelLayout}
												</option>
											) : null}
											{AUDIO_CHANNEL_LAYOUTS[codec].map((layout) => (
												<option key={layout} value={layout}>
													{layout}
												</option>
											))}
										</SelectNative>
									</Field>
								)}
								{codec !== "DOLBY_ATMOS" && (
									<AudioMixEditor
										state={state}
										index={index}
										sourceOptions={audioSources}
										onPatch={onPatch}
									/>
								)}
								{(["AAC", "AC3", "EAC3"] as string[]).includes(codec) ? (
									<AudioCutoffEditor
										id={`wz-a-${index}-cutoff`}
										value={audio.cutoffFrequency}
										onChange={(cutoffFrequency) =>
											patchAudio(index, { cutoffFrequency })
										}
									/>
								) : null}
								<ExtrasEditor
									idBase={`wz-a-${index}-x`}
									family="audio"
									extras={audio.extras}
									sourceOptions={
										codec === "DOLBY_ATMOS"
											? audioSources.filter(
													(option) =>
														!sources.audioMixStreams?.some(
															(mix) => mix.key === option.value,
														),
												)
											: audioSources
									}
									encodingKeys={encodingKeys}
									filterKeys={filters
										.filter(
											(f) => filterFamily(f.kind ?? "DEINTERLACE") === "audio",
										)
										.map((f) => f.key)}
									nexguardCredentials={nexguardCredentials}
									onChange={(extras) => patchAudio(index, { extras })}
								/>
							</div>
						);
					})}
					{audios.length === 0 ? (
						<p className="text-xs text-zinc-500">
							{t("wizard.noAudioRenditionsVideoOnlyPlansSkip")}
						</p>
					) : null}
				</div>
			</div>

			<div>
				<div className="flex items-center justify-between">
					<h2 className="font-medium text-sm text-zinc-200">
						{ja ? "字幕トラック" : "Subtitle tracks"}
					</h2>
					<Button
						variant="secondary"
						size="sm"
						onClick={() =>
							onPatch({
								subtitles: [
									...subtitles,
									{ source: (sources.fileStreams ?? [])[0]?.key ?? "" },
								],
							})
						}
					>
						{t("wizard.addSubtitle")}
					</Button>
				</div>
				{subtitles.length > 0 ? (
					<div className="mt-2 space-y-3">
						{subtitles.map((subtitle, index) => (
							<div
								key={index}
								className="space-y-3 rounded-md border border-zinc-800 p-3"
							>
								<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
									<Field
										label={t("wizard.codec")}
										htmlFor={`wz-s-${index}-codec`}
										tooltip={
											ja
												? "TTMLファイルからIMSC字幕を生成し、DASHに追加します。"
												: "IMSC uses a TTML file input and is included in DASH."
										}
									>
										<SelectNative
											id={`wz-s-${index}-codec`}
											value={subtitle.codec ?? "WEBVTT"}
											onChange={(e) => {
												const codec = e.target.value as "WEBVTT" | "IMSC";
												patchSubtitle(index, {
													codec,
													source:
														(sources.fileStreams ?? []).find(
															(s) =>
																(s.fileType ?? "WEBVTT") ===
																(codec === "IMSC" ? "TTML" : "WEBVTT"),
														)?.key ?? "",
													muxing: undefined,
													styling: undefined,
												});
											}}
										>
											<option value="WEBVTT">WebVTT</option>
											<option value="IMSC">IMSC</option>
										</SelectNative>
									</Field>
									{subtitle.codec === "IMSC" ? (
										<Field
											label={ja ? "スタイル" : "Styling"}
											htmlFor={`wz-s-${index}-styling`}
										>
											<SelectNative
												id={`wz-s-${index}-styling`}
												value={subtitle.styling?.mode ?? ""}
												onChange={(e) =>
													patchSubtitle(index, {
														styling: e.target.value
															? {
																	mode: e.target.value as
																		| "PASSTHROUGH"
																		| "DROP_STYLING",
																}
															: undefined,
													})
												}
											>
												<option value="">{t("wizard.default")}</option>
												<option value="PASSTHROUGH">PASSTHROUGH</option>
												<option value="DROP_STYLING">DROP_STYLING</option>
											</SelectNative>
										</Field>
									) : null}
									<Field
										label={t("wizard.fileStream")}
										htmlFor={`wz-s-${index}-src`}
										tooltip={
											subtitle.codec === "IMSC"
												? ja
													? "「ソース」でTTMLファイルのストリームを追加してください。"
													: "Add a TTML file stream in Sources."
												: t("wizard.webvttFileStreamsComeFromTheSources")
										}
									>
										<SelectNative
											id={`wz-s-${index}-src`}
											value={subtitle.source}
											onChange={(e) =>
												patchSubtitle(index, { source: e.target.value })
											}
										>
											<option value="">{t("wizard.selectFileStream")}</option>
											{subtitle.source &&
											!(sources.fileStreams ?? []).some(
												(stream) => stream.key === subtitle.source,
											) ? (
												<option value={subtitle.source}>
													{subtitle.source} {t("wizardX.missingParen")}
												</option>
											) : null}
											{(sources.fileStreams ?? [])
												.filter(
													(s) =>
														(s.fileType ?? "WEBVTT") ===
														(subtitle.codec === "IMSC" ? "TTML" : "WEBVTT"),
												)
												.map((stream) => (
													<option key={stream.key} value={stream.key}>
														{stream.key}
													</option>
												))}
										</SelectNative>
									</Field>
									<Field
										label={t("wizard.label")}
										htmlFor={`wz-s-${index}-label`}
										help={
											subtitle.codec === "IMSC"
												? undefined
												: t("uiX.defaultEnglishSample")
										}
										tooltip={
											subtitle.codec === "IMSC"
												? ja
													? "既定: 英語"
													: "Default: English"
												: undefined
										}
									>
										<Input
											id={`wz-s-${index}-label`}
											value={subtitle.label ?? ""}
											onChange={(e) =>
												patchSubtitle(index, {
													label: e.target.value || undefined,
												})
											}
										/>
									</Field>
									<Field
										label={t("wizard.language")}
										htmlFor={`wz-s-${index}-lang`}
										help={t("uiX.defaultEn")}
									>
										<Input
											id={`wz-s-${index}-lang`}
											value={subtitle.language ?? ""}
											onChange={(e) =>
												patchSubtitle(index, {
													language: e.target.value || undefined,
												})
											}
										/>
									</Field>
									{subtitle.codec !== "IMSC" ? (
										<>
											{" "}
											<Field
												label={t("wizard.groupId")}
												htmlFor={`wz-s-${index}-group`}
												help={t("uiX.defaultSubtitle")}
											>
												<Input
													id={`wz-s-${index}-group`}
													value={subtitle.groupId ?? ""}
													onChange={(e) =>
														patchSubtitle(index, {
															groupId: e.target.value || undefined,
														})
													}
												/>
											</Field>
											<Field
												label={t("wizard.mediaUri")}
												htmlFor={`wz-s-${index}-uri`}
												help={t("uiX.defaultSubtitlesEnM3u8")}
											>
												<Input
													id={`wz-s-${index}-uri`}
													value={subtitle.uri ?? ""}
													onChange={(e) =>
														patchSubtitle(index, {
															uri: e.target.value || undefined,
														})
													}
												/>
											</Field>
										</>
									) : null}
								</div>
								<ExtrasEditor
									idBase={`wz-s-${index}-x`}
									family="subtitle"
									extras={subtitle.extras}
									sourceOptions={allStreams
										.filter(
											(s) =>
												s.type ===
												(subtitle.codec === "IMSC" ? "TTML" : "WEBVTT"),
										)
										.map((s) => ({
											value: s.key,
											label: streamReferenceLabel(state, s),
										}))}
									encodingKeys={encodingKeys}
									filterKeys={filterKeys}
									nexguardCredentials={nexguardCredentials}
									onChange={(extras) => patchSubtitle(index, { extras })}
								/>
								<RowRemoveButton
									label={t("wizardX.removeSubtitleN", { n: index + 1 })}
									onClick={() =>
										onPatch({
											subtitles: subtitles.filter((_, i) => i !== index),
										})
									}
								/>
							</div>
						))}
					</div>
				) : null}
			</div>
		</div>
	);
}

const HLS_OPTION_FIELDS: OptionFieldSpec[] = [
	{
		key: "masterVersion",
		labelKey: "wizard.masterVersion",
		control: {
			options: ["HLS_V3", "HLS_V4", "HLS_V5", "HLS_V6", "HLS_V7", "HLS_V8"],
		},
	},
	{
		key: "mediaVersion",
		labelKey: "wizard.mediaVersion",
		control: {
			options: ["HLS_V3", "HLS_V4", "HLS_V5", "HLS_V6", "HLS_V7", "HLS_V8"],
		},
	},
	{ key: "audioGroupId", labelKey: "wizard.audioGroupId", control: "text" },
	{ key: "audioLanguage", labelKey: "wizard.audioLanguage", control: "text" },
	{ key: "closedCaptions", labelKey: "wizard.closedCaptions", control: "text" },
	{
		key: "videoMuxingKind",
		labelKey: "wizard.videoMuxingKind",
		control: { options: ["FMP4", "MP4", "TS"] },
		hintKey: "wizard.multiLegPlansWhichLegThisManifest",
	},
	{
		key: "audioMuxingKind",
		labelKey: "wizard.audioMuxingKind",
		control: { options: ["FMP4", "MP4", "TS"] },
	},
	{ key: "audioMediaUri", labelKey: "wizard.audioMediaUri", control: "text" },
	{
		key: "perTitleVariantUri",
		labelKey: "wizard.perTitleVariantUri",
		control: { options: ["AVG_BITRATE", "CODEC_BITRATE"] },
	},
	{
		key: "drmKind",
		labelKey: "wizard.drmKind",
		control: { options: ["CENC", "FAIRPLAY", "SPEKE"] },
	},
	{
		key: "variantsPerAudioGroup",
		labelKey: "wizard.variantsPerAudioGroup",
		control: "bool",
	},
	{
		key: "iframePlaylists",
		labelKey: "wizard.iFramePlaylists",
		control: "bool",
	},
	{
		key: "audioVariantStreams",
		labelKey: "wizard.audioVariantStreams",
		control: "bool",
	},
];

const DASH_OPTION_FIELDS: OptionFieldSpec[] = [
	{ key: "audioLanguage", labelKey: "wizard.audioLanguage", control: "text" },
	{
		key: "representationType",
		labelKey: "wizard.representationType",
		control: { options: ["TEMPLATE", "TIMELINE"] },
	},
	{
		key: "onDemand",
		labelKey: "wizard.onDemandProfile",
		control: "bool",
		hintKey: "wizard.singleMp4SegmentbaseRepresentationsDashOnDem",
	},
	{
		key: "videoMuxingKind",
		labelKey: "wizard.videoMuxingKind",
		control: { options: ["FMP4", "CMAF", "WEBM"] },
	},
	{
		key: "audioMuxingKind",
		labelKey: "wizard.audioMuxingKind",
		control: { options: ["FMP4", "CMAF", "WEBM"] },
	},
	{
		key: "drmKind",
		labelKey: "wizard.drmKind",
		control: { options: ["CENC", "SPEKE"] },
	},
];

function DashAdaptationSetsEditor({
	idBase,
	value,
	onChange,
}: {
	idBase: string;
	value: WizardDashOptions;
	onChange: (next: WizardDashOptions) => void;
}) {
	const { t } = useT();
	const sets = value.adaptationSets ?? [];
	return (
		<Collapsible
			summary={t("wizardX.adaptationSetsCount", { count: sets.length })}
			help={t("wizard.renditionsJoinASetViaTheirDash")}
		>
			{sets.map((set, index) => (
				<div key={index} className="flex flex-wrap items-start gap-2">
					<Field label={t("wizard.key")} htmlFor={`${idBase}-as-${index}-key`}>
						<Input
							id={`${idBase}-as-${index}-key`}
							value={set.key}
							onChange={(e) => {
								const next = [...sets];
								next[index] = { ...set, key: e.target.value };
								onChange({ ...value, adaptationSets: next });
							}}
						/>
					</Field>
					<Field
						label={t("wizard.type")}
						htmlFor={`${idBase}-as-${index}-type`}
					>
						<SelectNative
							id={`${idBase}-as-${index}-type`}
							value={set.type}
							onChange={(e) => {
								const next = [...sets];
								next[index] = {
									...set,
									type: e.target.value as "VIDEO" | "AUDIO",
								};
								onChange({ ...value, adaptationSets: next });
							}}
						>
							<option value="VIDEO">VIDEO</option>
							<option value="AUDIO">AUDIO</option>
						</SelectNative>
					</Field>
					<Field
						label={t("wizard.lang")}
						htmlFor={`${idBase}-as-${index}-lang`}
					>
						<Input
							id={`${idBase}-as-${index}-lang`}
							className="w-20"
							value={set.lang ?? ""}
							onChange={(e) => {
								const next = [...sets];
								next[index] = { ...set, lang: e.target.value || undefined };
								onChange({ ...value, adaptationSets: next });
							}}
						/>
					</Field>
					<Field
						label={t("wizard.label")}
						htmlFor={`${idBase}-as-${index}-label`}
					>
						<Input
							id={`${idBase}-as-${index}-label`}
							value={set.label ?? ""}
							onChange={(e) => {
								const next = [...sets];
								next[index] = { ...set, label: e.target.value || undefined };
								onChange({ ...value, adaptationSets: next });
							}}
						/>
					</Field>
					<FieldRowAction>
						<RowRemoveButton
							label={t("wizardX.removeAdaptationSetN", { n: index + 1 })}
							onClick={() =>
								onChange({
									...value,
									adaptationSets: sets.filter((_, i) => i !== index),
								})
							}
						/>
					</FieldRowAction>
				</div>
			))}
			<Button
				variant="secondary"
				size="sm"
				onClick={() =>
					onChange({
						...value,
						adaptationSets: [...sets, { key: "", type: "VIDEO" }],
					})
				}
			>
				{t("wizard.addAdaptationSet")}
			</Button>
		</Collapsible>
	);
}

const PER_TITLE_FIELDS: OptionFieldSpec[] = [
	{ key: "minBitrate", labelKey: "wizard.minBitrateBps", control: "num" },
	{ key: "maxBitrate", labelKey: "wizard.maxBitrateBps", control: "num" },
	{
		key: "targetQualityCrf",
		labelKey: "wizard.targetQualityCrf",
		control: "num",
	},
	{
		key: "complexityFactor",
		labelKey: "wizard.complexityFactor",
		control: "num",
	},
	{
		key: "minBitrateStepSize",
		labelKey: "wizard.minBitrateStepSize",
		control: "num",
	},
	{
		key: "maxBitrateStepSize",
		labelKey: "wizard.maxBitrateStepSize",
		control: "num",
	},
];

const PER_TITLE_FIXED_FIELDS: OptionFieldSpec[] = [
	{
		key: "forcedRenditionAboveHighestFixedRepresentation",
		labelKey: "wizard.forcedRenditionAboveHighest",
		control: "num",
	},
	{
		key: "forcedRenditionAboveHighestFixedRepresentationFactor",
		labelKey: "wizard.forcedRenditionFactor",
		control: "num",
	},
	{
		key: "forcedRenditionAboveHighestFixedRepresentationCalculationMode",
		labelKey: "wizard.forcedRenditionMode",
		control: {
			options: ["LAST_CALCULATED_BITRATE", "MINIMUM", "MAXIMUM", "AVERAGE"],
		},
	},
];

const PER_TITLE_CODEC_FACTOR_FIELDS: OptionFieldSpec[] = [
	{
		key: "codecMinBitrateFactor",
		labelKey: "wizard.codecMinBitrateFactor",
		control: "num",
	},
	{
		key: "codecMaxBitrateFactor",
		labelKey: "wizard.codecMaxBitrateFactor",
		control: "num",
	},
	{
		key: "codecBufsizeFactor",
		labelKey: "wizard.codecBufsizeFactor",
		control: "num",
	},
];

function PerTitleCodecEditor({
	codec,
	hevcV2 = false,
	value,
	onChange,
}: {
	codec: "h264" | "h265" | "vp9" | "av1";
	hevcV2?: boolean;
	value: WizardPerTitleCodec | undefined;
	onChange: (next: WizardPerTitleCodec | undefined) => void;
}) {
	const { t } = useT();
	const idBase = `wz-pt-${codec}`;
	return (
		<Collapsible
			summary={`${hevcV2 ? "h265V2" : codec}Configuration${value ? t("wizardX.onSuffix") : ""}`}
		>
			<label
				htmlFor={`${idBase}-enable`}
				className="flex items-center gap-2 text-xs text-zinc-300"
			>
				<input
					id={`${idBase}-enable`}
					type="checkbox"
					className="h-3.5 w-3.5 accent-emerald-600"
					checked={value !== undefined}
					onChange={(e) => onChange(e.target.checked ? {} : undefined)}
				/>
				{t("wizardX.enableCodecPerTitle", { codec })}
			</label>
			{value ? (
				<>
					<label
						htmlFor={`${idBase}-auto`}
						className="flex items-center gap-2 text-xs text-zinc-300"
					>
						<input
							id={`${idBase}-auto`}
							type="checkbox"
							className="h-3.5 w-3.5 accent-emerald-600"
							checked={value.autoRepresentations === true}
							onChange={(e) =>
								onChange({
									...value,
									autoRepresentations: e.target.checked ? true : undefined,
									adoptConfigurationThreshold: e.target.checked
										? value.adoptConfigurationThreshold
										: undefined,
								})
							}
						/>
						{t("wizard.autorepresentationsEmptyObjectEnablesDefault")}
					</label>
					{value.autoRepresentations ? (
						<Field
							label={t("wizard.adoptConfigurationThreshold")}
							htmlFor={`${idBase}-adopt`}
						>
							<Input
								id={`${idBase}-adopt`}
								type="number"
								step="any"
								value={value.adoptConfigurationThreshold ?? ""}
								onChange={(e) =>
									onChange({
										...value,
										adoptConfigurationThreshold:
											e.target.value === ""
												? undefined
												: Number(e.target.value),
									})
								}
							/>
						</Field>
					) : null}
					<OptionsGrid
						idBase={idBase}
						value={value}
						fields={
							hevcV2
								? [
										...PER_TITLE_FIELDS.filter(
											(field) =>
												field.key !== "targetQualityCrf" ||
												value.targetQualityCrf !== undefined,
										),
										{
											key: "targetQualityQp",
											labelKey: "wizard.targetQualityQp",
											control: "num",
										},
										...PER_TITLE_CODEC_FACTOR_FIELDS.filter(
											(field) =>
												field.key !== "codecBufsizeFactor" ||
												value.codecBufsizeFactor !== undefined,
										),
									]
								: codec === "vp9" || codec === "av1"
									? PER_TITLE_FIELDS
									: [...PER_TITLE_FIELDS, ...PER_TITLE_CODEC_FACTOR_FIELDS]
						}
						onChange={onChange}
					/>
					<div className="break-words">
						<Collapsible summary="fixedResolutionAndBitrateConfiguration">
							<OptionsGrid
								idBase={idBase}
								value={value}
								fields={PER_TITLE_FIXED_FIELDS}
								onChange={onChange}
							/>
						</Collapsible>
					</div>
				</>
			) : null}
		</Collapsible>
	);
}

type ManifestSectionProps = {
	state: WizardState;
	onPatch: (partial: Partial<WizardState>) => void;
};

/**
 * JIT-only start-request placement select for an HLS/DASH manifest row.
 * Rendered ONLY under JUST_IN_TIME timing (callers guard) and never for
 * SMOOTH (the API has no smooth preview list). Unset = today's behavior
 * (the manifest rides the vod* list); explicit "VOD" is kept distinct so
 * a plan carrying it round-trips verbatim.
 */
function JitPlacementField({
	id,
	value,
	onChange,
}: {
	id: string;
	value: WizardJitPlacement | undefined;
	onChange: (next: WizardJitPlacement | undefined) => void;
}) {
	const { t } = useT();
	return (
		<Field
			label={t("wizard.startPlacement")}
			htmlFor={id}
			help={t("wizard.previewWatchWhileEncodingManifestListsOn")}
		>
			<SelectNative
				id={id}
				value={value ?? ""}
				onChange={(e) =>
					onChange(
						e.target.value === ""
							? undefined
							: (e.target.value as WizardJitPlacement),
					)
				}
			>
				{/* Default and explicit VOD options compile identically. Show one choice while preserving explicit VOD values on import and normalizing them in plan-to-wizard. */}
				<option value="">{t("wizard.vodDefault")}</option>
				<option value="PREVIEW">{t("wizard.preview")}</option>
				<option value="VOD_AND_PREVIEW">{t("wizard.vodPreview")}</option>
			</SelectNative>
		</Field>
	);
}

export function ManifestSection({ state, onPatch }: ManifestSectionProps) {
	const { t } = useT();
	const manifests = state.manifests;
	const extra = manifests.extra ?? [];
	const hasManifests = manifests.hls || manifests.dash || extra.length > 0;
	const patchManifests = (partial: Partial<WizardState["manifests"]>) =>
		onPatch({ manifests: { ...manifests, ...partial } });
	const patchExtra = (index: number, next: WizardExtraManifest) => {
		const list = [...extra];
		list[index] = next;
		patchManifests({ extra: list });
	};
	const addExtra = (kind: WizardExtraManifest["kind"]) => {
		const used = new Set(["hls", "dash", ...extra.map((m) => m.key)]);
		let count = extra.filter((m) => m.kind === kind).length + 1;
		while (used.has(`${kind.toLowerCase()}${count}`)) count += 1;
		const key = `${kind.toLowerCase()}${count}`;
		patchManifests({ extra: [...extra, { kind, key }] });
	};

	// Per-rendition manifest placement (relocated from the Ladder): renditions
	// route into the DASH adaptation sets / HLS variant groups declared here.
	const placement = manifestPlacement(manifests);
	const { videos, audios } = state;
	const subtitles = state.subtitles ?? [];
	const vKeys = videoKeys(videos);
	const aKeys = audioKeys(audios);
	const sKeys = subtitleKeys(subtitles);
	const patchVideoExtras = (i: number, extras: WizardRenditionExtras) => {
		const next = [...videos];
		const cur = next[i];
		if (cur) next[i] = { ...cur, extras };
		onPatch({ videos: next });
	};
	const patchAudioExtras = (i: number, extras: WizardRenditionExtras) => {
		const next = [...audios];
		const cur = next[i];
		if (cur) next[i] = { ...cur, extras };
		onPatch({ audios: next });
	};
	const patchSubtitleExtras = (i: number, extras: WizardRenditionExtras) => {
		const next = [...subtitles];
		const cur = next[i];
		if (cur) next[i] = { ...cur, extras };
		onPatch({ subtitles: next });
	};

	// VMAF-only encode (qc.only) produces no manifests — disable the whole step
	// (a native <fieldset disabled> greys out + blocks every control inside,
	// including the HLS/DASH toggles, the muxing-kind selects and the Add
	// buttons) and explain why. The toggle itself lives in the Encoding-options
	// step's Quality control (VMAF) section.
	const qcOnly = Boolean(state.qc?.only && (state.qc.vmaf || state.qc.psnr));

	// Start-placement (preview manifests) only exists on the START request —
	// POST_ENCODING plans have no start-time manifest lists. Keep a carried
	// placement editable so a timing change never hides its validation remedy.
	const jit = state.timing === "JUST_IN_TIME";
	const hasPreviewPlacement = [
		manifests.hls ? manifests.hlsOptions?.jitPlacement : undefined,
		manifests.dash ? manifests.dashOptions?.jitPlacement : undefined,
		...extra.map((m) =>
			m.kind === "HLS"
				? m.hls?.jitPlacement
				: m.kind === "DASH"
					? m.dash?.jitPlacement
					: undefined,
		),
	].some((p) => p === "PREVIEW" || p === "VOD_AND_PREVIEW");

	return (
		<fieldset
			disabled={qcOnly}
			className={`space-y-6 ${qcOnly ? "opacity-50" : ""}`}
		>
			{qcOnly ? (
				<p className="rounded-md border border-amber-700/40 bg-amber-950/30 px-3 py-2 text-amber-200/90 text-xs">
					{t("uiX.vmafOnlyManifestsNote")}
				</p>
			) : null}
			<div className="space-y-4">
				<div className="flex gap-6">
					<label
						htmlFor="wz-hls"
						className="flex items-center gap-2 text-sm text-zinc-300"
					>
						<input
							id="wz-hls"
							type="checkbox"
							className="h-4 w-4 accent-emerald-600"
							checked={manifests.hls}
							onChange={(e) => patchManifests({ hls: e.target.checked })}
						/>
						{t("wizard.hlsStreamM3u8")}
					</label>
					<label
						htmlFor="wz-dash"
						className="flex items-center gap-2 text-sm text-zinc-300"
					>
						<input
							id="wz-dash"
							type="checkbox"
							className="h-4 w-4 accent-emerald-600"
							checked={manifests.dash}
							onChange={(e) => patchManifests({ dash: e.target.checked })}
						/>
						{t("wizard.dashStreamMpd")}
					</label>
				</div>
				{manifests.hls ? (
					<>
						{jit || manifests.hlsOptions?.jitPlacement ? (
							<JitPlacementField
								id="wz-hls-jit"
								value={manifests.hlsOptions?.jitPlacement}
								onChange={(jitPlacement) =>
									patchManifests({
										hlsOptions: {
											...(manifests.hlsOptions ?? {}),
											jitPlacement,
										},
									})
								}
							/>
						) : null}
						<Collapsible summary={t("wizard.hlsOptions")}>
							<OptionsGrid
								idBase="wz-hlsopt"
								value={manifests.hlsOptions ?? {}}
								fields={HLS_OPTION_FIELDS}
								onChange={(hlsOptions: WizardHlsOptions) =>
									patchManifests({ hlsOptions })
								}
							/>
						</Collapsible>
					</>
				) : null}
				{manifests.dash ? (
					<>
						{jit || manifests.dashOptions?.jitPlacement ? (
							<JitPlacementField
								id="wz-dash-jit"
								value={manifests.dashOptions?.jitPlacement}
								onChange={(jitPlacement) =>
									patchManifests({
										dashOptions: {
											...(manifests.dashOptions ?? {}),
											jitPlacement,
										},
									})
								}
							/>
						) : null}
						<Collapsible summary={t("wizard.dashOptions")}>
							<OptionsGrid
								idBase="wz-dashopt"
								value={manifests.dashOptions ?? {}}
								fields={DASH_OPTION_FIELDS}
								onChange={(dashOptions: WizardDashOptions) =>
									patchManifests({ dashOptions })
								}
							/>
							<DashAdaptationSetsEditor
								idBase="wz-dashopt"
								value={manifests.dashOptions ?? {}}
								onChange={(dashOptions) => patchManifests({ dashOptions })}
							/>
						</Collapsible>
					</>
				) : null}
			</div>

			<div>
				<div className="flex items-center justify-between">
					<div className="flex items-center gap-1.5">
						<h2 className="font-medium text-sm text-zinc-200">
							{t("wizard.additionalManifests")}
						</h2>
						<HelpOverlay
							label={t("uiX.moreInformationFor", {
								label: t("wizard.additionalManifests"),
							})}
						>
							{t("wizard.severalManifestsOfOneKindAreValid")}
						</HelpOverlay>
					</div>
					<div className="flex gap-1">
						<Button
							variant="secondary"
							size="sm"
							onClick={() => addExtra("HLS")}
						>
							{t("wizard.addHls")}
						</Button>
						<Button
							variant="secondary"
							size="sm"
							onClick={() => addExtra("DASH")}
						>
							{t("wizard.addDash")}
						</Button>
						<Button
							variant="secondary"
							size="sm"
							onClick={() => addExtra("SMOOTH")}
						>
							{t("wizard.addSmooth")}
						</Button>
					</div>
				</div>
				<div className="mt-2 space-y-3">
					{extra.map((manifest, index) => (
						<div
							key={index}
							className="space-y-3 rounded-md border border-zinc-800 p-3"
						>
							<div className="flex items-start justify-between gap-2">
								<span className="rounded bg-zinc-800 px-2 py-1 font-mono text-xs text-zinc-300">
									{manifest.kind}
								</span>
								<RowRemoveButton
									label={t("wizardX.removeManifestN", { n: index + 1 })}
									onClick={() =>
										patchManifests({
											extra: extra.filter((_, i) => i !== index),
										})
									}
								/>
							</div>
							{manifest.kind === "SMOOTH" ? (
								<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
									<Field
										label={t("wizard.serverManifest")}
										htmlFor={`wz-xm-${index}-server`}
										help={t("uiX.defaultStreamIsm")}
									>
										<Input
											id={`wz-xm-${index}-server`}
											value={manifest.serverManifestName ?? ""}
											onChange={(e) =>
												patchExtra(index, {
													...manifest,
													serverManifestName: e.target.value || undefined,
												})
											}
										/>
									</Field>
									<Field
										label={t("wizard.clientManifest")}
										htmlFor={`wz-xm-${index}-client`}
										help={t("uiX.defaultStreamIsmc")}
									>
										<Input
											id={`wz-xm-${index}-client`}
											value={manifest.clientManifestName ?? ""}
											onChange={(e) =>
												patchExtra(index, {
													...manifest,
													clientManifestName: e.target.value || undefined,
												})
											}
										/>
									</Field>
									<Field
										label={t("wizard.language")}
										htmlFor={`wz-xm-${index}-lang`}
									>
										<Input
											id={`wz-xm-${index}-lang`}
											value={manifest.language ?? ""}
											onChange={(e) =>
												patchExtra(index, {
													...manifest,
													language: e.target.value || undefined,
												})
											}
										/>
									</Field>
									<Field
										label={t("wizard.drmKind")}
										htmlFor={`wz-xm-${index}-drm`}
									>
										<SelectNative
											id={`wz-xm-${index}-drm`}
											value={manifest.drmKind ?? ""}
											onChange={(e) =>
												patchExtra(index, {
													...manifest,
													drmKind:
														e.target.value === "CENC" ? "CENC" : undefined,
												})
											}
										>
											<option value="">{t("wizard.none")}</option>
											<option value="CENC">CENC</option>
										</SelectNative>
									</Field>
								</div>
							) : (
								<>
									<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
										<Field
											label={t("wizard.manifestFilename")}
											htmlFor={`wz-xm-${index}-file`}
											help={
												manifest.kind === "HLS"
													? 'Default "stream.m3u8"'
													: 'Default "stream.mpd"'
											}
										>
											<Input
												id={`wz-xm-${index}-file`}
												value={manifest.manifestName ?? ""}
												onChange={(e) =>
													patchExtra(index, {
														...manifest,
														manifestName: e.target.value || undefined,
													})
												}
											/>
										</Field>
										{jit ||
										(manifest.kind === "HLS"
											? manifest.hls?.jitPlacement
											: manifest.dash?.jitPlacement) ? (
											manifest.kind === "HLS" ? (
												<JitPlacementField
													id={`wz-xm-${index}-jit`}
													value={manifest.hls?.jitPlacement}
													onChange={(jitPlacement) =>
														patchExtra(index, {
															...manifest,
															hls: { ...(manifest.hls ?? {}), jitPlacement },
														})
													}
												/>
											) : (
												<JitPlacementField
													id={`wz-xm-${index}-jit`}
													value={manifest.dash?.jitPlacement}
													onChange={(jitPlacement) =>
														patchExtra(index, {
															...manifest,
															dash: { ...(manifest.dash ?? {}), jitPlacement },
														})
													}
												/>
											)
										) : null}
									</div>
									{manifest.kind === "HLS" ? (
										<Collapsible summary={t("wizard.hlsOptions")}>
											<OptionsGrid
												idBase={`wz-xm-${index}-hls`}
												value={manifest.hls ?? {}}
												fields={HLS_OPTION_FIELDS}
												onChange={(hls: WizardHlsOptions) =>
													patchExtra(index, { ...manifest, hls })
												}
											/>
										</Collapsible>
									) : (
										<Collapsible summary={t("wizard.dashOptions")}>
											<OptionsGrid
												idBase={`wz-xm-${index}-dash`}
												value={manifest.dash ?? {}}
												fields={DASH_OPTION_FIELDS}
												onChange={(dash: WizardDashOptions) =>
													patchExtra(index, { ...manifest, dash })
												}
											/>
											<DashAdaptationSetsEditor
												idBase={`wz-xm-${index}-dash`}
												value={manifest.dash ?? {}}
												onChange={(dash) =>
													patchExtra(index, { ...manifest, dash })
												}
											/>
										</Collapsible>
									)}
								</>
							)}
						</div>
					))}
				</div>
			</div>

			{!jit && !qcOnly && hasPreviewPlacement ? (
				<p role="alert" className="text-amber-400 text-xs">
					{t("wizard.previewPlacementNeedsJit")}
				</p>
			) : null}

			{hasManifests && !qcOnly ? (
				<>
					<fieldset>
						<legend className="flex items-center gap-1.5 font-medium text-xs text-zinc-300">
							{t("wizard.generationTiming")}
							<HelpOverlay
								label={t("uiX.moreInformationFor", {
									label: t("wizard.generationTiming"),
								})}
							>
								{t("wizard.perTitleAndMultiEncodingPlansMust")}
							</HelpOverlay>
						</legend>
						<div className="mt-2 flex gap-6">
							{(
								[
									["JUST_IN_TIME", t("wizard.justInTimeWithTheEncodingStart")],
									["POST_ENCODING", t("wizard.postEncodingAfterFinished")],
								] as const
							).map(([value, label]) => (
								<label
									key={value}
									className="flex items-center gap-2 text-sm text-zinc-300"
								>
									<input
										type="radio"
										name="wz-timing"
										className="h-4 w-4 accent-emerald-600"
										checked={state.timing === value}
										onChange={() => onPatch({ timing: value })}
									/>
									{label}
								</label>
							))}
						</div>
					</fieldset>

					<Collapsible
						summary={t("wizard.perRenditionPlacementHlsGroupsDashSets")}
					>
						<p className="text-xs text-zinc-500">
							{t("wizard.advancedNeededOnlyForMultiAudioGroup")}
						</p>
						{videos.map((video, index) => (
							<div key={`v-${index}`} className="space-y-1">
								<p className="font-mono text-xs text-zinc-400">
									{vKeys[index]} · {t("wizardX.videoWord")}
								</p>
								<RenditionPlacement
									idBase={`wz-mp-v-${index}`}
									family="video"
									value={video.extras ?? {}}
									placement={placement}
									onChange={(extras) => patchVideoExtras(index, extras)}
								/>
							</div>
						))}
						{audios.map((audio, index) => (
							<div key={`a-${index}`} className="space-y-1">
								<p className="font-mono text-xs text-zinc-400">
									{aKeys[index]} · {t("wizardX.audioWord")}
								</p>
								<RenditionPlacement
									idBase={`wz-mp-a-${index}`}
									family="audio"
									value={audio.extras ?? {}}
									placement={placement}
									onChange={(extras) => patchAudioExtras(index, extras)}
								/>
							</div>
						))}
						{subtitles.map((subtitle, index) => (
							<div key={`s-${index}`} className="space-y-1">
								<p className="font-mono text-xs text-zinc-400">
									{sKeys[index]} · {t("wizardX.subtitleWord")}
								</p>
								<RenditionPlacement
									idBase={`wz-mp-s-${index}`}
									family="subtitle"
									value={subtitle.extras ?? {}}
									placement={placement}
									onChange={(extras) => patchSubtitleExtras(index, extras)}
								/>
							</div>
						))}
					</Collapsible>
				</>
			) : null}
		</fieldset>
	);
}

type EncodingOptionsSectionProps = ManifestSectionProps & {
	/**
	 * Vault credentials for the KANTAR picker (filtered here, mirroring how
	 * LadderSection filters NEXGUARD). Optional with a `[]` default so the
	 * section's many other controls stay renderable standalone in tests; the
	 * wizard always passes the live list.
	 */
	credentials?: CredentialSummaryWire[];
};

/**
 * Encoding start options (StartEncodingRequest): encoding mode, Per-Title
 * configuration and AI Scene Analysis. Split out of the Manifests step so
 * EncodingStartOptions and the manifest ManifestStartOptions (generation
 * timing) live in separate sections. Also hosts the encoding-level extras that
 * are not start-request fields — Labels & infrastructure, QC (VMAF) and Kantar
 * audio watermarking.
 */
/**
 * CSV → trimmed non-empty ids. PrewarmedPoolPicker normally emits normalized
 * output, so the trim/filter is defence-in-depth against a picker change —
 * unreachable through the rendered chain (review of PR #176, M10), hence
 * pinned as a pure function instead of a forced UI test.
 */
export function csvToPoolIds(csv: string): string[] {
	return csv
		.split(",")
		.map((id) => id.trim())
		.filter((id) => id.length > 0);
}

export function EncodingOptionsSection({
	state,
	onPatch,
	credentials = [],
}: EncodingOptionsSectionProps) {
	const qcVmafEnabled = useQcVmafEnabled();
	const { t } = useT();
	const startOptions = state.startOptions ?? {};
	const usesCodecMode = wizardUsesCodecEncodingMode(state);
	useEffect(() => {
		if (usesCodecMode && state.startOptions?.encodingMode !== undefined)
			onPatch({
				startOptions: { ...state.startOptions, encodingMode: undefined },
			});
	}, [usesCodecMode, state.startOptions, onPatch]);
	const patchStart = (partial: Partial<WizardStartOptions>) =>
		onPatch({ startOptions: { ...startOptions, ...partial } });
	const ai = startOptions.aiSceneAnalysis;
	// Infrastructure (Cloud Connect) — both fields required together by the
	// schema; both-empty collapses back to undefined so default plans emit
	// no bitmovin.infrastructure key. A half-filled pair is kept in state and
	// surfaces as a loud schema error in the preview (never a silent drop).
	const infrastructure = state.infrastructure;
	const patchInfrastructure = (
		partial: Partial<NonNullable<WizardState["infrastructure"]>>,
	) => {
		const next = {
			infrastructureId: infrastructure?.infrastructureId ?? "",
			cloudRegion: infrastructure?.cloudRegion ?? "",
			...partial,
		};
		const cleared = next.infrastructureId === "" && next.cloudRegion === "";
		onPatch({
			infrastructure: cleared ? undefined : next,
			// C18 auto-switch (C1 precedent): Cloud Connect encodings must run
			// with the TOP-LEVEL cloudRegion EXTERNAL — the in-infrastructure
			// region rides this block instead. Switching here (with the helper
			// copy below) beats a validator error after the fact. Clearing the
			// pair deliberately does NOT switch back — the rail guards the rest.
			...(!cleared && state.cloudRegion !== "EXTERNAL"
				? { cloudRegion: "EXTERNAL" }
				: {}),
		});
	};
	// QC (VMAF) toggle — like AISA, "off" carries no state (buildPlan prunes
	// the plan.qc key when vmaf+psnr are both off, keeping default plans clean).
	const qc = state.qc ?? DEFAULT_WIZARD_QC;
	const qcOn = qc.vmaf || qc.psnr;
	const qcOnly = Boolean(qcOn && qc.only);
	const patchQc = (partial: Partial<WizardQc>) =>
		onPatch({ qc: { ...qc, ...partial } });
	// QC gate editor . Zero rules = no gate key at all — the
	// wizard never emits an empty gate the schema would reject (rules min 1).
	const gateRules = qc.gate?.rules ?? [];
	const gateOnFail = qc.gate?.onFail ?? "MARK_ONLY";
	const gateVideoKeys = videoKeys(state.videos);
	// review-204 N4: radio-group names are document-global; scope per mount.
	const qcGateGroupId = useId();
	const patchGate = (
		rules: NonNullable<WizardQc["gate"]>["rules"],
		onFail: NonNullable<WizardQc["gate"]>["onFail"],
	) =>
		patchQc({
			gate: rules.length === 0 ? undefined : { rules, onFail },
		});
	const patchGateRule = (
		index: number,
		partial: Partial<NonNullable<WizardQc["gate"]>["rules"][number]>,
	) =>
		patchGate(
			gateRules.map((rule, i) =>
				i === index ? { ...rule, ...partial } : rule,
			),
			gateOnFail,
		);
	// Kantar audio watermarking — an encoding-level SINGLETON, so it patches
	// state.kantar directly (unlike NexGuard, which attaches per rendition).
	// Enabling seeds a blank block that buildPlan emits verbatim, so the preview
	// rails every unfilled field loudly (the infrastructure precedent).
	const kantarCredentials = credentials.filter((c) => c.provider === "KANTAR");
	const kantar = state.kantar;
	const patchKantar = (partial: Partial<WizardKantar>) =>
		onPatch({
			kantar: {
				credentialId: "",
				channelName: "",
				contentReference: "",
				serverUrl: "",
				reportPath: "",
				...kantar,
				...partial,
			},
		});
	return (
		<div className="space-y-4">
			<h2 className="font-medium text-sm text-zinc-200">
				{t("wizard.encodingStartOptions")}
			</h2>
			<Field
				label={t("wizard.encodingMode")}
				htmlFor="wz-encmode"
				help={t(
					usesCodecMode
						? "wizard.encodingModeFromLadderHint"
						: "wizard.startencodingrequestEncodingmodeEmptyApiDefa",
				)}
			>
				<SelectNative
					id="wz-encmode"
					disabled={usesCodecMode}
					value={usesCodecMode ? "" : (startOptions.encodingMode ?? "")}
					onChange={(e) =>
						patchStart({
							encodingMode:
								e.target.value === ""
									? undefined
									: (e.target.value as WizardStartOptions["encodingMode"]),
						})
					}
				>
					<option value="">
						{t(
							usesCodecMode
								? "wizard.encodingModeFromLadder"
								: "wizard.default",
						)}
					</option>
					{["STANDARD", "SINGLE_PASS", "TWO_PASS", "THREE_PASS"].map((mode) => (
						<option key={mode} value={mode}>
							{mode}
						</option>
					))}
				</SelectNative>
			</Field>
			<Collapsible summary={t("wizard.startOptionsAdvanced")}>
				<Field
					label={t("wizard.audioVideoSyncMode")}
					htmlFor="wz-avsync"
					help={t("wizard.startencodingrequestTweaksFailsWithDolbyDigi")}
				>
					<SelectNative
						id="wz-avsync"
						value={startOptions.audioVideoSyncMode ?? ""}
						onChange={(e) =>
							patchStart({
								audioVideoSyncMode:
									e.target.value === ""
										? undefined
										: (e.target
												.value as WizardStartOptions["audioVideoSyncMode"]),
							})
						}
					>
						<option value="">{t("wizard.default")}</option>
						{(
							[
								"STANDARD",
								"RESYNC_AT_START",
								"RESYNC_AT_START_AND_END",
							] as const
						).map((mode) => (
							<option key={mode} value={mode}>
								{mode}
							</option>
						))}
					</SelectNative>
				</Field>
				<div className="flex items-center gap-1">
					<label
						htmlFor="wz-vfr"
						className="flex items-center gap-2 text-xs text-zinc-300"
					>
						<input
							id="wz-vfr"
							type="checkbox"
							className="h-3.5 w-3.5 accent-emerald-600"
							checked={startOptions.handleVariableInputFps ?? false}
							onChange={(e) =>
								// Unchecked = unset (no plan key) — the API default. An
								// imported explicit-false plan still round-trips at the
								// model level; ticking then unticking simply returns to unset.
								patchStart({
									handleVariableInputFps: e.target.checked ? true : undefined,
								})
							}
						/>
						{t("wizard.handleVariableInputFps")}
					</label>
					<InfoHint
						label={t("wizard.handleVariableInputFpsMoreInformation")}
						text={t("wizard.startencodingrequestHandlevariableinputfpsDr")}
					/>
				</div>
			</Collapsible>
			<Collapsible
				summary={
					t("wizardX.labelsAndInfrastructure") +
					((state.labels?.length ?? 0) > 0 || infrastructure
						? t("wizardX.setSuffix")
						: "")
				}
			>
				<Field
					label={t("wizard.labels")}
					htmlFor="wz-labels"
					help={t("wizard.commaSeparatedEncodingLabelsTagsThatGroup")}
				>
					<CodesInput
						id="wz-labels"
						placeholder={t("wizard.campaignAUhd")}
						value={state.labels}
						onChange={(labels) => onPatch({ labels })}
					/>
				</Field>
				<Collapsible
					summary={t("wizard.infrastructureAdvanced")}
					help={t("ui.pinThisEncodingOntoACloudConnect")}
				>
					<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
						<Field label={t("wizard.infrastructureId")} htmlFor="wz-infra-id">
							<InfrastructureIdPicker
								inputId="wz-infra-id"
								value={infrastructure?.infrastructureId ?? ""}
								onChange={(infrastructureId) =>
									patchInfrastructure({ infrastructureId })
								}
								bitmovinAccountId={state.accountId || undefined}
							/>
						</Field>
						<Field
							label={t("wizard.infrastructureRegion")}
							htmlFor="wz-infra-region"
						>
							<RegionSelect
								id="wz-infra-region"
								value={infrastructure?.cloudRegion ?? ""}
								onChange={(cloudRegion) => patchInfrastructure({ cloudRegion })}
							/>
						</Field>
					</div>
					<Field
						label={t("ui.prewarmedPoolIds")}
						htmlFor="wz-pool-ids"
						help={
							state.prewarmedEncoderPoolIds?.length === 0
								? undefined
								: t("ui.perPlanPoolPinningHint")
						}
					>
						<PrewarmedPoolPicker
							accountId={state.accountId || undefined}
							csv={(state.prewarmedEncoderPoolIds ?? []).join(", ")}
							onChange={(csv) => {
								const ids = csvToPoolIds(csv);
								onPatch({
									prewarmedEncoderPoolIds: ids.length ? ids : undefined,
								});
							}}
							inputId="wz-pool-ids"
						/>
					</Field>
				</Collapsible>
			</Collapsible>
			<Collapsible
				summary={t("wizard.perTitleConfiguration")}
				help={t("wizard.startRequestPertitleBlocksPairThemWith")}
			>
				{(["h264", "h265", "vp9", "av1"] as const).map((codec) => (
					<PerTitleCodecEditor
						key={codec}
						codec={codec}
						hevcV2={
							codec === "h265" &&
							state.videos.some((video) => video.codec === "H265V2")
						}
						value={startOptions.perTitle?.[codec]}
						onChange={(next) =>
							patchStart({
								perTitle: { ...startOptions.perTitle, [codec]: next },
							})
						}
					/>
				))}
			</Collapsible>
			<Collapsible
				summary={
					t("wizardX.aiSceneAnalysis") +
					(ai && !qcOnly ? t("wizardX.onSuffix") : "")
				}
			>
				{qcOnly ? (
					<p className="text-amber-400 text-xs">
						{t("wizard.aisaDisabledQcOnly")}
					</p>
				) : null}
				<fieldset disabled={qcOnly} className="space-y-3">
					<label
						htmlFor="wz-ai-enable"
						className="flex items-center gap-2 text-xs text-zinc-300"
					>
						<input
							id="wz-ai-enable"
							type="checkbox"
							className="h-3.5 w-3.5 accent-emerald-600"
							checked={ai !== undefined}
							onChange={(e) =>
								patchStart({
									aiSceneAnalysis: e.target.checked
										? { filename: "analysis.json", path: "" }
										: undefined,
								})
							}
						/>
						{t("wizard.enableAiSceneAnalysisTheSamplesRun")}
					</label>
					{ai ? (
						<div className="space-y-3">
							<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
								<Field
									label={t("wizard.assetDescriptionFilename")}
									htmlFor="wz-ai-filename"
								>
									<Input
										id="wz-ai-filename"
										placeholder={t("wizard.analysisJson")}
										value={ai.filename}
										onChange={(e) =>
											patchStart({
												aiSceneAnalysis: { ...ai, filename: e.target.value },
											})
										}
									/>
								</Field>
								<Field
									label={t("wizard.destinationPath")}
									htmlFor="wz-ai-path"
									help={t("wizard.relativeToTheBaseOutputPath")}
								>
									<Input
										id="wz-ai-path"
										placeholder={t("wizard.ai")}
										value={ai.path}
										onChange={(e) =>
											patchStart({
												aiSceneAnalysis: { ...ai, path: e.target.value },
											})
										}
									/>
								</Field>
							</div>
							<label
								htmlFor="wz-ai-adplacement"
								className="flex items-center gap-2 text-xs text-zinc-300"
							>
								<input
									id="wz-ai-adplacement"
									type="checkbox"
									className="h-3.5 w-3.5 accent-emerald-600"
									checked={ai.allSceneBoundaries !== undefined}
									onChange={(e) =>
										patchStart({
											aiSceneAnalysis: {
												...ai,
												allSceneBoundaries: e.target.checked
													? { isEnabled: true, insertCueTags: true }
													: undefined,
											},
										})
									}
								/>
								{t("wizard.automaticAdPlacementAllsceneboundaries")}
							</label>
							{ai.allSceneBoundaries ? (
								<div className="flex gap-6 pl-6">
									{(["isEnabled", "insertCueTags"] as const).map((flag) => (
										<label
											key={flag}
											className="flex items-center gap-2 text-xs text-zinc-300"
										>
											<input
												type="checkbox"
												className="h-3.5 w-3.5 accent-emerald-600"
												checked={ai.allSceneBoundaries?.[flag] ?? false}
												onChange={(e) =>
													patchStart({
														aiSceneAnalysis: {
															...ai,
															allSceneBoundaries: ai.allSceneBoundaries
																? {
																		...ai.allSceneBoundaries,
																		[flag]: e.target.checked,
																	}
																: undefined,
														},
													})
												}
											/>
											{flag}
										</label>
									))}
								</div>
							) : null}
							<AisaScheduleEditor
								value={ai.schedule}
								onChange={(schedule) =>
									patchStart({ aiSceneAnalysis: { ...ai, schedule } })
								}
							/>
							<div className="space-y-1.5">
								<label
									htmlFor="wz-ai-tobacco"
									className="flex items-center gap-2 text-xs text-zinc-300"
								>
									<input
										id="wz-ai-tobacco"
										type="checkbox"
										className="h-3.5 w-3.5 accent-emerald-600"
										aria-describedby="wz-ai-advisories-help"
										checked={
											ai.regulatoryAdvisories?.topics.includes("TOBACCO") ??
											false
										}
										onChange={(event) =>
											patchStart({
												aiSceneAnalysis: {
													...ai,
													regulatoryAdvisories: event.target.checked
														? { topics: ["TOBACCO"] }
														: undefined,
												},
											})
										}
									/>
									{t("wizard.aisaTobacco")}
								</label>
								<p id="wz-ai-advisories-help" className="text-xs text-zinc-500">
									{t("wizard.aisaAdvisoriesHelp")}
								</p>
							</div>
							<Field
								label={t("wizard.outputLanguageCodes")}
								htmlFor="wz-ai-langs"
								hint={t("wizard.aisaDefaultLanguage")}
								help={t("wizard.aisaAdditionalLanguagesHelp")}
							>
								<CodesInput
									id="wz-ai-langs"
									value={ai.outputLanguageCodes}
									onChange={(outputLanguageCodes) =>
										patchStart({
											aiSceneAnalysis: { ...ai, outputLanguageCodes },
										})
									}
								/>
							</Field>
						</div>
					) : null}
				</fieldset>
			</Collapsible>
			{/* : hidden while QC/VMAF is off, so new plans carry no
			    qc block at all — the submit route refuses one that arrives by
			    another door (template, import, API client) rather than
			    stripping it silently. */}
			{/* review-265 131-A4: a plan loaded from a template or an import can
			    CARRY a qc block while the flag is off, and the section that
			    edits it is hidden — the submit 422 then names a remedy the UI
			    cannot perform. Say so, and offer the removal as an explicit
			    operator action: a visible strip is not a silent one. */}
			{!qcVmafEnabled && qcOn ? (
				<div
					role="alert"
					className="rounded-md border border-amber-900 bg-amber-950/30 p-3"
				>
					<p className="text-amber-300 text-xs">
						{t("wizardX.qcDisabledCarriedBlock")}
					</p>
					<Button
						variant="secondary"
						size="sm"
						className="mt-2"
						onClick={() => onPatch({ qc: undefined })}
					>
						{t("wizardX.qcDisabledRemoveBlock")}
					</Button>
				</div>
			) : null}
			{qcVmafEnabled ? (
				<Collapsible
					summary={
						t("wizardX.qualityControlVmaf") +
						(qcOn ? t("wizardX.onSuffix") : "")
					}
				>
					{/* InfoHint sits beside the label (not inside it) so the toggle's
					    accessible name stays the plain text — mirrors Field's ⓘ row. */}
					<div className="flex items-center gap-1">
						<label
							htmlFor="wz-qc-vmaf"
							className="flex items-center gap-2 text-xs text-zinc-300"
						>
							<input
								id="wz-qc-vmaf"
								type="checkbox"
								className="h-3.5 w-3.5 accent-emerald-600"
								checked={qc.vmaf}
								onChange={(e) =>
									// Turning VMAF off while PSNR is on would leave a psnr-only
									// state; clear PSNR too so "off" is a clean default (PSNR
									// can't run without the libvmaf pass anyway).
									patchQc(
										e.target.checked
											? { vmaf: true }
											: { vmaf: false, psnr: false },
									)
								}
							/>
							{t("wizard.runVmafQcAfterEncoding")}
						</label>
						<InfoHint
							label={t("wizard.runVmafQcAfterEncodingMoreInformation")}
							text={t("wizard.addsAProgressiveMp4QcMirrorPer")}
						/>
					</div>
					{qc.vmaf ? (
						<>
							<VmafExecutionSettings
								execution={qc.execution}
								onChange={(execution) => patchQc({ execution })}
							/>
							<Field
								label={t("wizard.vmafModel")}
								htmlFor="wz-qc-model"
								tooltip={t("uiX.libvmafModelTooltip")}
							>
								<SelectNative
									id="wz-qc-model"
									value={qc.model}
									onChange={(e) => patchQc({ model: e.target.value })}
								>
									{VMAF_MODELS.map((model) => (
										<option key={model} value={model}>
											{model.startsWith("vmaf_v1")
												? t("wizardX.vmafV1DockerWorker", { model })
												: model}
										</option>
									))}
								</SelectNative>
							</Field>
							<div className="flex items-center gap-1">
								<label
									htmlFor="wz-qc-psnr"
									className="flex items-center gap-2 text-xs text-zinc-300"
								>
									<input
										id="wz-qc-psnr"
										type="checkbox"
										className="h-3.5 w-3.5 accent-emerald-600"
										checked={qc.psnr}
										onChange={(e) => patchQc({ psnr: e.target.checked })}
									/>
									{t("wizard.alsoComputePsnr")}
								</label>
								<InfoHint
									label={t("wizard.alsoComputePsnrMoreInformation")}
									text={t("wizard.psnrDbRidesTheSameLibvmafPass")}
								/>
							</div>
							<div className="flex items-center gap-1">
								<label
									htmlFor="wz-qc-only"
									className="flex items-center gap-2 text-xs text-zinc-300"
								>
									<input
										id="wz-qc-only"
										type="checkbox"
										className="h-3.5 w-3.5 accent-emerald-600"
										checked={qc.only ?? false}
										onChange={(e) => patchQc({ only: e.target.checked })}
									/>
									{t("wizard.vmafOnlySkipDeliveryOutputs")}
								</label>
								<InfoHint
									label={t("wizard.vmafOnlySkipDeliveryOutputsMoreInformation")}
									text={t("wizard.producesOnlyThePerVideoQcMirror")}
								/>
							</div>
							{/* QC gate editor : threshold rules that turn
							    the measurement into enforcement. Zero rules = no gate key;
							    the schema shape is carried VERBATIM into plan.qc.gate. */}
							<div className="mt-2 space-y-2 border-zinc-800 border-t pt-2">
								<div className="flex items-center gap-1">
									<span className="text-xs text-zinc-300">
										{t("jobDetail.qcGateTitle")}
									</span>
									<InfoHint
										label={t("wizardX.qcGateHintMoreInformation")}
										text={t("wizardX.qcGateHint")}
									/>
								</div>
								{gateRules.map((rule, index) => (
									<div
										// Index-only key (review-204 I1): embedding the mutable
										// metric remounted the row on every metric change and
										// dropped keyboard focus to <body>. Every field is
										// controlled from props, so the index is stable here.
										key={`gate-rule-${index}`}
										className="space-y-1 rounded-md border border-zinc-800 p-2"
									>
										<div className="flex flex-wrap items-center gap-2">
											<SelectNative
												aria-label={`${t("jobDetail.qcGateMetric")} ${index + 1}`}
												className="w-44"
												value={rule.metric}
												onChange={(e) =>
													patchGateRule(index, {
														metric: e.target
															.value as (typeof gateRules)[number]["metric"],
													})
												}
											>
												{QC_GATE_METRICS.map((metric) => (
													<option
														key={metric}
														value={metric}
														// review-204 N5: a PSNR rule with psnr off is a
														// C29 error downstream — say so at authoring
														// time instead of after.
														disabled={metric === "PSNR_MEAN" && !qc.psnr}
													>
														{metric === "PSNR_MEAN" && !qc.psnr
															? t("wizardX.qcGatePsnrOffOption", { metric })
															: metric}
													</option>
												))}
											</SelectNative>
											<SelectNative
												aria-label={`${t("jobDetail.qcGateScope")} ${index + 1}`}
												className="w-40"
												value={rule.scope}
												onChange={(e) =>
													patchGateRule(index, {
														scope: e.target
															.value as (typeof gateRules)[number]["scope"],
													})
												}
											>
												<option value="PER_RENDITION">PER_RENDITION</option>
												<option value="OVERALL">OVERALL</option>
											</SelectNative>
											<label
												htmlFor={`wz-qc-gate-gte-${index}`}
												className="flex items-center gap-1 text-xs text-zinc-400"
											>
												{t("jobDetail.qcGateThreshold")}
												<Input
													id={`wz-qc-gate-gte-${index}`}
													type="number"
													min={0}
													max={100}
													step={0.1}
													className="w-20"
													value={rule.gte}
													onChange={(e) => {
														// review-204 I2: clearing the box used to snap to
														// gte 0 — a rule no measured value can fail. Keep
														// the LAST VALID threshold instead; the C29
														// warning below covers a deliberate 0.
														const parsed = Number(e.target.value);
														if (
															e.target.value !== "" &&
															Number.isFinite(parsed)
														) {
															patchGateRule(index, { gte: parsed });
														}
													}}
												/>
											</label>
											<Button
												variant="ghost"
												size="sm"
												aria-label={`${t("wizardX.qcGateRemoveRule")} ${index + 1}`}
												onClick={() =>
													patchGate(
														gateRules.filter((_, i) => i !== index),
														gateOnFail,
													)
												}
											>
												{t("wizard.remove")}
											</Button>
										</div>
										<div className="flex flex-wrap items-center gap-2 text-xs text-zinc-400">
											<span>{t("wizardX.qcGateTargets")}</span>
											{/* review-204 N1: keys a ladder edit ORPHANED render as
											    checked boxes too — invisible-and-unclearable was the
											    only GUI recovery being rule deletion. The C29 rail
											    still blocks the plan; this gives the untick. */}
											{(rule.renditions ?? [])
												.filter((key) => !gateVideoKeys.includes(key))
												.map((orphan) => (
													<label
														key={orphan}
														className="flex items-center gap-1 text-amber-400 text-xs"
													>
														<input
															type="checkbox"
															className="h-3 w-3 accent-amber-500"
															checked
															onChange={() => {
																const next = (rule.renditions ?? []).filter(
																	(k) => k !== orphan,
																);
																patchGateRule(index, {
																	renditions:
																		next.length > 0 ? next : undefined,
																});
															}}
														/>
														{orphan}
													</label>
												))}
											{gateVideoKeys.map((key) => {
												const selected =
													rule.renditions?.includes(key) ?? false;
												return (
													<label
														key={key}
														className="flex items-center gap-1 text-xs text-zinc-300"
													>
														<input
															type="checkbox"
															className="h-3 w-3 accent-emerald-600"
															checked={selected}
															onChange={(e) => {
																const current = rule.renditions ?? [];
																const next = e.target.checked
																	? [...current, key]
																	: current.filter((k) => k !== key);
																// Empty selection = rule.renditions ABSENT
																// (= every measured-expected rendition).
																patchGateRule(index, {
																	renditions:
																		next.length > 0 ? next : undefined,
																});
															}}
														/>
														{key}
													</label>
												);
											})}
										</div>
									</div>
								))}
								<Button
									variant="secondary"
									size="sm"
									onClick={() =>
										patchGate(
											[
												...gateRules,
												{ metric: "VMAF_MEAN", scope: "OVERALL", gte: 80 },
											],
											gateOnFail,
										)
									}
								>
									{t("wizardX.qcGateAddRule")}
								</Button>
								{gateRules.length > 0 ? (
									<div className="space-y-1">
										<span className="text-xs text-zinc-400">
											{t("wizardX.qcGateOnFail")}
										</span>
										{(["MARK_ONLY", "BLOCK_MANIFESTS"] as const).map((mode) => (
											<label
												key={mode}
												className="flex items-center gap-2 text-xs text-zinc-300"
											>
												<input
													type="radio"
													name={`wz-qc-gate-onfail-${qcGateGroupId}`}
													className="h-3 w-3 accent-emerald-600"
													checked={gateOnFail === mode}
													onChange={() => patchGate(gateRules, mode)}
												/>
												{mode === "MARK_ONLY"
													? t("jobDetail.qcGateMarkOnly")
													: t("jobDetail.qcGateBlocking")}
											</label>
										))}
										{gateOnFail === "BLOCK_MANIFESTS" ? (
											<p className="text-xs text-zinc-500">
												{t("wizardX.qcGateBlockNeedsPost")}
											</p>
										) : null}
									</div>
								) : null}
							</div>
						</>
					) : null}
				</Collapsible>
			) : null}
			<Collapsible
				summary={
					t("wizardX.kantarAudioWatermarking") +
					(kantar ? t("wizardX.onSuffix") : "")
				}
				help={t("ui.embedsAnInaudibleKantarWatermarkInThe")}
			>
				<label
					htmlFor="wz-kantar-enable"
					className="flex items-center gap-2 text-xs text-zinc-300"
				>
					<input
						id="wz-kantar-enable"
						type="checkbox"
						className="h-3.5 w-3.5 accent-emerald-600"
						checked={kantar !== undefined}
						onChange={(e) =>
							onPatch({
								kantar: e.target.checked
									? {
											credentialId: "",
											channelName: "",
											contentReference: "",
											serverUrl: "",
											reportPath: "",
										}
									: undefined,
							})
						}
					/>
					{t("wizard.enableKantarAudioWatermarking")}
				</label>
				{kantar ? (
					<div className="space-y-3">
						{state.audios.length === 0 ? (
							<p className="text-amber-400 text-xs">
								{t("wizard.thisPlanHasNoAudioRenditionAdd")}
							</p>
						) : null}
						<Field
							label={t("wizard.kantarCredential")}
							htmlFor="wz-kantar-cred"
							help={t("wizard.vaultCredentialTheServiceLoginPasswordNever")}
						>
							<SelectNative
								id="wz-kantar-cred"
								value={kantar.credentialId}
								onChange={(e) => patchKantar({ credentialId: e.target.value })}
							>
								<option value="">{t("wizard.selectCredential")}</option>
								{kantarCredentials.map((credential) => (
									<option key={credential.id} value={credential.id}>
										{credential.label}
									</option>
								))}
							</SelectNative>
							<NewCredentialLink />
						</Field>
						<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
							<Field
								label={t("wizard.licenseId")}
								htmlFor="wz-kantar-license"
								help={t("wizard.kantarLicenseIdInteger")}
							>
								<Input
									id="wz-kantar-license"
									type="number"
									min={1}
									placeholder="4711"
									value={kantar.licenseId ?? ""}
									onChange={(e) =>
										// Blank stays blank (undefined) so the preview says
										// "expected number" rather than the form inventing a 0.
										patchKantar({
											licenseId:
												e.target.value === ""
													? undefined
													: Number(e.target.value),
										})
									}
								/>
							</Field>
							<Field
								label={t("wizard.channelName")}
								htmlFor="wz-kantar-channel"
								help={t("wizard.kantarChannelThisContentIsReportedUnder")}
							>
								<Input
									id="wz-kantar-channel"
									placeholder={t("wizard.demoChannelJp")}
									value={kantar.channelName}
									onChange={(e) => patchKantar({ channelName: e.target.value })}
								/>
							</Field>
							<Field
								label={t("wizard.contentReference")}
								htmlFor="wz-kantar-content-ref"
								help={t("wizard.yourIdentifierForThisAssetInKantar")}
							>
								<Input
									id="wz-kantar-content-ref"
									placeholder="bbb-2026-08-06-ep01"
									value={kantar.contentReference}
									onChange={(e) =>
										patchKantar({ contentReference: e.target.value })
									}
								/>
							</Field>
							<Field
								label={t("wizard.serverUrl")}
								htmlFor="wz-kantar-server-url"
								help={t("wizard.kantarWatermarkingServiceEndpoint")}
							>
								<Input
									id="wz-kantar-server-url"
									placeholder="https://kantar.example.com/watermark"
									value={kantar.serverUrl}
									onChange={(e) => patchKantar({ serverUrl: e.target.value })}
								/>
							</Field>
						</div>
						<Field
							label={t("wizard.reportPath")}
							htmlFor="wz-kantar-report-path"
							help={t("wizard.relativeToTheBaseOutputPathWhere")}
						>
							<Input
								id="wz-kantar-report-path"
								placeholder={t("wizard.reports")}
								value={kantar.reportPath}
								onChange={(e) => patchKantar({ reportPath: e.target.value })}
							/>
						</Field>
						<div className="flex items-center gap-1">
							<label
								htmlFor="wz-kantar-report-private"
								className="flex items-center gap-2 text-xs text-zinc-300"
							>
								<input
									id="wz-kantar-report-private"
									type="checkbox"
									className="h-3.5 w-3.5 accent-emerald-600"
									checked={kantar.reportPrivate ?? false}
									onChange={(e) =>
										patchKantar({
											reportPrivate: e.target.checked ? true : undefined,
										})
									}
								/>
								{t("wizard.writeTheReportPrivatelyAclPrivate")}
							</label>
							<InfoHint
								label={t("wizard.writeTheReportPrivatelyAclPrivateMore")}
								text={t("wizard.theProcessingReportIsOperationalDataSo")}
							/>
						</div>
					</div>
				) : null}
			</Collapsible>
		</div>
	);
}
