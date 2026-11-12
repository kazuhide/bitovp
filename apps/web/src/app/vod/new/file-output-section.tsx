"use client";

import { Button } from "@/components/ui/button";
import { Field, FieldRowAction } from "@/components/ui/field";
import { Input, SelectNative } from "@/components/ui/input";
import { useT } from "@/lib/i18n/context";
import { AUDIO_CHANNEL_LAYOUTS } from "./audio-channel-layouts";
import type {
	WizardAudioCodec,
	WizardMuxingKind,
	WizardState,
	WizardVideoCodec,
	WizardVideoRendition,
} from "./build-plan";
import {
	addFile,
	editFile,
	editFileAudio,
	FILE_CONTAINERS,
	type FileEdit,
	fileAudioCodecs,
	fileContainer,
	removeFile,
	setFileAudio,
	sharedFileNames,
	writtenFileName,
} from "./file-output";
import { H264AdvancedEditor, H265AdvancedEditor } from "./rendition-editors";
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

/**
 * The file-output flow's format step: the files to write and the one audio track
 * they all carry. It stands in for the ladder, packaging, encoding and manifest steps,
 * and edits the same state they do (see `file-output.ts`).
 */
export function FileOutputSection({
	state,
	onPatch,
}: {
	state: WizardState;
	onPatch: (partial: Partial<WizardState>) => void;
}) {
	const { t, locale } = useT();
	const { videos } = state;
	const audio = state.audios[0];
	const sharedNames = sharedFileNames(videos);
	const sources = renditionSourceOptions(state, t);
	const visionMetadataKeys = (state.sources?.dolbyStreams ?? [])
		.filter((stream) => stream.kind === "VISION_METADATA")
		.map((stream) => stream.key);
	const audioCodec = audio?.codec ?? "AAC";
	// The current value stays selectable even when a container cannot hold it, so
	// the select shows what the plan says, and the field names the containers.
	const audioCodecs = [...new Set([...fileAudioCodecs(videos), audioCodec])];
	const cannotHoldAudio = [
		...new Set(
			videos.flatMap((video) => {
				const container = fileContainer(video.muxing?.kind);
				return container && !container.audio.includes(audioCodec)
					? [container.label]
					: [];
			}),
		),
	];
	const layouts =
		audioCodec === "DOLBY_ATMOS" ? [] : AUDIO_CHANNEL_LAYOUTS[audioCodec];

	return (
		<div className="space-y-6">
			<section aria-labelledby="wz-files-heading">
				<div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
					<h2
						id="wz-files-heading"
						className="font-medium text-sm text-zinc-200"
					>
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
							sharedName={sharedNames[index] === true}
							removable={videos.length > 1}
							sourceOptions={sources.video}
							visionMetadataKeys={visionMetadataKeys}
							onEdit={(edit) => onPatch(editFile(state, index, edit))}
							onRemove={() => onPatch(removeFile(state, index))}
						/>
					))}
				</div>
			</section>

			<section aria-labelledby="wz-file-audio-heading">
				<h2
					id="wz-file-audio-heading"
					className="font-medium text-sm text-zinc-200"
				>
					{t("vodFlow.audio")}
				</h2>
				<label
					htmlFor="wz-file-audio"
					className="mt-2 flex items-center gap-2 text-sm text-zinc-300"
				>
					<input
						id="wz-file-audio"
						type="checkbox"
						className="h-4 w-4 accent-emerald-600"
						checked={audio !== undefined}
						onChange={(event) =>
							onPatch(setFileAudio(state, event.target.checked))
						}
					/>
					{t("vodFlow.includeAudio")}
				</label>
				{audio ? (
					<div className="mt-3 space-y-3 rounded-md border border-zinc-800 p-3">
						<div className="grid grid-cols-2 gap-2">
							<Field
								label={t("wizard.codec")}
								htmlFor="wz-file-audio-codec"
								error={
									cannotHoldAudio.length > 0
										? t("vodFlow.audioCodecNotHeld", {
												containers: new Intl.ListFormat(locale, {
													type: "conjunction",
												}).format(cannotHoldAudio),
											})
										: undefined
								}
							>
								<SelectNative
									id="wz-file-audio-codec"
									value={audioCodec}
									onChange={(event) =>
										onPatch(
											editFileAudio(state, {
												codec: event.target.value as WizardAudioCodec,
											}),
										)
									}
								>
									{audioCodecs.map((codec) => (
										<option key={codec} value={codec}>
											{codec}
										</option>
									))}
								</SelectNative>
							</Field>
							<Field
								label={t("wizard.channelLayout")}
								htmlFor="wz-file-audio-layout"
							>
								<SelectNative
									id="wz-file-audio-layout"
									value={audio.channelLayout ?? ""}
									onChange={(event) =>
										onPatch(
											editFileAudio(state, {
												channelLayout: event.target.value || undefined,
											}),
										)
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
							<Field
								label={t("wizard.bitrateBps")}
								htmlFor="wz-file-audio-bitrate"
							>
								<Input
									id="wz-file-audio-bitrate"
									type="number"
									value={audio.bitrate}
									onChange={(event) =>
										onPatch(
											editFileAudio(state, {
												bitrate: whole(event.target.value) ?? 0,
											}),
										)
									}
								/>
							</Field>
							<Field
								label={t("wizard.sampleRateHz")}
								htmlFor="wz-file-audio-rate"
							>
								<Input
									id="wz-file-audio-rate"
									type="number"
									value={audio.rate}
									onChange={(event) =>
										onPatch(
											editFileAudio(state, {
												rate: whole(event.target.value) ?? 0,
											}),
										)
									}
								/>
							</Field>
						</div>
						{sources.audio.length > 1 ? (
							<Field
								label={t("vodFlow.audioSource")}
								htmlFor="wz-file-audio-source"
							>
								<SelectNative
									id="wz-file-audio-source"
									value={audio.extras?.source ?? ""}
									onChange={(event) =>
										onPatch(
											editFileAudio(state, { source: event.target.value }),
										)
									}
								>
									{sources.audio.map((option) => (
										<option key={option.value} value={option.value}>
											{option.label}
										</option>
									))}
								</SelectNative>
							</Field>
						) : null}
					</div>
				) : (
					<p className="mt-2 text-xs text-zinc-500">{t("vodFlow.noAudio")}</p>
				)}
			</section>
		</div>
	);
}

function FileEditor({
	index,
	video,
	sharedName,
	removable,
	sourceOptions,
	visionMetadataKeys,
	onEdit,
	onRemove,
}: {
	index: number;
	video: WizardVideoRendition;
	/** Another file writes this name too, into the same folder. */
	sharedName: boolean;
	removable: boolean;
	sourceOptions: { value: string; label: string }[];
	visionMetadataKeys: string[];
	onEdit: (edit: FileEdit) => void;
	onRemove: () => void;
}) {
	const { t } = useT();
	const id = `wz-file-${index}`;
	const n = index + 1;
	const container = fileContainer(video.muxing?.kind);
	const codec = video.codec ?? "H264";
	const codecs = [...new Set([...(container?.video ?? []), codec])];
	const options = codec === "H265" ? video.h265 : video.h264;
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
						container?.unmeasured ? t("vodFlow.unmeasuredContainer") : undefined
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
				<Field label={t("wizard.codec")} htmlFor={`${id}-codec`}>
					<SelectNative
						id={`${id}-codec`}
						value={codec}
						onChange={(event) =>
							onEdit({ codec: event.target.value as WizardVideoCodec })
						}
					>
						{codecs.map((item) => (
							<option key={item} value={item}>
								{item}
							</option>
						))}
					</SelectNative>
				</Field>
				<Field label={t("wizard.encodingMode")} htmlFor={`${id}-mode`}>
					<SelectNative
						id={`${id}-mode`}
						value={video.encodingMode ?? ""}
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
						<option value="">{t("wizard.default")}</option>
						{ENCODING_MODES.map((mode) => (
							<option key={mode} value={mode}>
								{mode}
							</option>
						))}
					</SelectNative>
				</Field>
				<Field label={t("wizard.heightP")} htmlFor={`${id}-height`}>
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
					hint={
						video.bitrate === null && options?.crf === undefined
							? t("vodFlow.bitrateOrCrf")
							: undefined
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
			{sourceOptions.length > 1 ? (
				<Field label={t("vodFlow.videoSource")} htmlFor={`${id}-source`}>
					<SelectNative
						id={`${id}-source`}
						value={video.extras?.source ?? ""}
						onChange={(event) => onEdit({ source: event.target.value })}
					>
						{sourceOptions.map((option) => (
							<option key={option.value} value={option.value}>
								{option.label}
							</option>
						))}
					</SelectNative>
				</Field>
			) : null}
			{codec === "H265" ? (
				<H265AdvancedEditor
					idBase={`${id}-h265`}
					value={video.h265}
					visionMetadataKeys={visionMetadataKeys}
					onChange={(h265) => onEdit({ h265 })}
				/>
			) : (
				<H264AdvancedEditor
					idBase={`${id}-h264`}
					value={video.h264}
					onChange={(h264) => onEdit({ h264 })}
				/>
			)}
		</fieldset>
	);
}
