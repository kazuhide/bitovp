"use client";
import type { AudioCopyTrack } from "@bitovp/core/audio-file-source";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import {
	isInspectionRunning,
	type StorageInspectionDto,
} from "@/app/storage/inspect-shared";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input, SelectNative } from "@/components/ui/input";
import { apiFetch } from "@/lib/api";
import { useT } from "@/lib/i18n/context";
import {
	defaultWizardAudioFile,
	type WizardAudioFile,
	type WizardInputFile,
} from "./build-plan";

type AudioCopyFile = Extract<WizardAudioFile, { mode: "COPY" }>;
const extension = {
	MP4: "mp4",
	PROGRESSIVE_MOV: "mov",
	PROGRESSIVE_WAV: "wav",
};
function filenameFor(name: string, ext: string) {
	return `${name.replace(/\.[^./]*$/, "") || "audio"}.${ext}`;
}
function TrackPicker({
	file,
	value,
	change,
}: {
	file: WizardInputFile;
	value: AudioCopyFile;
	change: (next: AudioCopyFile) => void;
}) {
	const { t } = useT();
	const [pending, setPending] = useState<string>();
	const key = file.path.replace(/^\/+/, "");
	const canInspect =
		!!file.credentialId &&
		!!file.bucket &&
		!!key &&
		["S3", "GENERIC_S3", "GCS", "GCS_SERVICE_ACCOUNT"].includes(file.kind);
	const create = useMutation({
		mutationFn: () =>
			apiFetch<StorageInspectionDto>("/api/storage-inspections", {
				method: "POST",
				body: JSON.stringify({
					credentialId: file.credentialId,
					bucket: file.bucket,
					objectKey: key,
					verifyAudioCopy: true,
				}),
			}),
		onSuccess: (row) => setPending(row.id),
	});
	const id = pending || value.inspectionId;
	const detail = useQuery({
		queryKey: ["vod-audio-track-inspection", id],
		queryFn: () =>
			apiFetch<StorageInspectionDto>(`/api/storage-inspections/${id}`),
		enabled: !!id,
		retry: false,
		refetchInterval: (q) =>
			q.state.data && isInspectionRunning(q.state.data.status) ? 750 : false,
	});
	const row = detail.data;
	const tracks =
		row?.verifiedCredentialId === file.credentialId && row?.bucket === file.bucket && row.objectKey === key
			? (row.verifiedAudioTracks ?? [])
			: [];
	function pick(track: AudioCopyTrack) {
		if (!id) return;
		const container =
			value.container === "PROGRESSIVE_MOV"
				? value.container
				: track.sourceCodec === "AAC"
					? "MP4"
					: "PROGRESSIVE_WAV";
		change({
			...value,
			...track,
			inspectionId: id,
			container,
			filename: filenameFor(value.filename, extension[container]),
		});
	}
	return (
		<>
			<Button
				variant="secondary"
				size="sm"
				disabled={
					!canInspect ||
					create.isPending ||
					(!!row && isInspectionRunning(row.status))
				}
				onClick={() => {
					change({ ...value, inspectionId: "" });
					setPending(undefined);
					create.mutate();
				}}
			>
				{t("vodFlow.inspectAudio")}
			</Button>
			{!canInspect ? <p>{t("vodFlow.audioNeedsStorage")}</p> : null}
			{row?.status === "ERROR" || detail.isError || create.isError ? (
				<p role="alert">{t("vodFlow.audioInspectionFailed")}</p>
			) : null}
			{row?.status === "FINISHED" && tracks.length === 0 ? (
				<p role="status">{t("vodFlow.audioNoTracks")}</p>
			) : null}
			{tracks.length > 0 ? (
				<Field label={t("vodFlow.audioTrack")} htmlFor="wz-copy-track">
					<SelectNative
						id="wz-copy-track"
						value={value.inspectionId === id ? value.position : ""}
						onChange={(ev) => {
							const track = tracks.find(
								(r) => String(r.position) === ev.target.value,
							);
							if (track) pick(track);
						}}
					>
						<option value="">{t("vodFlow.chooseAudioTrack")}</option>
						{tracks.map((track) => (
							<option key={track.position} value={track.position}>
								{track.position + 1} · {track.sourceCodec}
							</option>
						))}
					</SelectNative>
				</Field>
			) : null}
		</>
	);
}
export function AudioFileEditor({
	value,
	file,
	onChange,
}: {
	value: WizardAudioFile;
	file?: WizardInputFile;
	onChange: (next: WizardAudioFile) => void;
}) {
	const { t } = useT();
	return (
		<div className="grid gap-3">
			<Field label={t("vodFlow.audioFileFormat")} htmlFor="wz-audio-mode">
				<SelectNative
					id="wz-audio-mode"
					value={value.mode}
					onChange={(e) =>
						onChange(
							e.target.value === "PCM"
								? {
										...defaultWizardAudioFile,
										position: value.position,
										filename: filenameFor(value.filename, "wav"),
									}
								: {
										mode: "COPY",
										sourceCodec: "AAC",
										position: 0,
										inspectionId: "",
										container: "MP4",
										filename: filenameFor(value.filename, "mp4"),
									},
						)
					}
				>
					<option value="PCM">{t("vodFlow.convertPcm")}</option>
					<option value="COPY">{t("vodFlow.copyAudio")}</option>
				</SelectNative>
			</Field>
			{value.mode === "PCM" ? (
				<>
					<Field label={t("vodFlow.audioTrack")} htmlFor="wz-pcm-track">
						<Input
							id="wz-pcm-track"
							type="number"
							min="1"
							step="1"
							value={value.position + 1}
							onChange={(e) =>
								onChange({ ...value, position: Number(e.target.value) - 1 })
							}
						/>
					</Field>
					<Field label={t("vodFlow.sampleFormat")} htmlFor="wz-sample-format">
						<SelectNative
							id="wz-sample-format"
							value={value.sampleFormat}
							onChange={(e) =>
								onChange({
									...value,
									sampleFormat: e.target.value as typeof value.sampleFormat,
								})
							}
						>
							{["S16LE", "S24LE", "S32LE"].map((s) => (
								<option key={s}>{s}</option>
							))}
						</SelectNative>
					</Field>
					<Field label={t("vodFlow.audioRate")} htmlFor="wz-pcm-rate">
						<SelectNative
							id="wz-pcm-rate"
							value={value.rate}
							onChange={(e) =>
								onChange({ ...value, rate: Number(e.target.value) })
							}
						>
							{[...new Set([44100, 48000, 96000, value.rate])]
								.sort((a, b) => a - b)
								.map((rate) => (
									<option key={rate}>{rate}</option>
								))}
						</SelectNative>
					</Field>
					<Field label={t("vodFlow.audioChannels")} htmlFor="wz-pcm-channels">
						<SelectNative
							id="wz-pcm-channels"
							value={value.channelLayout}
							onChange={(e) =>
								onChange({
									...value,
									channelLayout: e.target.value === "MONO" ? "MONO" : "STEREO",
								})
							}
						>
							<option>MONO</option>
							<option>STEREO</option>
						</SelectNative>
					</Field>
				</>
			) : (
				<>
					{file ? (
						<TrackPicker
							key={JSON.stringify([
								file.kind,
								file.credentialId,
								file.bucket,
								file.path,
							])}
							file={file}
							value={value}
							change={onChange}
						/>
					) : null}
					<Field
						label={t("vodFlow.audioContainer")}
						htmlFor="wz-audio-container"
					>
						<SelectNative
							id="wz-audio-container"
							value={value.container}
							onChange={(e) => {
								const container = e.target.value as AudioCopyFile["container"];
								onChange({
									...value,
									container,
									filename: filenameFor(value.filename, extension[container]),
								});
							}}
						>
							{(value.sourceCodec === "AAC"
								? (["MP4", "PROGRESSIVE_MOV"] as const)
								: (["PROGRESSIVE_WAV", "PROGRESSIVE_MOV"] as const)
							).map((c) => (
								<option key={c} value={c}>
									{extension[c].toUpperCase()}
								</option>
							))}
						</SelectNative>
					</Field>
				</>
			)}
			<Field label={t("vodFlow.audioFilename")} htmlFor="wz-audio-filename">
				<Input
					id="wz-audio-filename"
					value={value.filename}
					onChange={(e) => onChange({ ...value, filename: e.target.value })}
				/>
			</Field>
		</div>
	);
}
