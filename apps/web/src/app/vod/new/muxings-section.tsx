"use client";

import type { CredentialSummaryWire } from "@bitovp/core";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { HelpOverlay } from "@/components/ui/help-overlay";
import { Input, SelectNative } from "@/components/ui/input";
import { useT } from "@/lib/i18n/context";
import { reconcileAutomaticAudioPackaging } from "./automatic-audio-packaging";
import {
	audioKeys,
	audioMuxingRelPath,
	subtitleKeys,
	videoKeys,
	videoMuxingRelPath,
	type WizardDrmRow,
	type WizardMuxing,
	type WizardMuxingKind,
	type WizardState,
} from "./build-plan";
import { CMAF_CHUNK_FIELDS } from "./cmaf-fields";
import {
	blankDrmRow,
	type DrmEntry,
	DrmRowEditor,
	drmEntriesFor,
	orphanDrmEntries,
} from "./drm-row-editor";
import {
	Collapsible,
	type OptionFieldSpec,
	OptionsGrid,
} from "./wizard-fields";

/**
 * Packaging step: one or more container outputs per rendition, with their
 * encryption (DRM) configured inline. MP4 byte-range HLS and fMP4 segments are
 * different muxing paths to the same manifest family — the kind select makes
 * that explicit instead of conflating them. DRM rows are keyed by the muxing
 * they protect, so they live right under that output.
 */

const VIDEO_KINDS: WizardMuxingKind[] = ["FMP4", "CMAF", "MP4", "TS", "WEBM"];
const AUDIO_KINDS: WizardMuxingKind[] = ["FMP4", "CMAF", "MP4", "TS"];
const SUBTITLE_KINDS: WizardMuxingKind[] = ["CHUNKED_TEXT"];

const FMP4_FIELDS: OptionFieldSpec[] = [
	{
		key: "segmentNamingTemplate",
		labelKey: "wizard.segmentNamingTemplate",
		control: "text",
		hintKey: "wizard.segmentNamingTemplateHint",
	},
	{
		key: "segmentLength",
		labelKey: "wizard.segmentLengthS",
		control: "num",
		hintKey: "wizard.default6",
	},
	{
		key: "segmentNaming",
		labelKey: "wizard.segmentNaming",
		control: "text",
		hintKey: "wizard.defaultSegmentNumberM4s",
	},
	{
		key: "initSegmentName",
		labelKey: "wizard.initSegment",
		control: "text",
		hintKey: "wizard.defaultInitMp4",
	},
];

const MP4_FIELDS: OptionFieldSpec[] = [
	{
		key: "filename",
		labelKey: "wizard.filename",
		control: "text",
		hintKey: "wizard.requiredEGVideoMp4VideoIsmv",
	},
	{
		key: "fragmentDuration",
		labelKey: "wizard.fragmentDurationMs",
		control: "num",
		hintKey: "wizard.setWithManifestTypeForFragmentedMp4",
	},
	{
		key: "manifestType",
		labelKey: "wizard.manifestType",
		control: { options: ["HLS_BYTE_RANGES", "SMOOTH", "DASH_ON_DEMAND"] },
	},
	{
		key: "dolbyVisionTrackSampleEntryName",
		labelKey: "wizard.dolbyvisionBox",
		control: { options: ["DVHE", "DVH1"] },
		hintKey: "wizard.dvTrackSignalingOnTheMp4Box",
	},
];

const TS_FIELDS: OptionFieldSpec[] = [
	{
		key: "segmentNamingTemplate",
		labelKey: "wizard.segmentNamingTemplate",
		control: "text",
		hintKey: "wizard.segmentNamingTemplateHint",
	},
	{
		key: "segmentLength",
		labelKey: "wizard.segmentLengthS",
		control: "num",
		hintKey: "wizard.default6",
	},
	{
		key: "segmentNaming",
		labelKey: "wizard.segmentNaming",
		control: "text",
		hintKey: "wizard.defaultSegNumberTs",
	},
];

const WEBM_FIELDS: OptionFieldSpec[] = [
	{
		key: "segmentLength",
		labelKey: "wizard.segmentLengthS",
		control: "num",
		hintKey: "wizard.default6",
	},
	{
		key: "segmentNaming",
		labelKey: "wizard.segmentNaming",
		control: "text",
		hintKey: "wizard.defaultSegNumberChk",
	},
	{
		key: "initSegmentName",
		labelKey: "wizard.initSegment",
		control: "text",
		hintKey: "wizard.defaultInitHdr",
	},
];

const CHUNKED_TEXT_FIELDS: OptionFieldSpec[] = [
	{
		key: "segmentLength",
		labelKey: "wizard.segmentLengthS",
		control: "num",
		hintKey: "wizard.default10",
	},
	{
		key: "segmentNaming",
		labelKey: "wizard.segmentNaming",
		control: "text",
		hintKey: "wizard.defaultEnWebvttSegNumberVtt",
	},
];

function fieldsFor(kind: WizardMuxingKind): OptionFieldSpec[] {
	switch (kind) {
		case "CMAF":
			return [...FMP4_FIELDS, ...CMAF_CHUNK_FIELDS];
		case "TEXT":
			return [
				{ key: "filename", labelKey: "wizard.filename", control: "text" },
			];
		case "MP4":
			return MP4_FIELDS;
		case "TS":
			return TS_FIELDS;
		case "WEBM":
			return WEBM_FIELDS;
		case "CHUNKED_TEXT":
			return CHUNKED_TEXT_FIELDS;
		default:
			return FMP4_FIELDS;
	}
}

type DrmApi = {
	credentials: CredentialSummaryWire[];
	entriesFor: (muxingKey: string) => DrmEntry[];
	add: (kind: WizardDrmRow["kind"], muxingKey: string) => void;
	change: (index: number, next: WizardDrmRow) => void;
	remove: (index: number) => void;
};

function MuxingEditor({
	idBase,
	label,
	muxingKey,
	kinds,
	defaultKind,
	value,
	derivedPath,
	drm,
	audio,
	audioChoices,
	carriedBySomething,
	onChange,
}: {
	idBase: string;
	label: string;
	muxingKey: string;
	kinds: WizardMuxingKind[];
	defaultKind: WizardMuxingKind;
	value: WizardMuxing | undefined;
	derivedPath: string;
	/** Inline encryption for this output; absent = not DRM-capable (subtitles). */
	drm?: DrmApi;
	/** Audio rows offer the placement choice; video and subtitle rows do not. */
	audio?: boolean;
	/** Audio renditions this VIDEO container may carry, for the picker. */
	audioChoices?: { key: string; label: string }[];
	/** AUDIO rows: is this track already carried by some container? */
	carriedBySomething?: boolean;
	onChange: (next: WizardMuxing) => void;
}) {
	const { t } = useT();
	const muxing = value ?? {};
	const kind = muxing.kind ?? defaultKind;
	const drmEntries = drm?.entriesFor(muxingKey) ?? [];
	const drmOwned = drmEntries.length > 0;
	// Only TS and MP4 can carry a second stream — `additionalStreamKeys` lives
	// on those two schemas.
	const kindCanMux = kind === "TS" || kind === "MP4";
	/**
	 * The selection, resolved against the renditions that CURRENTLY exist.
	 *
	 * The stored array can outlive its rendition — delete an audio rung and the
	 * key stays behind. Reading it raw made the hint claim "Carrying 2 track(s)"
	 * for a ladder holding one (owner report). `buildPlan` filters the same way,
	 * so this is the view agreeing with the builder rather than a second
	 * opinion about it.
	 */
	const selectedAudio = (muxing.muxedAudioKeys ?? []).find((key) =>
		(audioChoices ?? []).some((choice) => choice.key === key),
	);
	const muxedIn = audio === true && muxing.ownContainer === false;
	return (
		<div className="space-y-3 rounded-md border border-zinc-800 p-3">
			<div className="flex items-center gap-2">
				<span className="font-mono text-xs text-zinc-300">{muxingKey}</span>
				<span className="text-xs text-zinc-500">{label}</span>
				{drmOwned ? (
					<span className="ml-auto rounded bg-amber-950 px-2 py-0.5 text-amber-400 text-xs">
						{t("wizard.drmOutputOwnsTheDestination")}
					</span>
				) : null}
			</div>
			<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
				<Field
					label={t("wizard.container")}
					htmlFor={`${idBase}-kind`}
					tooltip={
						kinds.includes("CMAF") ? t("wizard.cmafCompatibility") : undefined
					}
				>
					<SelectNative
						id={`${idBase}-kind`}
						value={kind}
						onChange={(e) =>
							onChange({
								...muxing,
								kind: e.target.value as WizardMuxingKind,
							})
						}
					>
						{kinds.map((k) => (
							<option key={k} value={k}>
								{k}
							</option>
						))}
					</SelectNative>
				</Field>
				{/*
				 * THE RELATION, on the CARRIER , and AT MOST ONE.
				 *
				 * Two facts shape this control:
				 *
				 *  - it belongs to the CARRIER, because the relation is
				 *    many-to-many (videoA←audioA, videoB←audioB, videoC←audioA)
				 *    and a flag on the audio row can only broadcast;
				 *  - it is SINGLE, because a manifest references the CONTAINER,
				 *    not a track inside it. A second audio PID is encoded,
				 *    stored, delivered and unreachable. Checkboxes let an
				 *    operator ask for that; a select cannot (owner report).
				 *
				 * Reading through `audioChoices` rather than the stored array is
				 * what keeps this honest when a rendition is deleted from the
				 * ladder — a key with no rendition behind it is not a selection.
				 */}
				{!audio && kindCanMux && audioChoices && audioChoices.length > 0 ? (
					<Field
						label={t("wizard.muxedAudio")}
						htmlFor={`${idBase}-muxaudio`}
						hint={
							selectedAudio
								? t("wizardX.muxedAudioCarrying", { key: selectedAudio })
								: t("wizard.muxedAudioHint")
						}
					>
						<SelectNative
							id={`${idBase}-muxaudio`}
							value={selectedAudio ?? ""}
							onChange={(e) =>
								onChange({
									...muxing,
									muxedAudioKeys:
										e.target.value === "" ? undefined : [e.target.value],
								})
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
				) : null}
				{/* And on the TRACK: does it also ship standalone? Independent of
				    the above, because a track can do both, either, or neither. */}
				{audio ? (
					<Field
						label={t("wizard.ownContainer")}
						htmlFor={`${idBase}-own`}
						hint={
							kind === "WEBM"
								? undefined
								: muxing.ownContainer === false
									? carriedBySomething
										? t("wizard.ownContainerOffHint")
										: t("wizard.ownContainerOffUncarriedHint")
									: t("wizard.ownContainerOnHint")
						}
					>
						<label
							htmlFor={`${idBase}-own`}
							className="flex items-center gap-2 text-xs text-zinc-300"
						>
							<input
								id={`${idBase}-own`}
								type="checkbox"
								className="h-3.5 w-3.5 accent-emerald-600"
								checked={muxing.ownContainer !== false}
								onChange={(e) =>
									onChange({
										...muxing,
										ownContainer: e.target.checked,
										autoOwnContainer: undefined,
									})
								}
							/>
							{t("wizard.ownContainerLabel")}
						</label>
					</Field>
				) : null}
			</div>
			{/* A muxed-in track creates NO container of its own, so segment
			    naming, a destination and encryption would all be settings for a
			    resource that is never built. The video container it rides in
			    carries them. */}
			{muxedIn ? null : (
				<OptionsGrid
					idBase={idBase}
					value={muxing}
					fields={fieldsFor(kind)}
					onChange={onChange}
				/>
			)}
			{muxedIn ? null : (
				<Field
					label={t("wizard.destinationPath")}
					htmlFor={`${idBase}-path`}
					hint={
						drmOwned
							? t("wizard.anEncryptionRowTargetsThisOutputIts")
							: t("wizardX.derivedPathHint", {
									path: derivedPath,
									uuidToken: "{uuid}",
									bitrateToken: "{bitrate}",
								})
					}
				>
					<Input
						id={`${idBase}-path`}
						placeholder={derivedPath}
						value={muxing.path ?? ""}
						onChange={(e) =>
							onChange({
								...muxing,
								path: e.target.value === "" ? undefined : e.target.value,
							})
						}
					/>
				</Field>
			)}
			{drm && !muxedIn && (kind !== "CMAF" || drmEntries.length > 0) ? (
				<Collapsible
					summary={t("wizardX.encryptionDrmCount", {
						count: drmEntries.length,
					})}
					help={t("wizard.contentKeysStayInTheVaultA")}
				>
					{drmEntries.map(({ row, index }) => (
						<DrmRowEditor
							key={index}
							idBase={`${idBase}-drm-${index}`}
							row={row}
							drmCredentials={drm.credentials}
							onChange={(next) => drm.change(index, next)}
							onRemove={() => drm.remove(index)}
						/>
					))}
					{kind !== "CMAF" ? (
						<div className="flex gap-1">
							<Button
								variant="secondary"
								size="sm"
								onClick={() => drm.add("CENC", muxingKey)}
							>
								{t("wizard.addCenc")}
							</Button>
							<Button
								variant="secondary"
								size="sm"
								onClick={() => drm.add("FAIRPLAY", muxingKey)}
							>
								{t("wizard.addFairplay")}
							</Button>
							{kind === "FMP4" ? (
								<Button
									variant="secondary"
									size="sm"
									onClick={() => drm.add("SPEKE", muxingKey)}
								>
									+ SPEKE
								</Button>
							) : null}
						</div>
					) : null}
				</Collapsible>
			) : null}
		</div>
	);
}

/**
 * One rendition's outputs: the primary container plus any extra containers from
 * the same stream (e.g. a TS container for HLS beside the fMP4 for DASH). Extra
 * containers each carry their own resource `key`; the streamKey stays the
 * rendition key. Each output configures its own encryption inline.
 */
function RenditionMuxings({
	idBase,
	label,
	muxingKey,
	kinds,
	derivedPath,
	drm,
	audio,
	audioChoices,
	carriedBySomething,
	muxing,
	extraMuxings,
	onChange,
}: {
	idBase: string;
	label: string;
	muxingKey: string;
	kinds: WizardMuxingKind[];
	derivedPath: string;
	drm: DrmApi;
	/** Audio rendition rows — see MuxingEditor's `audio`. */
	audio?: boolean;
	/** Forwarded to every leg — see MuxingEditor. */
	audioChoices?: { key: string; label: string }[];
	carriedBySomething?: boolean;
	muxing: WizardMuxing | undefined;
	extraMuxings: WizardMuxing[] | undefined;
	onChange: (next: {
		muxing?: WizardMuxing;
		extraMuxings?: WizardMuxing[];
	}) => void;
}) {
	const { t } = useT();
	const extras = extraMuxings ?? [];
	const emit = (m: WizardMuxing | undefined, legs: WizardMuxing[]) =>
		onChange({
			...(m ? { muxing: m } : {}),
			...(legs.length > 0 ? { extraMuxings: legs } : {}),
		});
	const addContainer = () => {
		const used = new Set([muxingKey, ...extras.map((e) => e.key)]);
		let n = extras.length + 1;
		while (used.has(`${muxingKey}-leg${n}`)) {
			n += 1;
		}
		emit(muxing, [...extras, { kind: "TS", key: `${muxingKey}-leg${n}` }]);
	};
	return (
		<div className="space-y-2">
			<MuxingEditor
				idBase={idBase}
				label={label}
				muxingKey={muxingKey}
				kinds={kinds}
				defaultKind={kinds[0] ?? "FMP4"}
				value={muxing}
				derivedPath={derivedPath}
				drm={drm}
				audio={audio}
				audioChoices={audioChoices}
				carriedBySomething={carriedBySomething}
				onChange={(m) => emit(m, extras)}
			/>
			{extras.map((leg, j) => (
				<div
					key={leg.key ?? `${muxingKey}-x${j}`}
					className="ml-4 space-y-1 border-zinc-800 border-l-2 pl-3"
				>
					<MuxingEditor
						idBase={`${idBase}-x${j}`}
						label={t("wizardX.extraContainerOf", { key: muxingKey })}
						// Mirror buildPlan's muxKey fallback (m.key ?? key): extras always
						// carry a key today, but a keyless one must bind its DRM to the
						// same key buildPlan emits — the rendition key, not a synthetic.
						muxingKey={leg.key ?? muxingKey}
						kinds={kinds}
						defaultKind="TS"
						value={leg}
						derivedPath={derivedPath}
						drm={drm}
						audio={audio}
						audioChoices={audioChoices}
						carriedBySomething={carriedBySomething}
						onChange={(m) => {
							const next = [...extras];
							next[j] = m;
							emit(muxing, next);
						}}
					/>
					<Button
						variant="secondary"
						size="sm"
						onClick={() =>
							emit(
								muxing,
								extras.filter((_, k) => k !== j),
							)
						}
					>
						{t("wizard.removeContainer")}
					</Button>
				</div>
			))}
			<Button variant="secondary" size="sm" onClick={addContainer}>
				{t("wizard.addContainerFormat")}
			</Button>
		</div>
	);
}

type MuxingsSectionProps = {
	state: WizardState;
	credentials: CredentialSummaryWire[];
	onPatch: (partial: Partial<WizardState>) => void;
};

export function MuxingsSection({
	state,
	credentials,
	onPatch,
}: MuxingsSectionProps) {
	const { t } = useT();
	const subtitles = state.subtitles ?? [];
	const vKeys = videoKeys(state.videos);
	const aKeys = audioKeys(state.audios);
	const sKeys = subtitleKeys(subtitles);
	const drmRows = state.drm ?? [];

	const drm: DrmApi = {
		credentials: credentials.filter(
			(c) => c.provider === "DRM_CENC" || c.provider === "DRM_SPEKE",
		),
		entriesFor: (key) => drmEntriesFor(drmRows, key),
		add: (kind, muxingKey) =>
			onPatch({ drm: [...drmRows, blankDrmRow(kind, muxingKey)] }),
		change: (index, next) => {
			const list = [...drmRows];
			list[index] = next;
			onPatch({ drm: list });
		},
		remove: (index) => onPatch({ drm: drmRows.filter((_, i) => i !== index) }),
	};

	// Every packaging output key (primary + extra containers); DRM rows whose
	// muxingKey matches none of these are "orphaned" (e.g. a rendition's key
	// changed after the row was added) — surface them so they can be retargeted
	// or removed instead of silently failing the preview as an unresolved ref.
	const allKeys = [
		...state.videos.flatMap((v, i) => [
			vKeys[i],
			...(v.extraMuxings ?? []).map((m) => m.key),
		]),
		...state.audios.flatMap((a, i) => [
			...(a.muxing?.ownContainer === false ? [] : [aKeys[i]]),
			...(a.extraMuxings ?? [])
				.filter((m) => m.ownContainer !== false)
				.map((m) => m.key),
		]),
	].filter((k): k is string => typeof k === "string");
	const orphans = orphanDrmEntries(drmRows, new Set(allKeys));

	/**
	 * The audio renditions a video container may carry, and which tracks are
	 * already carried .
	 *
	 * Both are derived from the SAME state the builder reads, so the picker
	 * cannot offer a key the plan will not have and the standalone toggle
	 * cannot claim a track is covered when it is not.
	 */
	const audioChoices = state.audios.map((audio, index) => ({
		key: aKeys[index] ?? `a${Math.round(audio.bitrate / 1000)}`,
		label: `${audio.codec ?? "AAC"} ${Math.round(audio.bitrate / 1000)}k`,
	}));
	const carriedAudioKeys = new Set(
		state.videos.flatMap((video) =>
			[video.muxing, ...(video.extraMuxings ?? [])].flatMap(
				(leg) => leg?.muxedAudioKeys ?? [],
			),
		),
	);

	return (
		<div className="space-y-3">
			{/* #129 batch 3 (running-app inventory): the step intro moved behind
			    the ? — the stepper already names the step; the paragraph only
			    explained it. */}
			<div className="flex justify-end">
				<HelpOverlay
					label={t("uiX.moreInformationFor", {
						label: t("wizard.packaging"),
					})}
				>
					{t("wizard.oneOrMoreContainerOutputsPerRendition")}
				</HelpOverlay>
			</div>
			{state.videos.map((video, index) => {
				const key = vKeys[index] ?? `v${video.height}`;
				return (
					<RenditionMuxings
						key={`v-${index}`}
						idBase={`wz-mx-v-${index}`}
						label={`video · ${video.codec ?? "H264"}`}
						muxingKey={key}
						kinds={
							video.codec === undefined || video.codec === "H264"
								? VIDEO_KINDS
								: VIDEO_KINDS.filter((kind) => kind !== "CMAF")
						}
						derivedPath={videoMuxingRelPath(video, key)}
						drm={drm}
						audioChoices={audioChoices}
						muxing={video.muxing}
						extraMuxings={video.extraMuxings}
						onChange={(next) => {
							const videos = [...state.videos];
							videos[index] = {
								...video,
								muxing: next.muxing,
								extraMuxings: next.extraMuxings,
							};
							const audios = reconcileAutomaticAudioPackaging({
								...state,
								videos,
							});
							onPatch({ videos, audios });
						}}
					/>
				);
			})}
			{state.audios.map((audio, index) => {
				const key = aKeys[index] ?? `a${Math.round(audio.bitrate / 1000)}`;
				return (
					<RenditionMuxings
						key={`a-${index}`}
						idBase={`wz-mx-a-${index}`}
						label={`audio · ${audio.codec ?? "AAC"}`}
						muxingKey={key}
						kinds={
							audio.codec === "OPUS"
								? ["WEBM"]
								: audio.codec === undefined || audio.codec === "AAC"
									? AUDIO_KINDS
									: AUDIO_KINDS.filter((kind) => kind !== "CMAF")
						}
						derivedPath={audioMuxingRelPath(audio, key)}
						drm={drm}
						audio
						carriedBySomething={carriedAudioKeys.has(key)}
						muxing={audio.muxing}
						extraMuxings={audio.extraMuxings}
						onChange={(next) => {
							const audios = [...state.audios];
							audios[index] = {
								...audio,
								muxing: next.muxing,
								extraMuxings: next.extraMuxings,
							};
							onPatch({ audios });
						}}
					/>
				);
			})}
			{subtitles.map((subtitle, index) => {
				const key = sKeys[index] ?? "vtt";
				return (
					<MuxingEditor
						key={`s-${index}`}
						idBase={`wz-mx-s-${index}`}
						label={
							subtitle.codec === "IMSC" ? "IMSC" : t("wizard.subtitleWebvtt")
						}
						muxingKey={key}
						kinds={subtitle.codec === "IMSC" ? ["TEXT"] : SUBTITLE_KINDS}
						defaultKind={subtitle.codec === "IMSC" ? "TEXT" : "CHUNKED_TEXT"}
						value={subtitle.muxing}
						derivedPath={`subtitles/${key}`}
						onChange={(muxing) => {
							const next = [...subtitles];
							next[index] = { ...subtitle, muxing };
							onPatch({ subtitles: next });
						}}
					/>
				);
			})}

			{orphans.length > 0 ? (
				<div className="space-y-3 rounded-md border border-amber-900/60 bg-amber-950/20 p-3">
					<p className="text-amber-400 text-xs">
						{t("wizard.theseEncryptionRowsTargetAnOutputKey")}
					</p>
					{orphans.map(({ row, index }) => (
						<div key={index} className="space-y-2">
							<Field
								label={t("wizard.rePointToOutput")}
								htmlFor={`wz-drm-orphan-${index}-mux`}
							>
								<SelectNative
									id={`wz-drm-orphan-${index}-mux`}
									value={row.muxingKey}
									onChange={(e) =>
										drm.change(index, { ...row, muxingKey: e.target.value })
									}
								>
									<option value={row.muxingKey}>
										{row.muxingKey || "—"} {t("wizardX.missingParen")}
									</option>
									{allKeys.map((key) => (
										<option key={key} value={key}>
											{key}
										</option>
									))}
								</SelectNative>
							</Field>
							<DrmRowEditor
								idBase={`wz-drm-orphan-${index}`}
								row={row}
								drmCredentials={drm.credentials}
								onChange={(next) => drm.change(index, next)}
								onRemove={() => drm.remove(index)}
							/>
						</div>
					))}
				</div>
			) : null}
		</div>
	);
}
