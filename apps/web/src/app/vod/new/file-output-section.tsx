"use client";

import { Button } from "@/components/ui/button";
import { Field, FieldRowAction } from "@/components/ui/field";
import { Input, SelectNative } from "@/components/ui/input";
import { useT } from "@/lib/i18n/context";
import { AUDIO_CHANNEL_LAYOUTS } from "./audio-channel-layouts";
import type {
	WizardAudioCodec,
	WizardAudioRendition,
	WizardMuxingKind,
	WizardState,
	WizardVideoCodec,
	WizardVideoRendition,
} from "./build-plan";
import { AudioCutoffEditor } from "./codec-detail-editor";
import {
	addFile,
	editFile,
	editFileAudio,
	FILE_CONTAINERS,
	type FileAudioEdit,
	type FileEdit,
	fileAudios,
	fileCaveats,
	fileContainer,
	filesNeedOneMode,
	hevcV2Lacks,
	hevcV2NotAlone,
	lacksAtmosSource,
	misreadDolbyStream,
	removeFile,
	sameStreamFiles,
	sequenceLeavesOutAudio,
	setFileAudio,
	sharedFileNames,
	writtenFileName,
} from "./file-output";
import {
	Av1AdvancedEditor,
	H264AdvancedEditor,
	H265AdvancedEditor,
	H265V2AdvancedEditor,
	LoudnessEditor,
	Vp9AdvancedEditor,
} from "./rendition-editors";
import { renditionSourceOptions } from "./rendition-sources";

const ENCODING_MODES = [
	"STANDARD",
	"SINGLE_PASS",
	"TWO_PASS",
	"THREE_PASS",
] as const;

/** An emptied number field is "unset", not zero. */
function whole(value: string): number | null {
	return value === "" ? null : Math.max(0, Math.round(Number(value)));
}

type SourceOption = { value: string; label: string };

/**
 * The file-output flow's format step: the files to write, each with its video and
 * the audio track it holds. It stands in for the ladder, packaging and manifest
 * steps, and edits the same state they do (see `file-output.ts`).
 */
export function FileOutputSection({
	state,
	hevcV2Available = false,
	onPatch,
}: {
	state: WizardState;
	/** The account may use the internal HEVCv2 encoder, as in the ladder step. */
	hevcV2Available?: boolean;
	onPatch: (partial: Partial<WizardState>) => void;
}) {
	const { t } = useT();
	const { videos } = state;
	const tracks = fileAudios(state);
	const sharedNames = sharedFileNames(videos);
	const sameStreams = sameStreamFiles(videos);
	const sources = renditionSourceOptions(state, t);
	const visionMetadataKeys = (state.sources?.dolbyStreams ?? [])
		.filter((stream) => stream.kind === "VISION_METADATA")
		.map((stream) => stream.key);
	// Dolby Atmos reads an Atmos source as it is, so a mixed stream is not one of
	// its sources — the ladder leaves them out the same way.
	const mixKeys = (state.sources?.audioMixStreams ?? []).map((mix) => mix.key);
	const atmosSources = sources.audio.filter(
		(option) => !mixKeys.includes(option.value),
	);
	const needsOneMode = filesNeedOneMode(state);
	const hevcV2Mixed = hevcV2NotAlone(state);
	// With an input sequence, every file is made from it: the plan reads the
	// sequence whatever a file names as its source, so what a source would be
	// refused for is not said, and the selects say they are not in use.
	const sequence = state.inputTimeline !== undefined;
	const sequenceWithoutAudio = sequenceLeavesOutAudio(state);

	return (
		<section aria-labelledby="wz-files-heading">
			<div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
				<h2 id="wz-files-heading" className="font-medium text-sm text-zinc-200">
					{t("vodFlow.files")}
				</h2>
				<Button
					variant="secondary"
					size="sm"
					onClick={() => onPatch(addFile(state))}
				>
					{t("vodFlow.addFile")}
				</Button>
			</div>
			<div className="mt-2 space-y-3">
				{videos.map((video, index) => (
					<FileEditor
						// Files have no identity beyond their position, as in the ladder.
						key={index}
						index={index}
						video={video}
						audio={tracks[index]}
						sharedName={sharedNames[index] === true}
						sameStream={sameStreams[index] === true}
						removable={videos.length > 1}
						hevcV2Available={hevcV2Available}
						videoSources={sources.video}
						audioSources={
							tracks[index]?.codec === "DOLBY_ATMOS"
								? atmosSources
								: sources.audio
						}
						visionMetadataKeys={visionMetadataKeys}
						atmosSourceMissing={
							!sequence && lacksAtmosSource(state, tracks[index])
						}
						videoSourceMisread={
							sequence ? undefined : misreadDolbyStream(state, video, "video")
						}
						audioSourceMisread={
							sequence
								? undefined
								: misreadDolbyStream(state, tracks[index], "audio")
						}
						sourcesUnused={sequence}
						sequenceWithoutAudio={sequenceWithoutAudio}
						needsOneMode={needsOneMode}
						hevcV2Mixed={hevcV2Mixed}
						onEdit={(edit) => onPatch(editFile(state, index, edit))}
						onAudio={(enabled) => onPatch(setFileAudio(state, index, enabled))}
						onEditAudio={(edit) => onPatch(editFileAudio(state, index, edit))}
						onRemove={() => onPatch(removeFile(state, index))}
					/>
				))}
			</div>
		</section>
	);
}

/**
 * Which stream a file's video or audio reads. With one input there is nothing to
 * choose and the field is left out — unless the stream chosen earlier is gone from
 * the sources: then the plan cannot be built, and this is where it is put right.
 */
function SourceSelect({
	id,
	label,
	value,
	options,
	error,
	hint,
	onChange,
}: {
	id: string;
	label: string;
	/** A stream key; "" is the input's own track. */
	value: string;
	options: SourceOption[];
	error?: string;
	hint?: string;
	onChange: (source: string) => void;
}) {
	const { t } = useT();
	const missing =
		value !== "" && !options.some((option) => option.value === value);
	if (options.length <= 1 && !missing) return null;
	return (
		<Field label={label} htmlFor={id} error={error} hint={hint}>
			<SelectNative
				id={id}
				value={value}
				onChange={(event) => onChange(event.target.value)}
			>
				{missing ? (
					<option value={value}>
						{value} {t("wizardX.missingParen")}
					</option>
				) : null}
				{options.map((option) => (
					<option key={option.value} value={option.value}>
						{option.label}
					</option>
				))}
			</SelectNative>
		</Field>
	);
}

function FileEditor({
	index,
	video,
	audio,
	sharedName,
	sameStream,
	removable,
	hevcV2Available,
	videoSources,
	audioSources,
	visionMetadataKeys,
	atmosSourceMissing,
	videoSourceMisread,
	audioSourceMisread,
	sourcesUnused,
	sequenceWithoutAudio,
	needsOneMode,
	hevcV2Mixed,
	onEdit,
	onAudio,
	onEditAudio,
	onRemove,
}: {
	index: number;
	video: WizardVideoRendition;
	/** The audio track this file holds; `undefined` writes the file without one. */
	audio: WizardAudioRendition | undefined;
	/** Another file writes this name too, into the same folder. */
	sharedName: boolean;
	/** Another file has this height, bitrate and codec, and the plan needs them apart. */
	sameStream: boolean;
	removable: boolean;
	hevcV2Available: boolean;
	videoSources: SourceOption[];
	audioSources: SourceOption[];
	visionMetadataKeys: string[];
	atmosSourceMissing: boolean;
	/** The Dolby stream the video, or the track, reads and cannot be made from. */
	videoSourceMisread: "ATMOS" | "VISION" | "OTHER" | undefined;
	audioSourceMisread: "ATMOS" | "VISION" | "OTHER" | undefined;
	/** An input sequence is on, and the files are made from it. */
	sourcesUnused: boolean;
	/** That sequence has no audio, so no file has. */
	sequenceWithoutAudio: boolean;
	/** The files are in more than one video codec and not all in one mode. */
	needsOneMode: boolean;
	/** A file is in HEVCv2 and the job is not one HEVCv2 can be in. */
	hevcV2Mixed: boolean;
	onEdit: (edit: FileEdit) => void;
	onAudio: (enabled: boolean) => void;
	onEditAudio: (edit: FileAudioEdit) => void;
	onRemove: () => void;
}) {
	const { t } = useT();
	const id = `wz-file-${index}`;
	const n = index + 1;
	const container = fileContainer(video.muxing?.kind);
	const codec = video.codec ?? "H264";
	// HEVCv2 is H.265 to a container, and is offered where the ladder offers it.
	// The current value stays selectable even when it is not offered, so the select
	// shows what the plan says.
	const codecs = [
		...new Set<WizardVideoCodec>([
			...(container?.video ?? []),
			...(hevcV2Available && container?.video.includes("H265")
				? ["H265V2" as const]
				: []),
			codec,
		]),
	];
	const caveats = fileCaveats(video, audio);
	const crf =
		codec === "H264"
			? video.h264?.crf
			: codec === "H265"
				? video.h265?.crf
				: codec === "VP9"
					? video.vp9?.crf
					: undefined;
	const lacks = hevcV2Lacks(video);
	return (
		<fieldset className="space-y-3 rounded-md border border-zinc-800 p-3">
			<legend className="px-1 text-xs text-zinc-400">
				{t("vodFlow.fileN", { n })}
			</legend>
			<div className="flex flex-wrap items-start gap-2">
				<Field
					label={t("vodFlow.container")}
					htmlFor={`${id}-kind`}
					hint={
						caveats.includes("unmeasured")
							? t("vodFlow.unmeasuredContainer")
							: undefined
					}
				>
					<SelectNative
						id={`${id}-kind`}
						className="w-44"
						value={video.muxing?.kind ?? ""}
						onChange={(event) =>
							onEdit({ kind: event.target.value as WizardMuxingKind })
						}
					>
						{FILE_CONTAINERS.map((item) => (
							<option key={item.kind} value={item.kind}>
								{item.label}
							</option>
						))}
					</SelectNative>
				</Field>
				<div className="min-w-48 flex-1">
					<Field
						label={t("vodFlow.fileName")}
						htmlFor={`${id}-name`}
						error={
							// Only some containers have a name of their own to fall back on.
							writtenFileName(video) === ""
								? t("vodFlow.fileNameRequired")
								: sharedName
									? t("vodFlow.sameFileName")
									: undefined
						}
					>
						<Input
							id={`${id}-name`}
							value={video.muxing?.filename ?? ""}
							placeholder={
								container?.fallbackName ??
								`output.${container?.extension ?? "mp4"}`
							}
							onChange={(event) => onEdit({ filename: event.target.value })}
						/>
					</Field>
				</div>
				{removable ? (
					<FieldRowAction>
						<Button
							variant="destructive"
							size="sm"
							aria-label={t("vodFlow.removeFileN", { n })}
							onClick={onRemove}
						>
							{t("wizard.remove")}
						</Button>
					</FieldRowAction>
				) : null}
			</div>
			<div className="grid grid-cols-2 gap-2">
				<Field
					label={t("wizard.codec")}
					htmlFor={`${id}-codec`}
					error={
						hevcV2Mixed
							? t("vodFlow.hevcV2WholeJob")
							: caveats.includes("videoNotHeld")
								? t("vodFlow.codecNotHeld", {
										container: container?.label ?? "",
									})
								: caveats.includes("av1DolbyVision")
									? t("vodFlow.av1DolbyVision")
									: undefined
					}
					hint={
						caveats.includes("unverifiedVideo")
							? t("vodFlow.unverifiedCodec")
							: caveats.includes("unverifiedDolbyVision")
								? t("vodFlow.unverifiedDolbyVision")
								: undefined
					}
				>
					<SelectNative
						id={`${id}-codec`}
						value={codec}
						onChange={(event) =>
							onEdit({ codec: event.target.value as WizardVideoCodec })
						}
					>
						{codecs.map((item) => (
							<option key={item} value={item}>
								{item === "H265V2" ? "HEVCv2" : item}
							</option>
						))}
					</SelectNative>
				</Field>
				<Field
					label={t("wizard.encodingMode")}
					htmlFor={`${id}-mode`}
					error={needsOneMode ? t("vodFlow.oneModeForCodecs") : undefined}
				>
					<SelectNative
						id={`${id}-mode`}
						// HEVCv2 has the one mode, as in the ladder.
						disabled={codec === "H265V2"}
						value={
							codec === "H265V2" ? "SMART_PASS" : (video.encodingMode ?? "")
						}
						onChange={(event) =>
							onEdit({
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
								{ENCODING_MODES.map((mode) => (
									<option key={mode} value={mode}>
										{mode}
									</option>
								))}
							</>
						)}
					</SelectNative>
				</Field>
				<Field
					label={t("wizard.heightP")}
					htmlFor={`${id}-height`}
					error={lacks.height ? t("vodFlow.hevcV2NeedsHeight") : undefined}
				>
					<Input
						id={`${id}-height`}
						type="number"
						placeholder={t("vodFlow.sourceHeight")}
						value={video.height ?? ""}
						onChange={(event) => onEdit({ height: whole(event.target.value) })}
					/>
				</Field>
				<Field
					label={t("wizard.bitrateBps")}
					htmlFor={`${id}-bitrate`}
					error={
						sameStream
							? t("vodFlow.sameSettings")
							: lacks.bitrate
								? t("vodFlow.hevcV2NeedsBitrate")
								: undefined
					}
					hint={
						video.bitrate !== null || crf !== undefined
							? undefined
							: codec === "H264" || codec === "H265" || codec === "VP9"
								? t("vodFlow.bitrateOrCrf")
								: t("vodFlow.bitrateRequired")
					}
				>
					<Input
						id={`${id}-bitrate`}
						type="number"
						value={video.bitrate ?? ""}
						onChange={(event) => onEdit({ bitrate: whole(event.target.value) })}
					/>
				</Field>
			</div>
			<SourceSelect
				id={`${id}-source`}
				label={t("vodFlow.videoSource")}
				value={video.extras?.source ?? ""}
				options={videoSources}
				error={
					videoSourceMisread === "ATMOS"
						? t("vodFlow.atmosStreamForAtmos")
						: videoSourceMisread === "VISION"
							? t("vodFlow.visionStreamForVideo")
							: videoSourceMisread === "OTHER"
								? t("vodFlow.sourceNotForVideo")
								: undefined
				}
				hint={sourcesUnused ? t("vodFlow.sourceUnusedWithSequence") : undefined}
				onChange={(source) => onEdit({ source })}
			/>
			{codec === "H264" ? (
				<H264AdvancedEditor
					idBase={`${id}-h264`}
					value={video.h264}
					onChange={(h264) => onEdit({ h264 })}
				/>
			) : codec === "H265V2" ? (
				<H265V2AdvancedEditor
					idBase={`${id}-h265v2`}
					qualityControlsAvailable={hevcV2Available}
					value={video.h265}
					onChange={(h265) => onEdit({ h265 })}
				/>
			) : codec === "H265" ? (
				<H265AdvancedEditor
					idBase={`${id}-h265`}
					value={video.h265}
					visionMetadataKeys={visionMetadataKeys}
					onChange={(h265) => onEdit({ h265 })}
				/>
			) : codec === "VP9" ? (
				<Vp9AdvancedEditor
					idBase={`${id}-vp9`}
					value={video.vp9}
					onChange={(vp9) => onEdit({ vp9 })}
				/>
			) : (
				<Av1AdvancedEditor
					idBase={`${id}-av1`}
					value={video.av1}
					onChange={(av1) => onEdit({ av1 })}
				/>
			)}
			<FileAudioEditor
				id={`${id}-audio`}
				container={container?.label}
				codecs={container?.audio ?? []}
				audio={audio}
				notHeld={caveats.includes("audioNotHeld")}
				unverified={caveats.includes("unverifiedAudio")}
				besideAv1={caveats.includes("av1WebmAudio")}
				besideDolbyVision={caveats.includes("dolbyVisionAudio")}
				atmosSourceMissing={atmosSourceMissing}
				sourceMisread={audioSourceMisread}
				sourcesUnused={sourcesUnused}
				sequenceWithoutAudio={sequenceWithoutAudio}
				sources={audioSources}
				onAudio={onAudio}
				onEdit={onEditAudio}
			/>
		</fieldset>
	);
}

/** The audio track of one file: whether it has one, and its settings. */
function FileAudioEditor({
	id,
	container,
	codecs,
	audio,
	notHeld,
	unverified,
	besideAv1,
	besideDolbyVision,
	atmosSourceMissing,
	sourceMisread,
	sourcesUnused,
	sequenceWithoutAudio,
	sources,
	onAudio,
	onEdit,
}: {
	id: string;
	/** The container's name, for the message that it cannot hold the codec. */
	container: string | undefined;
	/** The audio codecs the file's container holds. */
	codecs: readonly WizardAudioCodec[];
	audio: WizardAudioRendition | undefined;
	notHeld: boolean;
	unverified: boolean;
	besideAv1: boolean;
	/** The track is Dolby Atmos and reads something other than an Atmos source. */
	atmosSourceMissing: boolean;
	/** The codec is one Bitmovin's rules do not name beside Dolby Vision video. */
	besideDolbyVision: boolean;
	/** The Dolby stream the track reads and cannot be made from. */
	sourceMisread: "ATMOS" | "VISION" | "OTHER" | undefined;
	/** An input sequence is on, and the files are made from it. */
	sourcesUnused: boolean;
	/** That sequence has no audio, so the file is written without this track. */
	sequenceWithoutAudio: boolean;
	sources: SourceOption[];
	onAudio: (enabled: boolean) => void;
	onEdit: (edit: FileAudioEdit) => void;
}) {
	const { t } = useT();
	const codec = audio?.codec ?? "AAC";
	// The current value stays selectable even when the container cannot hold it, so
	// the select shows what the plan says, and the field says what is wrong.
	const offered = [...new Set<WizardAudioCodec>([...codecs, codec])];
	const layouts = codec === "DOLBY_ATMOS" ? [] : AUDIO_CHANNEL_LAYOUTS[codec];
	return (
		<div className="space-y-3 border-zinc-800 border-t pt-3">
			<label
				htmlFor={id}
				className="flex items-center gap-2 text-sm text-zinc-300"
			>
				<input
					id={id}
					type="checkbox"
					className="h-4 w-4 accent-emerald-600"
					checked={audio !== undefined}
					aria-describedby={
						audio && sequenceWithoutAudio ? `${id}-sequence` : undefined
					}
					onChange={(event) => onAudio(event.target.checked)}
				/>
				{t("vodFlow.includeAudio")}
			</label>
			{audio && sequenceWithoutAudio ? (
				<p
					id={`${id}-sequence`}
					role="alert"
					className="text-amber-400 text-xs"
				>
					{t("vodFlow.sequenceWithoutAudio")}
				</p>
			) : null}
			{audio ? (
				<>
					<div className="grid grid-cols-2 gap-2">
						<Field
							label={t("vodFlow.audioCodec")}
							htmlFor={`${id}-codec`}
							error={
								notHeld
									? t("vodFlow.codecNotHeld", {
											container: container ?? "",
										})
									: atmosSourceMissing
										? t("vodFlow.atmosNeedsSource")
										: undefined
							}
							hint={
								besideAv1
									? t("vodFlow.av1WebmAudio")
									: unverified
										? t("vodFlow.unverifiedCodec")
										: besideDolbyVision
											? t("vodFlow.dolbyVisionAudio")
											: undefined
							}
						>
							<SelectNative
								id={`${id}-codec`}
								value={codec}
								onChange={(event) =>
									onEdit({ codec: event.target.value as WizardAudioCodec })
								}
							>
								{offered.map((item) => (
									<option key={item} value={item}>
										{item}
									</option>
								))}
							</SelectNative>
						</Field>
						{codec === "DOLBY_ATMOS" ? null : (
							<Field label={t("wizard.channelLayout")} htmlFor={`${id}-layout`}>
								<SelectNative
									id={`${id}-layout`}
									value={audio.channelLayout ?? ""}
									onChange={(event) =>
										onEdit({ channelLayout: event.target.value || undefined })
									}
								>
									<option value="">{t("wizard.default")}</option>
									{audio.channelLayout &&
									!layouts.includes(audio.channelLayout) ? (
										<option value={audio.channelLayout}>
											{audio.channelLayout}
										</option>
									) : null}
									{layouts.map((layout) => (
										<option key={layout} value={layout}>
											{layout}
										</option>
									))}
								</SelectNative>
							</Field>
						)}
						<Field
							label={t("vodFlow.audioBitrate")}
							htmlFor={`${id}-bitrate`}
							error={audio.bitrate ? undefined : t("vodFlow.bitrateRequired")}
						>
							<Input
								id={`${id}-bitrate`}
								type="number"
								value={audio.bitrate}
								onChange={(event) =>
									onEdit({ bitrate: whole(event.target.value) ?? 0 })
								}
							/>
						</Field>
						<Field
							label={t("wizard.sampleRateHz")}
							htmlFor={`${id}-rate`}
							error={audio.rate ? undefined : t("vodFlow.sampleRateRequired")}
						>
							<Input
								id={`${id}-rate`}
								type="number"
								value={audio.rate}
								onChange={(event) =>
									onEdit({ rate: whole(event.target.value) ?? 0 })
								}
							/>
						</Field>
					</div>
					<SourceSelect
						id={`${id}-source`}
						label={t("vodFlow.audioSource")}
						value={audio.extras?.source ?? ""}
						options={sources}
						error={
							sourceMisread === "ATMOS"
								? t("vodFlow.atmosStreamForAtmos")
								: sourceMisread === "VISION"
									? t("vodFlow.visionStreamForVideo")
									: sourceMisread === "OTHER"
										? t("vodFlow.sourceNotForAudio")
										: undefined
						}
						hint={
							sourcesUnused ? t("vodFlow.sourceUnusedWithSequence") : undefined
						}
						onChange={(source) => onEdit({ source })}
					/>
					{codec === "DOLBY_ATMOS" ? (
						<LoudnessEditor
							idBase={`${id}-loud`}
							value={audio.loudness}
							onChange={(loudness) => onEdit({ loudness })}
						/>
					) : null}
					{codec === "AAC" || codec === "AC3" || codec === "EAC3" ? (
						<AudioCutoffEditor
							id={`${id}-cutoff`}
							value={audio.cutoffFrequency}
							onChange={(cutoffFrequency) => onEdit({ cutoffFrequency })}
						/>
					) : null}
				</>
			) : (
				<p className="text-xs text-zinc-500">{t("vodFlow.noAudio")}</p>
			)}
		</div>
	);
}
