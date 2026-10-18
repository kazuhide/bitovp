"use client";

import type { CredentialSummaryWire } from "@bitovp/core";
import { RegionSelect } from "@/components/region-select";
import { Button } from "@/components/ui/button";
import { Field, FieldRowAction } from "@/components/ui/field";
import { HelpOverlay } from "@/components/ui/help-overlay";
import { Input, SelectNative } from "@/components/ui/input";
import { type Translator, useT } from "@/lib/i18n/context";
import {
	remapEncodingKeyRefs,
	type WizardConcatenationStream,
	type WizardInputFile,
	type WizardSources,
	type WizardState,
	type WizardStreamSelectionMode,
	type WizardTrimmingStream,
} from "./build-plan";
import { GcsRegionControl, StorageLocation } from "./storage-location";
import {
	blankStream,
	clearStreamReferences,
	convertStreamType,
	flattenStreams,
	type InputFileOption,
	inputFileOptions,
	inputKindForProvider,
	removeStream,
	sourceStreamKeys,
	streamTypeLabel,
	UNIFIED_STREAM_TYPES,
	type UnifiedStream,
	writeStream,
} from "./stream-model";
import {
	Collapsible,
	ResourceKeyInput,
	RowRemoveButton,
} from "./wizard-fields";

/**
 * Sources step (extends Input): the unified "Streams" list (ingest tracks,
 * WebVTT sidecars and Dolby Atmos/Vision/metadata in one place), plus the
 * multi-encoding partition and keyframes. Internal resource keys are hidden —
 * every stream references a declared input file and is referenced elsewhere by
 * a human-readable label. The implicit video/audio pair stays derived from the
 * PRIMARY input object path; the audio object can diverge for separate-A/V.
 */

const SELECTION_MODES: WizardStreamSelectionMode[] = [
	"AUTO",
	"POSITION_ABSOLUTE",
	"VIDEO_RELATIVE",
	"AUDIO_RELATIVE",
];

function EncodingKeySelect({
	id,
	label = "Encoding",
	hint,
	help,
	value,
	encodingKeys,
	onChange,
}: {
	id: string;
	label?: string;
	hint?: string;
	/** #129: click-to-open help, passed through to Field. */
	help?: string;
	value: string | undefined;
	encodingKeys: string[];
	onChange: (next: string | undefined) => void;
}) {
	const { t } = useT();
	return (
		<Field label={label} htmlFor={id} help={help ?? hint}>
			<SelectNative
				id={id}
				value={value ?? ""}
				onChange={(e) => onChange(e.target.value || undefined)}
			>
				{/* Partitioned plans must assign every resource — the preview
				    flags unassigned refs as PLAN_UNRESOLVED_REF. */}
				<option value="">{t("wizard.unassigned")}</option>
				{encodingKeys.map((key) => (
					<option key={key} value={key}>
						{key}
					</option>
				))}
			</SelectNative>
		</Field>
	);
}

/** Picks the input stream a trimming/concatenation source wraps (by key). */
function SourceKeySelect({
	id,
	label = "Source stream",
	hint,
	help,
	value,
	sourceKeys,
	onChange,
}: {
	id: string;
	label?: string;
	hint?: string;
	help?: string;
	value: string;
	sourceKeys: string[];
	onChange: (next: string) => void;
}) {
	const { t } = useT();
	const known = value === "" || sourceKeys.includes(value);
	return (
		<Field label={label} htmlFor={id} help={help ?? hint}>
			<SelectNative
				id={id}
				value={value}
				onChange={(e) => onChange(e.target.value)}
			>
				<option value="">{t("wizard.selectSourceStream")}</option>
				{sourceKeys.map((key) => (
					<option key={key} value={key}>
						{key}
					</option>
				))}
				{known ? null : (
					<option value={value}>
						{value} {t("wizardX.missingParen")}
					</option>
				)}
			</SelectNative>
		</Field>
	);
}

/**
 * The one non-credential source. A UUID can never equal it, so it cannot
 * collide with a credential id in the same select.
 */
const HTTPS_SOURCE = "__https__";

/** Whether an input kind's location can be browsed via the StoragePicker. */
function inputKindIsBrowsable(kind: WizardInputFile["kind"]): boolean {
	return kind !== "AZURE" && kind !== "HTTPS";
}

/** Next free `<prefix>N` key across the whole shared input-stream namespace. */
function nextSharedKey(sources: WizardSources, prefix: string): string {
	const taken = new Set<string>([
		...(sources.tracks ?? []).map((t) => t.key),
		...(sources.fileStreams ?? []).map((s) => s.key),
		...(sources.dolbyStreams ?? []).map((s) => s.key),
		...(sources.trimmingStreams ?? []).map((s) => s.key),
		...(sources.audioMixStreams ?? []).map((s) => s.key),
		...(sources.concatenationStreams ?? []).map((s) => s.key),
	]);
	let n = 1;
	while (taken.has(`${prefix}${n}`)) {
		n += 1;
	}
	return `${prefix}${n}`;
}

/** "Bucket" / "Container" / "Host" depending on the input storage kind. */
function inputLocationLabel(kind: WizardInputFile["kind"], t: Translator) {
	return kind === "AZURE"
		? t("wizard.container")
		: kind === "HTTPS"
			? t("wizard.host")
			: t("wizard.bucket");
}

/**
 * "Input files" editor — the single home for every source object. Each row is
 * one complete input: its own storage kind, credential, bucket and object path
 * (no separately-chosen "primary credential" up front). The first row is the
 * required primary video source; the rest are optional (a separate audio
 * master, Dolby sidecars, subtitles). A Stream below merely references a file;
 * its object path is the file's, never re-entered. Resource names are
 * tool-assigned and hidden. Removing a non-primary file leaves any referencing
 * stream flagged "(missing input)" rather than silently retargeting it.
 */
export function InputFilesEditor({
	state,
	credentials,
	onPatch,
	onBrowse,
}: {
	state: WizardState;
	credentials: CredentialSummaryWire[];
	onPatch: (partial: Partial<WizardState>) => void;
	onBrowse: (index: number) => void;
}) {
	const { t } = useT();
	const files = state.inputFiles;
	const patchFile = (i: number, partial: Partial<WizardInputFile>) => {
		const current = files[i];
		if (!current) {
			return;
		}
		const next = [...files];
		next[i] = { ...current, ...partial };
		onPatch({ inputFiles: next });
	};
	// Provider changes with the kind, so drop the now-mismatched credential.
	/**
	 * One selection, decoded into kind + credential.
	 *
	 * The sentinel is not a credential id and cannot collide with one: ids are
	 * UUIDs. Choosing HTTPS clears the credential, and choosing a credential
	 * derives the kind — the two used to be set independently, which is how a
	 * kind could disagree with the credential beneath it.
	 */
	const selectSource = (i: number, value: string) => {
		// The placeholder ("Select credential…") FIRST. review-147 found this:
		// the `kind === null` guard below, written for unmapped providers,
		// swallowed the empty value too — so an operator who picked the wrong
		// credential had no way back to "none chosen". The select snapped
		// straight back to the previous pick, silently.
		if (value === "") {
			patchFile(i, { credentialId: "" });
			return;
		}
		if (value === HTTPS_SOURCE) {
			patchFile(i, { kind: "HTTPS", credentialId: "", bucket: "", path: "" });
			return;
		}
		const provider = credentials.find((c) => c.id === value)?.provider;
		const kind = inputKindForProvider(provider);
		if (kind === null) {
			// Ignore rather than collapse an unmapped provider to S3 — the
			// output step's long-standing rule. It WARNS where this used to
			// return silently (review-147 caught the asymmetry): unreachable
			// through the UI is not the same as unobservable when it happens.
			console.warn(
				`[vod-wizard] Unsupported input provider "${provider}" is not selectable as a source; ignoring selection.`,
			);
			return;
		}
		patchFile(i, { kind, credentialId: value });
		// Owner request 2026-09-06: the output step opens its prefix picker the
		// moment a browsable credential is chosen, and the source step asked for
		// an extra "browse storage" click for the same thing. Same reflex here.
		if (inputKindIsBrowsable(kind)) {
			onBrowse(i);
		}
	};
	const freshKey = () => {
		const taken = new Set(files.map((f) => f.key));
		let n = 2;
		while (taken.has(`in${n}`)) {
			n += 1;
		}
		return `in${n}`;
	};

	return (
		<section aria-label={t("wizard.inputFiles")} className="space-y-3">
			<div className="flex items-center gap-1.5">
				<h2 className="font-medium text-sm text-zinc-200">
					{t("wizardX.inputFilesCount", { count: files.length })}
				</h2>
				<HelpOverlay
					label={t("uiX.moreInformationFor", {
						label: t("wizard.inputFiles"),
					})}
				>
					{t("ui.eachInputFileIsOneObjectThe")}
				</HelpOverlay>
			</div>
			{files.map((file, index) => {
				const kind = file.kind ?? "S3";
				return (
					<div
						key={file.key}
						className="space-y-3 rounded-md border border-zinc-800 p-3"
					>
						<div className="flex items-center justify-between">
							<span className="font-medium text-xs text-zinc-400">
								{index === 0
									? t("wizard.inputFile1PrimaryRequired")
									: t("wizardX.inputFileN", { n: index + 1 })}
							</span>
							{index > 0 ? (
								<RowRemoveButton
									label={t("wizardX.removeInputFileN", { n: index + 1 })}
									onClick={() =>
										onPatch({
											inputFiles: files.filter((_, i) => i !== index),
										})
									}
								/>
							) : null}
						</div>
						<StorageLocation
							idBase={`wz-in-${index}`}
							credentials={credentials}
							/*
							 * One control, not two (owner, 2026-08-20). The storage
							 * KIND used to be picked first and then narrowed this
							 * list — but the dependency runs one way: a credential
							 * always determines its kind, while a kind does not
							 * determine a credential (`GENERIC_S3` covers Akamai, OCI
							 * and plain S3-compatible). So the first question asked
							 * for strictly less than the second and had to be
							 * answered again. The OUTPUT step already worked this way
							 * — `selectOutputCredential` derives the kind — so the
							 * source step was the odd one out.
							 */
							selectable={(provider) => inputKindForProvider(provider) !== null}
							browsable={inputKindIsBrowsable(kind)}
							browseOwnsCredential
							alwaysShowCredential
							extraOptions={[
								{ value: HTTPS_SOURCE, label: t("wizard.httpsAuthFree") },
							]}
							credentialId={kind === "HTTPS" ? HTTPS_SOURCE : file.credentialId}
							bucket={file.bucket}
							bucketLabel={inputLocationLabel(kind, t)}
							path={file.path}
							pathLabel={t("uiX.objectPath")}
							pathPlaceholder={
								index === 0 ? "videos/source.mp4" : "metadata/dolbyvision.xml"
							}
							pathHint={
								index === 0
									? undefined
									: t("wizard.theObjectAStreamReadsWhenIt")
							}
							onCredentialChange={(id) => selectSource(index, id)}
							onChange={(p) => patchFile(index, p)}
							onBrowse={() => onBrowse(index)}
						/>
						<GcsRegionControl
							idBase={`wz-file-${index}`}
							kind={kind}
							value={file.region}
							onChange={(region) =>
								onPatch({
									inputFiles: files.map((entry) =>
										entry.inputKey === file.inputKey
											? { ...entry, region }
											: entry,
									),
								})
							}
						/>
					</div>
				);
			})}
			<Button
				variant="secondary"
				size="sm"
				onClick={() => {
					const key = freshKey();
					onPatch({
						inputFiles: [
							...files,
							{
								key,
								inputKey: key,
								kind: "S3",
								credentialId: "",
								bucket: "",
								path: "",
							},
						],
					});
				}}
			>
				{t("wizard.addInputFile")}
			</Button>
		</section>
	);
}

/**
 * One row of the unified Streams list. The internal resource key is hidden; the
 * row picks a type and an input file (object) — the object path lives on the
 * file, never re-entered here. Type-specific controls (Atmos format, Vision
 * metadata file, ingest selection mode/position) live in an Advanced area.
 */
function StreamRow({
	row,
	idBase,
	inputFiles,
	encodingKeys,
	onChange,
	onConvert,
	onRemove,
}: {
	row: UnifiedStream;
	idBase: string;
	inputFiles: InputFileOption[];
	encodingKeys: string[];
	onChange: (next: UnifiedStream) => void;
	onConvert: (type: UnifiedStream["type"]) => void;
	onRemove: () => void;
}) {
	const { t } = useT();
	const fileSelect = (
		id: string,
		value: string | undefined,
		label: string,
		hint: string | undefined,
		onPick: (next: string | undefined) => void,
	) => {
		const known =
			value === undefined || inputFiles.some((f) => f.key === value);
		return (
			<Field label={label} htmlFor={id} help={hint}>
				<SelectNative
					id={id}
					value={value ?? ""}
					onChange={(e) => onPick(e.target.value || undefined)}
				>
					<option value="">{t("wizard.selectInputFile")}</option>
					{inputFiles.map((f) => (
						<option key={f.key} value={f.key}>
							{f.label}
						</option>
					))}
					{known ? null : (
						<option value={value}>
							{value} {t("wizardX.missingInputParen")}
						</option>
					)}
				</SelectNative>
			</Field>
		);
	};

	return (
		<div className="space-y-3 rounded-md border border-zinc-800 p-3">
			<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
				<Field label={t("wizard.type")} htmlFor={`${idBase}-type`}>
					<SelectNative
						id={`${idBase}-type`}
						value={row.type}
						onChange={(e) => onConvert(e.target.value as UnifiedStream["type"])}
					>
						{UNIFIED_STREAM_TYPES.map((type) => (
							<option key={type} value={type}>
								{streamTypeLabel(type)}
							</option>
						))}
					</SelectNative>
				</Field>
				{fileSelect(
					`${idBase}-input`,
					row.inputFile,
					t("wizard.inputFile"),
					t("wizard.theObjectDeclaredInInputFilesThis"),
					(next) => onChange({ ...row, inputFile: next ?? "" }),
				)}
			</div>

			{row.type === "VISION"
				? fileSelect(
						`${idBase}-meta`,
						row.metadataInputFile,
						t("wizard.metadataInputFileOptional"),
						t("wizard.separateDolbyVisionMetadataSidecarEmptyEmbed"),
						(next) => onChange({ ...row, metadataInputFile: next }),
					)
				: null}

			<Collapsible summary={t("wizard.advanced")}>
				{row.type === "ATMOS" ? (
					<Field label={t("wizard.inputFormat")} htmlFor={`${idBase}-fmt`}>
						<SelectNative
							id={`${idBase}-fmt`}
							value={row.inputFormat ?? "DAMF"}
							onChange={(e) =>
								onChange({
									...row,
									inputFormat: e.target.value as "DAMF" | "ADM" | "MXF",
								})
							}
						>
							<option value="DAMF">DAMF</option>
							<option value="ADM">ADM</option>
							<option value="MXF">MXF</option>
						</SelectNative>
					</Field>
				) : null}
				{row.type === "INGEST" ? (
					<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
						<Field label={t("wizard.selectionMode")} htmlFor={`${idBase}-mode`}>
							<SelectNative
								id={`${idBase}-mode`}
								value={row.selectionMode ?? "AUTO"}
								onChange={(e) =>
									onChange({
										...row,
										selectionMode: e.target.value as WizardStreamSelectionMode,
									})
								}
							>
								{SELECTION_MODES.map((mode) => (
									<option key={mode} value={mode}>
										{mode}
									</option>
								))}
							</SelectNative>
						</Field>
						<Field label={t("wizard.position")} htmlFor={`${idBase}-pos`}>
							<Input
								id={`${idBase}-pos`}
								type="number"
								value={row.position ?? 0}
								onChange={(e) =>
									onChange({
										...row,
										position: Math.max(
											0,
											Math.round(Number(e.target.value) || 0),
										),
									})
								}
							/>
						</Field>
					</div>
				) : null}
				{encodingKeys.length > 0 ? (
					<EncodingKeySelect
						id={`${idBase}-enc`}
						value={row.encodingKey}
						encodingKeys={encodingKeys}
						onChange={(encodingKey) => onChange({ ...row, encodingKey })}
					/>
				) : null}
				{row.type !== "INGEST" && row.type !== "ATMOS" ? (
					<p className="text-xs text-zinc-600">
						{t("wizardX.noExtraOptionsFor", {
							label: streamTypeLabel(row.type),
						})}
					</p>
				) : null}
			</Collapsible>

			<RowRemoveButton
				label={t("wizardX.removeStreamKey", { key: idBase })}
				onClick={onRemove}
			/>
		</div>
	);
}

type SourcesSectionProps = {
	state: WizardState;
	onPatch: (partial: Partial<WizardState>) => void;
};

export function SourcesSection({ state, onPatch }: SourcesSectionProps) {
	const { t } = useT();
	const sources = state.sources ?? {};
	const encodings = sources.encodings ?? [];
	const keyframes = sources.keyframes ?? [];
	const encodingKeys = encodings.map((e) => e.key);
	let encodingNumber = 1;
	while (encodingKeys.includes(`enc${encodingNumber}`)) encodingNumber += 1;
	const inputFiles = inputFileOptions(state);
	const streams = flattenStreams(sources);
	const usesImplicitAudio = state.audios.some(
		(a) => (a.extras?.source ?? "") === "",
	);
	const patchSources = (next: WizardSources) => onPatch({ sources: next });
	const renameStream = (from: string, to: string, next: WizardSources) => {
		const keys = [
			...flattenStreams(sources).map((row) => row.key),
			...(sources.trimmingStreams ?? []).map((row) => row.key),
			...(sources.audioMixStreams ?? []).map((s) => s.key),
			...(sources.concatenationStreams ?? []).map((row) => row.key),
			"video",
			"audio",
		];
		if (
			!from ||
			!to ||
			keys.filter((key) => key === from).length !== 1 ||
			keys.includes(to)
		) {
			patchSources(next);
			return;
		}
		const mapRendition = <T extends { extras?: { source?: string } }>(
			row: T,
		): T =>
			row.extras?.source === from
				? { ...row, extras: { ...row.extras, source: to } }
				: row;
		onPatch({
			videos: state.videos.map(mapRendition),
			audios: state.audios.map(mapRendition),
			sources: {
				...next,
				audioMixStreams: next.audioMixStreams?.map((mix) => ({
					...mix,
					audioMixChannels: mix.audioMixChannels.map((c) =>
						c.sourceKey === from ? { ...c, sourceKey: to } : c,
					),
				})),
				trimmingStreams: next.trimmingStreams?.map((row) =>
					row.sourceKey === from ? { ...row, sourceKey: to } : row,
				),
				concatenationStreams: next.concatenationStreams?.map((row) => ({
					...row,
					sources: row.sources.map((source) =>
						source.sourceKey === from ? { ...source, sourceKey: to } : source,
					),
				})),
			},
		});
	};

	// Editing the partition cascades through every encodingKey ref so the
	// plan never strands PLAN_UNRESOLVED_REF errors on stale keys. Renames
	// only follow unambiguous keys (no duplicate rows holding the same one).
	const cascades = (from: string, to: string | undefined) =>
		from !== "" && encodings.filter((row) => row.key === from).length === 1
			? remapEncodingKeyRefs(state, from, to)
			: {};
	const renameEncoding = (index: number, key: string) => {
		const current = encodings[index];
		if (!current) {
			return;
		}
		const cascade = cascades(current.key, key || undefined);
		const next = [...encodings];
		next[index] = { ...current, key };
		onPatch({
			...cascade,
			sources: { ...(cascade.sources ?? sources), encodings: next },
		});
	};
	const removeEncoding = (index: number) => {
		const current = encodings[index];
		if (!current) {
			return;
		}
		const cascade = cascades(current.key, undefined);
		onPatch({
			...cascade,
			sources: {
				...(cascade.sources ?? sources),
				encodings: encodings.filter((_, i) => i !== index),
			},
		});
	};

	return (
		<div className="space-y-4">
			<Collapsible
				summary={t("wizardX.streamsCount", { count: streams.length })}
				help={t("ui.everySourceBeyondTheImplicitVideoAudio")}
			>
				{usesImplicitAudio ? (
					<div className="space-y-1 rounded-md border border-zinc-800 bg-zinc-900/40 p-3">
						<p className="text-xs text-zinc-400">
							{t("wizard.implicitAudioReadsTheSameObjectAs")}
						</p>
						<Field
							label={t("wizard.audioInputFile")}
							htmlFor="wz-implicit-audio"
							help={t("wizard.sameObjectAsTheVideoUnlessChanged")}
						>
							<SelectNative
								id="wz-implicit-audio"
								value={state.audioInputFile ?? ""}
								onChange={(e) => {
									const v = e.target.value;
									onPatch({
										audioInputFile:
											v && v !== inputFiles[0]?.key ? v : undefined,
									});
								}}
							>
								<option value="">{t("wizard.sameObjectAsTheVideo")}</option>
								{state.audioInputFile &&
								!inputFiles.some(
									(file) => file.key === state.audioInputFile,
								) ? (
									<option value={state.audioInputFile}>
										{state.audioInputFile} {t("wizardX.missingParen")}
									</option>
								) : null}
								{inputFiles.map((f) => (
									<option key={f.key} value={f.key}>
										{f.label}
									</option>
								))}
							</SelectNative>
						</Field>
					</div>
				) : null}

				{streams.map((row) => {
					const idBase = `wz-stream-${row.origin}-${row.index}`;
					return (
						<StreamRow
							// The React key intentionally carries row.key so the row
							// REMOUNTS on a type-convert (origin/key change) — that reinits
							// StreamRow's local editPath from the new row and dodges the
							// stale-toggle failure mode (cf. the PR-A summary bug).
							key={`${row.origin}:${row.index}:${row.key}`}
							row={row}
							idBase={idBase}
							inputFiles={inputFiles}
							encodingKeys={encodingKeys}
							onChange={(next) => patchSources(writeStream(sources, next))}
							onConvert={(type) => {
								const nextSources = convertStreamType(sources, row, type);
								// Converting to WEBVTT moves the stream out of the video/audio
								// source list; revert any rendition that read from it to the
								// implicit track rather than stranding a dangling source ref.
								if (
									(type === "WEBVTT" || type === "TTML") &&
									row.type !== type
								) {
									onPatch({
										...clearStreamReferences(state, row.key),
										sources: nextSources,
									});
								} else {
									patchSources(nextSources);
								}
							}}
							onRemove={() => patchSources(removeStream(sources, row))}
						/>
					);
				})}

				<div className="flex flex-wrap items-center gap-2">
					<Button
						variant="secondary"
						size="sm"
						onClick={() =>
							patchSources(
								blankStream(sources, "INGEST", state.inputFiles[0]?.key),
							)
						}
					>
						{t("wizard.addIngestTrack")}
					</Button>
					<Button
						variant="secondary"
						size="sm"
						onClick={() =>
							patchSources(
								blankStream(sources, "WEBVTT", state.inputFiles[0]?.key),
							)
						}
					>
						{t("wizard.addWebvttSubtitle")}
					</Button>
					<Button
						variant="secondary"
						size="sm"
						onClick={() =>
							patchSources(
								blankStream(sources, "ATMOS", state.inputFiles[0]?.key),
							)
						}
					>
						{t("wizard.addDolbyStream")}
					</Button>
				</div>
			</Collapsible>

			<Collapsible
				summary={t("wizardX.multiEncodingPartitionCount", {
					count: encodings.length,
				})}
				help={t("wizard.dolbyDvHdr10SdrLaddersRunAs")}
			>
				{encodings.map((encoding, index) => (
					<div key={index} className="flex flex-wrap items-start gap-2">
						<Field label={t("wizard.key")} htmlFor={`wz-enc-${index}-key`}>
							<Input
								id={`wz-enc-${index}-key`}
								className="w-28"
								value={encoding.key}
								onChange={(e) => renameEncoding(index, e.target.value)}
							/>
						</Field>
						<Field
							label={t("wizard.cloudRegion")}
							htmlFor={`wz-enc-${index}-region`}
						>
							<RegionSelect
								id={`wz-enc-${index}-region`}
								className="w-44"
								emptyLabel={t("wizard.planDefault")}
								value={encoding.cloudRegion ?? ""}
								onChange={(region) => {
									const next = [...encodings];
									next[index] = {
										...encoding,
										cloudRegion: region || undefined,
									};
									patchSources({ ...sources, encodings: next });
								}}
							/>
						</Field>
						<FieldRowAction>
							<RowRemoveButton
								label={t("wizardX.removeEncodingN", { n: index + 1 })}
								onClick={() => removeEncoding(index)}
							/>
						</FieldRowAction>
					</div>
				))}
				<Button
					variant="secondary"
					size="sm"
					onClick={() =>
						patchSources({
							...sources,
							encodings: [
								...encodings,
								{
									key: `enc${encodingNumber}`,
									name: state.name
										? `${state.name}-enc${encodingNumber}`
										: `encoding-${encodingNumber}`,
								},
							],
						})
					}
				>
					{t("wizard.addEncoding")}
				</Button>
				{encodingKeys.length > 0 ? (
					<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
						<EncodingKeySelect
							id="wz-imp-video-enc"
							label={t("wizard.implicitVideoTrackEncoding")}
							help={t("wizard.appliesWhileARenditionUsesTheImplicit")}
							value={sources.implicitEncodingKeys?.video}
							encodingKeys={encodingKeys}
							onChange={(video) =>
								patchSources({
									...sources,
									implicitEncodingKeys: {
										...sources.implicitEncodingKeys,
										video,
									},
								})
							}
						/>
						<EncodingKeySelect
							id="wz-imp-audio-enc"
							label={t("wizard.implicitAudioTrackEncoding")}
							help={t("wizard.appliesWhileARenditionUsesTheImplicit2")}
							value={sources.implicitEncodingKeys?.audio}
							encodingKeys={encodingKeys}
							onChange={(audio) =>
								patchSources({
									...sources,
									implicitEncodingKeys: {
										...sources.implicitEncodingKeys,
										audio,
									},
								})
							}
						/>
					</div>
				) : null}
			</Collapsible>

			<Collapsible
				summary={t("wizardX.keyframesAdCuesCount", { count: keyframes.length })}
				help={t("wizard.encodingLevelKeyframesCutSegmentsAtAd")}
			>
				{keyframes.map((keyframe, index) => (
					<div key={index} className="flex flex-wrap items-start gap-2">
						<Field label={t("wizard.key")} htmlFor={`wz-kf-${index}-key`}>
							<Input
								id={`wz-kf-${index}-key`}
								className="w-28"
								value={keyframe.key}
								onChange={(e) => {
									const next = [...keyframes];
									next[index] = { ...keyframe, key: e.target.value };
									patchSources({ ...sources, keyframes: next });
								}}
							/>
						</Field>
						<Field label={t("wizard.timeS")} htmlFor={`wz-kf-${index}-time`}>
							<Input
								id={`wz-kf-${index}-time`}
								className="w-28"
								type="number"
								step="any"
								value={keyframe.time}
								onChange={(e) => {
									const next = [...keyframes];
									next[index] = {
										...keyframe,
										time: Math.max(0, Number(e.target.value) || 0),
									};
									patchSources({ ...sources, keyframes: next });
								}}
							/>
						</Field>
						{encodingKeys.length > 0 ? (
							<EncodingKeySelect
								id={`wz-kf-${index}-enc`}
								value={keyframe.encodingKey}
								encodingKeys={encodingKeys}
								onChange={(encodingKey) => {
									const next = [...keyframes];
									next[index] = { ...keyframe, encodingKey };
									patchSources({ ...sources, keyframes: next });
								}}
							/>
						) : null}
						<FieldRowAction>
							<RowRemoveButton
								label={t("wizardX.removeKeyframeN", { n: index + 1 })}
								onClick={() =>
									patchSources({
										...sources,
										keyframes: keyframes.filter((_, i) => i !== index),
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
						patchSources({
							...sources,
							keyframes: [
								...keyframes,
								{ key: `ad${keyframes.length + 1}`, time: 0 },
							],
						})
					}
				>
					{t("wizard.addKeyframe")}
				</Button>
			</Collapsible>

			<TrimmingStreamsSection
				state={state}
				sources={sources}
				encodingKeys={encodingKeys}
				patchSources={patchSources}
				onRename={renameStream}
			/>

			<ConcatenationStreamsSection
				state={state}
				sources={sources}
				encodingKeys={encodingKeys}
				patchSources={patchSources}
				onRename={renameStream}
			/>
		</div>
	);
}

/**
 * Trimming input streams (the modern path): each wraps a declared input stream
 * (its source) and a rendition references the trim by key under Placement &
 * extras. Three kinds — time-based (offset/duration in seconds), timecode-track
 * (SMPTE-12M), and H264 picture timing (SEI strings).
 */
function TrimmingStreamsSection({
	state,
	sources,
	encodingKeys,
	patchSources,
	onRename,
}: {
	state: WizardState;
	sources: WizardSources;
	encodingKeys: string[];
	patchSources: (next: WizardSources) => void;
	onRename: (from: string, to: string, sources: WizardSources) => void;
}) {
	const { t } = useT();
	const trims = sources.trimmingStreams ?? [];
	const patchTrim = (index: number, next: WizardTrimmingStream) => {
		const list = [...trims];
		list[index] = next;
		if (next.key !== trims[index]?.key)
			onRename(trims[index]?.key ?? "", next.key, {
				...sources,
				trimmingStreams: list,
			});
		else patchSources({ ...sources, trimmingStreams: list });
	};
	return (
		<Collapsible
			summary={t("wizardX.trimmingStreamsCount", { count: trims.length })}
			help={t("ui.trimASourceInputStreamToA")}
		>
			{trims.map((trim, index) => {
				const idBase = `wz-trim-${index}`;
				const sourceKeys = sourceStreamKeys(state, {
					includeTrimming: true,
					excludeKey: trim.key,
				});
				return (
					<div
						key={index}
						className="space-y-3 rounded-md border border-zinc-800 p-3"
					>
						<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
							<Field label={t("wizard.key")} htmlFor={`${idBase}-key`}>
								<ResourceKeyInput
									id={`${idBase}-key`}
									value={trim.key}
									onCommit={(key) => patchTrim(index, { ...trim, key })}
								/>
							</Field>
							<Field label={t("wizard.kind")} htmlFor={`${idBase}-kind`}>
								<SelectNative
									id={`${idBase}-kind`}
									value={trim.kind}
									onChange={(e) => {
										const kind = e.target.value as WizardTrimmingStream["kind"];
										// Reshape to the new kind, keeping shared key/source/encoding.
										patchTrim(index, {
											kind,
											key: trim.key,
											sourceKey: trim.sourceKey,
											encodingKey: trim.encodingKey,
										} as WizardTrimmingStream);
									}}
								>
									<option value="TIME_BASED">
										{t("wizard.timeBasedSeconds")}
									</option>
									<option value="TIMECODE_TRACK">
										{t("wizard.timecodeTrackSmpte12m")}
									</option>
									<option value="H264_PICTURE_TIMING">
										{t("wizard.h264PictureTiming")}
									</option>
								</SelectNative>
							</Field>
						</div>
						<SourceKeySelect
							id={`${idBase}-src`}
							help={t("wizard.theInputStreamThisTrimWraps")}
							value={trim.sourceKey}
							sourceKeys={sourceKeys}
							onChange={(sourceKey) => patchTrim(index, { ...trim, sourceKey })}
						/>
						{trim.kind === "TIME_BASED" ? (
							<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
								<Field label={t("wizard.offsetS")} htmlFor={`${idBase}-offset`}>
									<Input
										id={`${idBase}-offset`}
										type="number"
										step="any"
										value={trim.offset ?? ""}
										onChange={(e) =>
											patchTrim(index, {
												...trim,
												offset:
													e.target.value === ""
														? undefined
														: Math.max(0, Number(e.target.value) || 0),
											})
										}
									/>
								</Field>
								<Field label={t("wizard.durationS")} htmlFor={`${idBase}-dur`}>
									<Input
										id={`${idBase}-dur`}
										type="number"
										step="any"
										value={trim.duration ?? ""}
										onChange={(e) =>
											patchTrim(index, {
												...trim,
												duration:
													e.target.value === ""
														? undefined
														: Math.max(0, Number(e.target.value) || 0),
											})
										}
									/>
								</Field>
							</div>
						) : trim.kind === "TIMECODE_TRACK" ? (
							<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
								<Field
									label={t("wizard.startTimecode")}
									htmlFor={`${idBase}-stc`}
								>
									<Input
										id={`${idBase}-stc`}
										placeholder="00:00:10:00"
										value={trim.startTimeCode ?? ""}
										onChange={(e) =>
											patchTrim(index, {
												...trim,
												startTimeCode: e.target.value || undefined,
											})
										}
									/>
								</Field>
								<Field
									label={t("wizard.endTimecode")}
									htmlFor={`${idBase}-etc`}
								>
									<Input
										id={`${idBase}-etc`}
										placeholder="00:00:40:00"
										value={trim.endTimeCode ?? ""}
										onChange={(e) =>
											patchTrim(index, {
												...trim,
												endTimeCode: e.target.value || undefined,
											})
										}
									/>
								</Field>
							</div>
						) : (
							<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
								<Field
									label={t("wizard.startPictureTiming")}
									htmlFor={`${idBase}-spt`}
								>
									<Input
										id={`${idBase}-spt`}
										value={trim.startPicTiming ?? ""}
										onChange={(e) =>
											patchTrim(index, {
												...trim,
												startPicTiming: e.target.value || undefined,
											})
										}
									/>
								</Field>
								<Field
									label={t("wizard.endPictureTiming")}
									htmlFor={`${idBase}-ept`}
								>
									<Input
										id={`${idBase}-ept`}
										value={trim.endPicTiming ?? ""}
										onChange={(e) =>
											patchTrim(index, {
												...trim,
												endPicTiming: e.target.value || undefined,
											})
										}
									/>
								</Field>
							</div>
						)}
						{encodingKeys.length > 0 ? (
							<EncodingKeySelect
								id={`${idBase}-enc`}
								value={trim.encodingKey}
								encodingKeys={encodingKeys}
								onChange={(encodingKey) =>
									patchTrim(index, { ...trim, encodingKey })
								}
							/>
						) : null}
						<RowRemoveButton
							label={t("wizardX.removeTrimmingStreamN", { n: index + 1 })}
							onClick={() =>
								patchSources({
									...sources,
									trimmingStreams: trims.filter((_, i) => i !== index),
								})
							}
						/>
					</div>
				);
			})}
			<Button
				variant="secondary"
				size="sm"
				onClick={() =>
					patchSources({
						...sources,
						trimmingStreams: [
							...trims,
							{
								kind: "TIME_BASED",
								key: nextSharedKey(sources, "trim"),
								sourceKey: state.videos.length > 0 ? "video" : "",
							},
						],
					})
				}
			>
				{t("wizard.addTrim")}
			</Button>
		</Collapsible>
	);
}

/**
 * Concatenation input streams: stitch an ordered list of source input streams
 * into one stream a rendition reads. Exactly one source must be the main
 * (reference for scaling/FPS/aspect); padding and aspect-mode live under
 * Advanced.
 */
function ConcatenationStreamsSection({
	state,
	sources,
	encodingKeys,
	patchSources,
	onRename,
}: {
	state: WizardState;
	sources: WizardSources;
	encodingKeys: string[];
	patchSources: (next: WizardSources) => void;
	onRename: (from: string, to: string, sources: WizardSources) => void;
}) {
	const { t } = useT();
	const concats = sources.concatenationStreams ?? [];
	const patchConcat = (index: number, next: WizardConcatenationStream) => {
		const list = [...concats];
		list[index] = next;
		if (next.key !== concats[index]?.key)
			onRename(concats[index]?.key ?? "", next.key, {
				...sources,
				concatenationStreams: list,
			});
		else patchSources({ ...sources, concatenationStreams: list });
	};
	return (
		<Collapsible
			summary={t("wizardX.concatenationStreamsCount", {
				count: concats.length,
			})}
			help={t("ui.stitchOrderedSourceInputStreamsIntoOne")}
		>
			{concats.map((concat, index) => {
				const idBase = `wz-concat-${index}`;
				const sourceKeys = sourceStreamKeys(state, {
					includeTrimming: true,
					excludeKey: concat.key,
				});
				const patchSource = (
					sIndex: number,
					next: WizardConcatenationStream["sources"][number],
				) => {
					const list = [...concat.sources];
					list[sIndex] = next;
					patchConcat(index, { ...concat, sources: list });
				};
				return (
					<div
						key={index}
						className="space-y-3 rounded-md border border-zinc-800 p-3"
					>
						<Field label={t("wizard.key")} htmlFor={`${idBase}-key`}>
							<ResourceKeyInput
								id={`${idBase}-key`}
								className="w-40"
								value={concat.key}
								onCommit={(key) => patchConcat(index, { ...concat, key })}
							/>
						</Field>
						{concat.sources.map((source, sIndex) => (
							<div
								// Source rows are positional; index key is stable enough here.
								key={sIndex}
								className="space-y-2 rounded-md border border-zinc-800/70 bg-zinc-900/40 p-2"
							>
								<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
									<SourceKeySelect
										id={`${idBase}-src-${sIndex}`}
										label={t("wizardX.sourceN", { n: sIndex + 1 })}
										value={source.sourceKey}
										sourceKeys={sourceKeys}
										onChange={(sourceKey) =>
											patchSource(sIndex, { ...source, sourceKey })
										}
									/>
									<Field
										label={t("wizard.position")}
										htmlFor={`${idBase}-pos-${sIndex}`}
									>
										<Input
											id={`${idBase}-pos-${sIndex}`}
											type="number"
											value={source.position ?? sIndex}
											onChange={(e) =>
												patchSource(sIndex, {
													...source,
													position: Math.round(Number(e.target.value) || 0),
												})
											}
										/>
									</Field>
								</div>
								<label
									className="flex items-center gap-2 text-xs text-zinc-300"
									htmlFor={`${idBase}-main-${sIndex}`}
								>
									<input
										id={`${idBase}-main-${sIndex}`}
										type="checkbox"
										checked={source.isMain ?? false}
										onChange={(e) => {
											// Exactly one main: checking this source makes it the sole
											// main; unchecking it leaves none main.
											const checked = e.target.checked;
											const list = concat.sources.map((s, i) => ({
												...s,
												isMain: i === sIndex ? checked : false,
											}));
											patchConcat(index, { ...concat, sources: list });
										}}
									/>
									{t("wizard.mainReferenceStream")}
								</label>
								<Collapsible summary={t("wizard.advancedPaddingAspect")}>
									<Field
										label={t("wizard.aspectMode")}
										htmlFor={`${idBase}-aspect-${sIndex}`}
									>
										<SelectNative
											id={`${idBase}-aspect-${sIndex}`}
											value={source.aspectMode ?? ""}
											onChange={(e) =>
												patchSource(sIndex, {
													...source,
													aspectMode:
														(e.target.value as
															| "PAD"
															| "CROP"
															| "STRETCH"
															| "") || undefined,
												})
											}
										>
											<option value="">{t("wizard.default")}</option>
											<option value="PAD">PAD</option>
											<option value="CROP">CROP</option>
											<option value="STRETCH">STRETCH</option>
										</SelectNative>
									</Field>
									<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
										<Field
											label={t("wizard.paddingBeforeS")}
											htmlFor={`${idBase}-padb-${sIndex}`}
										>
											<div className="flex gap-2">
												<Input
													id={`${idBase}-padb-${sIndex}`}
													type="number"
													step="any"
													className="flex-1"
													value={source.paddingBefore?.duration ?? ""}
													onChange={(e) =>
														patchSource(sIndex, {
															...source,
															paddingBefore:
																e.target.value === ""
																	? undefined
																	: {
																			duration: Math.max(
																				0,
																				Number(e.target.value) || 0,
																			),
																			/*
																			 * Preserve, don't reset — this used
																			 * to hardcode SECONDS, which made the
																			 * schema's FRAMES member unreachable
																			 * from any form (the enum-reachability
																			 * sweep's finding, ).
																			 */
																			unit:
																				source.paddingBefore?.unit ?? "SECONDS",
																		},
														})
													}
												/>
												<SelectNative
													aria-label={t("wizard.unit")}
													className="w-28"
													disabled={source.paddingBefore === undefined}
													value={source.paddingBefore?.unit ?? "SECONDS"}
													onChange={(e) => {
														const current = source.paddingBefore;
														if (!current) return;
														patchSource(sIndex, {
															...source,
															paddingBefore: {
																...current,
																unit: e.target.value as "SECONDS" | "FRAMES",
															},
														});
													}}
												>
													<option value="SECONDS">SECONDS</option>
													<option value="FRAMES">FRAMES</option>
												</SelectNative>
											</div>
										</Field>
										<Field
											label={t("wizard.paddingAfterS")}
											htmlFor={`${idBase}-pada-${sIndex}`}
										>
											<div className="flex gap-2">
												<Input
													id={`${idBase}-pada-${sIndex}`}
													type="number"
													step="any"
													className="flex-1"
													value={source.paddingAfter?.duration ?? ""}
													onChange={(e) =>
														patchSource(sIndex, {
															...source,
															paddingAfter:
																e.target.value === ""
																	? undefined
																	: {
																			duration: Math.max(
																				0,
																				Number(e.target.value) || 0,
																			),
																			/*
																			 * Preserve, don't reset — this used
																			 * to hardcode SECONDS, which made the
																			 * schema's FRAMES member unreachable
																			 * from any form (the enum-reachability
																			 * sweep's finding, ).
																			 */
																			unit:
																				source.paddingAfter?.unit ?? "SECONDS",
																		},
														})
													}
												/>
												<SelectNative
													aria-label={t("wizard.unit")}
													className="w-28"
													disabled={source.paddingAfter === undefined}
													value={source.paddingAfter?.unit ?? "SECONDS"}
													onChange={(e) => {
														const current = source.paddingAfter;
														if (!current) return;
														patchSource(sIndex, {
															...source,
															paddingAfter: {
																...current,
																unit: e.target.value as "SECONDS" | "FRAMES",
															},
														});
													}}
												>
													<option value="SECONDS">SECONDS</option>
													<option value="FRAMES">FRAMES</option>
												</SelectNative>
											</div>
										</Field>
									</div>
								</Collapsible>
								<RowRemoveButton
									label={t("wizardX.removeSourceN", { n: sIndex + 1 })}
									onClick={() =>
										patchConcat(index, {
											...concat,
											sources: concat.sources.filter((_, i) => i !== sIndex),
										})
									}
								/>
							</div>
						))}
						<Button
							variant="secondary"
							size="sm"
							onClick={() =>
								patchConcat(index, {
									...concat,
									sources: [
										...concat.sources,
										{ sourceKey: "", position: concat.sources.length },
									],
								})
							}
						>
							{t("wizard.addSource")}
						</Button>
						{encodingKeys.length > 0 ? (
							<EncodingKeySelect
								id={`${idBase}-enc`}
								value={concat.encodingKey}
								encodingKeys={encodingKeys}
								onChange={(encodingKey) =>
									patchConcat(index, { ...concat, encodingKey })
								}
							/>
						) : null}
						<RowRemoveButton
							label={t("wizardX.removeConcatenationStreamN", { n: index + 1 })}
							onClick={() =>
								patchSources({
									...sources,
									concatenationStreams: concats.filter((_, i) => i !== index),
								})
							}
						/>
					</div>
				);
			})}
			<Button
				variant="secondary"
				size="sm"
				onClick={() =>
					patchSources({
						...sources,
						concatenationStreams: [
							...concats,
							{
								key: nextSharedKey(sources, "concat"),
								sources: [{ sourceKey: "", isMain: true, position: 0 }],
							},
						],
					})
				}
			>
				{t("wizard.addConcatenation")}
			</Button>
		</Collapsible>
	);
}
