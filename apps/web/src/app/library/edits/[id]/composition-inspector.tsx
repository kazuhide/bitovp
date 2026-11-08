"use client";
import {
	applyCompositionTemplate,
	COMPOSITION_LIMITS,
	COMPOSITION_TEMPLATE_PRESETS,
	type CompositionClip,
	type CompositionDocument,
	type CompositionSourceFacts,
	compileComposition,
	compositionDurationFrames,
	compositionOutputRect,
	compositionUsesMainPresentation,
	DEFAULT_CAPTION_LAYOUT,
	DEFAULT_COMPOSITION_TEXT_STYLE,
	evaluateCompositionFrame,
	moveCompositionClip,
	removeCompositionClip,
	resolveCompositionCaptionDisplay,
	resolvePresentedCompositionGeometry,
	setCompositionCaptionDisplayText,
	setCompositionPresentation,
	splitCompositionClip,
	suggestFixedCrop,
	trimCompositionClip,
} from "@bitovp/core";
import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input, SelectNative } from "@/components/ui/input";
import type { EditingMediaView } from "@/lib/library-editing";
import {
	EditingDetails,
	EditingHelp,
	EditingHelpText,
} from "../../editing-help";
import { useCompositionCopy } from "./composition-copy";
import { useCompositionPendingInput } from "./composition-inputs";
import type { CompositionSourceFrameReader } from "./composition-source-frame";
import { type CropCandidateContext, CropCandidates } from "./crop-candidates";
import { type ManualCropProjection, stableManualCrop } from "./manual-crop";

export function CompositionNumber({
	label,
	value,
	onChange,
	disabled = false,
	step = 1,
	min = 0,
	max = 5400,
}: {
	label: string;
	value: number;
	onChange: (value: number) => void;
	disabled?: boolean;
	step?: number;
	min?: number;
	max?: number;
}) {
	const id = useId(),
		[text, setText] = useState(String(value));
	const onPending = useCompositionPendingInput();
	useEffect(() => {
		setText(String(Number(value.toFixed(4))));
		onPending(id, false);
	}, [value, id, onPending]);
	useEffect(() => () => onPending(id, false), [id, onPending]);
	return (
		<label
			htmlFor={id}
			className="block min-w-0 space-y-1 text-xs text-zinc-400"
		>
			{label}
			<Input
				id={id}
				type="number"
				value={text}
				step={step}
				min={min}
				max={max}
				disabled={disabled}
				onChange={(event) => {
					setText(event.target.value);
					onPending(id, true);
				}}
				onKeyDown={(event) => {
					if (event.key === "Enter") event.currentTarget.blur();
				}}
				onBlur={() => {
					const next = Number(text);
					if (
						text !== String(Number(value.toFixed(4))) &&
						text.trim() &&
						Number.isFinite(next) &&
						next >= min &&
						next <= max
					)
						onChange(next);
					setText(String(value));
					onPending(id, false);
				}}
			/>
		</label>
	);
}
export type CompositionCatalogMedia = EditingMediaView & {
	facts: CompositionSourceFacts;
};
type Props = {
	document: CompositionDocument;
	sources: CompositionSourceFacts[];
	catalog: CompositionCatalogMedia[];
	selectedId: string;
	frame: number;
	disabled: boolean;
	presentationDisabled?: boolean;
	onChange: (document: CompositionDocument) => void;
	onSelect: (id: string) => void;
	onError: () => void;
	onUpload: (file: File) => Promise<void>;
	candidateContext?: CropCandidateContext;
	sourceFrameReader?: CompositionSourceFrameReader | null;
	sourceFrameRevision?: number;
	expectedSourceFrame?: number;
};
export function CompositionInspector(props: Props) {
	const c = useCompositionCopy(),
		controlId = useId(),
		{
			document: doc,
			sources,
			catalog,
			frame,
			selectedId,
			disabled,
			onChange,
			onError,
			onSelect,
		} = props;
	const [tab, setTab] = useState<"VIDEO" | "AUDIO" | "TEXT">("VIDEO"),
		[sourceId, setSourceId] = useState("");
	const clip = doc.clips.find((item) => item.id === selectedId) ?? doc.clips[0];
	const source = sources.find(
		(item) =>
			item.mediaVersionId === (clip?.mediaVersionId ?? doc.mediaVersionId),
	);
	const autoFraming = doc.presentation?.videoFit === "AUTO";
	const preserveSource =
		doc.presentation?.fallbackFraming === "PRESERVE_SOURCE_V1";
	const staticFraming =
		preserveSource ||
		doc.presentation?.fallbackFraming === "AISA_STATIC_V1" ||
		clip?.fallbackCrop !== undefined;
	const duration = compositionDurationFrames(doc),
		captionCount = doc.captions?.length ?? 0,
		localFrame = clip
			? Math.max(
					0,
					Math.min(clip.durationFrames - 1, frame - clip.timelineStartFrame),
				)
			: 0;
	const attempt = (action: () => CompositionDocument) => {
		try {
			onChange(action());
		} catch {
			onError();
		}
	};
	const sourceUs = (seconds: number, id: string) => {
		const start =
			sources.find((item) => item.mediaVersionId === id)?.timeMap
				.sourceStartUs ?? 0;
		return (
			start +
			Math.ceil(
				(Math.round(((seconds * 1_000_000 - start) * 30) / 1_000_000) *
					1_000_000) /
					30,
			)
		);
	};
	const patch = (update: Partial<CompositionClip>) =>
		onChange({
			...doc,
			clips: doc.clips.map((item) =>
				item.id === clip?.id ? { ...item, ...update } : item,
			),
		});
	function clipFade(field: "fadeInFrames" | "fadeOutFrames", frames: number) {
		if (!clip) return;
		patch({
			audio: {
				...clip.audio,
				fadeWindow: undefined,
				fadeInFrames: Math.min(
					clip.durationFrames,
					clip.audio.fadeInFrames ?? 0,
				),
				fadeOutFrames: Math.min(
					clip.durationFrames,
					clip.audio.fadeOutFrames ?? 0,
				),
				[field]: frames,
			},
		});
	}

	const activeSource =
		catalog.find((item) => item.id === sourceId) ?? catalog[0];
	function declare(media: CompositionCatalogMedia): CompositionDocument {
		if (
			media.id === doc.mediaVersionId ||
			doc.sources?.some((item) => item.mediaVersionId === media.id)
		)
			return doc;
		return {
			...doc,
			sources: [
				...(doc.sources ?? []),
				{
					mediaVersionId: media.id,
					timeMapId: media.facts.timeMap.id,
					analysisRevisionId: null,
				},
			],
		};
	}
	function addVideo(layer: boolean) {
		if (!activeSource) return;
		const next = declare(activeSource),
			id = crypto.randomUUID(),
			tracks = next.videoTracks ?? [{ id: "main", name: c.clips, order: 0 }],
			trackId = layer ? `layer_${crypto.randomUUID().slice(0, 8)}` : "main";
		const start = layer ? Math.min(frame, duration - 1) : duration,
			frames = Math.min(
				90,
				activeSource.facts.timeMap.editingEndFrame -
					activeSource.facts.timeMap.editingStartFrame,
				5400 - start,
			);
		onChange({
			...next,
			videoTracks: layer
				? [
						...tracks,
						{
							id: trackId,
							name: `${c.track} ${tracks.length + 1}`,
							order: tracks.length,
						},
					]
				: tracks,
			clips: [
				...next.clips,
				{
					id,
					mediaVersionId: activeSource.id,
					trackId,
					timelineStartFrame: start,
					sourceInUs: activeSource.facts.timeMap.sourceStartUs,
					durationFrames: frames,
					framing: [
						{ fromFrame: 0, toFrame: frames, mode: "FIT", origin: "MANUAL" },
					],
					audio: {
						mode: layer || !activeSource.facts.hasAudio ? "MUTE" : "SOURCE",
					},
					...(layer ? { layout: { x: 0.62, y: 0.06, w: 0.32, h: 0.32 } } : {}),
				},
			],
		});
		onSelect(id);
	}
	function addAudio() {
		if (!activeSource?.facts.hasAudio) return;
		const next = declare(activeSource);
		onChange({
			...next,
			audioTracks: [
				...(next.audioTracks ?? []),
				{
					id: crypto.randomUUID(),
					mediaVersionId: activeSource.id,
					sourceInUs: activeSource.facts.timeMap.sourceStartUs,
					timelineStartFrame: 0,
					durationFrames: Math.min(
						duration,
						activeSource.facts.timeMap.editingEndFrame -
							activeSource.facts.timeMap.editingStartFrame,
					),
					gainDb: -12,
					fadeInFrames: 15,
					fadeOutFrames: 15,
				},
			],
		});
	}
	const number = (
		label: string,
		value: number,
		onChange: (value: number) => void,
		extra: { min?: number; max?: number; step?: number } = {},
	) => (
		<CompositionNumber
			key={label}
			label={label}
			value={value}
			onChange={onChange}
			disabled={disabled}
			{...extra}
		/>
	);
	let rect = { x: 0, y: 0, w: 1, h: 1 };
	// Saved crops use the original layout; BANDS only projects their display.
	let canonicalTarget = {
		width: Math.round(doc.canvas.width * (clip?.layout?.w ?? 1)),
		height: Math.round(doc.canvas.height * (clip?.layout?.h ?? 1)),
	};
	let displayTarget = canonicalTarget;
	try {
		const layer =
			clip &&
			evaluateCompositionFrame(
				compileComposition(doc, sources, { allowUnconfirmed: true }),
				clip.timelineStartFrame + localFrame,
			).layers.find((item) => item.clipId === clip.id);
		if (layer?.cropRect) rect = layer.cropRect;
		if (layer && doc.presentation && clip) {
			const originalLayout = compositionOutputRect(
				clip.layout ?? { x: 0, y: 0, w: 1, h: 1 },
				doc.canvas.width,
				doc.canvas.height,
			);
			canonicalTarget = { width: originalLayout.w, height: originalLayout.h };
			displayTarget = { width: layer.layoutRect.w, height: layer.layoutRect.h };
		}
	} catch {
		/* Parent keeps the last valid composition. */
	}
	function crop(
		centerX: number,
		centerY: number,
		zoom: number,
		animated = Boolean(clip?.cropKeyframes),
	) {
		if (!clip || !source) return;
		const suggested = suggestFixedCrop({
			sourceWidth: source.width,
			sourceHeight: source.height,
			targetWidth: canonicalTarget.width,
			targetHeight: canonicalTarget.height,
			centerX,
			centerY,
			zoom,
		});
		let projection: ManualCropProjection | undefined;
		if (doc.presentation && compositionUsesMainPresentation(doc, clip)) {
			// One shallow view also preserves a later switch from OVERLAY to BANDS.
			const bands: CompositionDocument = {
				...doc,
				presentation: { ...doc.presentation, captionPlacement: "BANDS" },
			};
			projection = (rect) =>
				resolvePresentedCompositionGeometry({
					document: bands,
					clip: {
						...clip,
						videoFit: "FILL",
						cropKeyframes: undefined,
						framing: [
							{
								fromFrame: 0,
								toFrame: clip.durationFrames,
								mode: "CROP",
								origin: "MANUAL",
								rect,
							},
						],
					},
					sourceWidth: source.width,
					sourceHeight: source.height,
					width: doc.canvas.width,
					height: doc.canvas.height,
					frame: localFrame,
				}).sourceRect;
		}
		const next = doc.presentation
			? stableManualCrop(suggested, source, projection)
			: suggested;
		patch({
			videoFit: "FILL",
			framing: [
				{
					fromFrame: 0,
					toFrame: clip.durationFrames,
					mode: "CROP",
					origin: "MANUAL",
					rect: next,
					manualOverride: true,
				},
			],
			...(animated
				? {
						cropKeyframes: [
							...(clip.cropKeyframes ?? []).filter(
								(key) => key.frame !== localFrame,
							),
							{ frame: localFrame, rect: next, easing: "SMOOTH" as const },
						].sort((a, b) => a.frame - b.frame),
					}
				: { cropKeyframes: undefined }),
		});
	}
	const maxCrop = source
		? suggestFixedCrop({
				sourceWidth: source.width,
				sourceHeight: source.height,
				targetWidth: displayTarget.width,
				targetHeight: displayTarget.height,
				centerX: rect.x + rect.w / 2,
				centerY: rect.y + rect.h / 2,
			})
		: rect;
	const zoom = Math.max(1, Math.min(3, maxCrop.w / rect.w));
	return (
		<aside className="min-w-0 space-y-4 rounded-xl border border-zinc-800 bg-zinc-950 p-4">
			<div className="flex gap-1 rounded-lg bg-zinc-900 p-1">
				{(["VIDEO", "AUDIO", "TEXT"] as const).map((item) => (
					<Button
						key={item}
						size="sm"
						className="h-auto min-w-0 flex-1 whitespace-nowrap px-2 py-2 text-xs"
						aria-label={
							item === "VIDEO"
								? c.clips
								: item === "AUDIO"
									? c.audioTab
									: c.text
						}
						aria-description={item === "AUDIO" ? c.audio : undefined}
						aria-pressed={tab === item}
						variant={tab === item ? "default" : "ghost"}
						onClick={() => setTab(item)}
					>
						{item === "VIDEO"
							? c.clips
							: item === "AUDIO"
								? c.audioTab
								: c.textTab}
					</Button>
				))}
			</div>
			{tab !== "TEXT" && (
				<div className="space-y-2">
					<label
						htmlFor={`${controlId}-source`}
						className="block text-xs text-zinc-400"
					>
						{c.source}
						<SelectNative
							id={`${controlId}-source`}
							value={activeSource?.id ?? ""}
							disabled={disabled}
							onChange={(event) => setSourceId(event.target.value)}
						>
							{catalog.map((media, index) => (
								<option key={media.id} value={media.id}>
									{index + 1} · {media.width}×{media.height} ·{" "}
									{((media.durationUs ?? 0) / 1_000_000).toFixed(1)}s ·{" "}
									{media.sourceId.slice(0, 8)}
								</option>
							))}
						</SelectNative>
					</label>
					{!catalog.length && (
						<p className="text-xs text-zinc-500">{c.sourceUnavailable}</p>
					)}
					<div className="flex flex-wrap gap-2">
						{tab === "VIDEO" ? (
							<>
								<Button
									size="sm"
									disabled={disabled || !activeSource || doc.clips.length >= 20}
									onClick={() => addVideo(false)}
								>
									{c.addClip}
								</Button>
								<Button
									size="sm"
									variant="secondary"
									disabled={
										disabled ||
										!activeSource ||
										(doc.videoTracks?.length ?? 1) >= 4
									}
									onClick={() => addVideo(true)}
								>
									{c.addLayer}
								</Button>
							</>
						) : (
							<Button
								size="sm"
								disabled={
									disabled ||
									!activeSource?.facts.hasAudio ||
									(doc.audioTracks?.length ?? 0) >= 8
								}
								onClick={addAudio}
							>
								{c.addAudio}
							</Button>
						)}
					</div>
				</div>
			)}
			{tab === "VIDEO" && clip && (
				<div className="space-y-4">
					<Field
						label={c.videoFit}
						htmlFor={`${controlId}-video-fit`}
						help={
							<EditingHelpText>
								{autoFraming ? (
									<>
										<p>
											{preserveSource ? c.videoPreserveHelp : c.videoAutoHelp}
										</p>
										<p>
											{preserveSource
												? c.videoPreserveBackgroundHelp
												: c.videoAutoFallbackHelp}
										</p>
									</>
								) : (
									<p>
										{preserveSource
											? c.videoPreserveSummary
											: c.videoFitSummary}
									</p>
								)}
							</EditingHelpText>
						}
					>
						<SelectNative
							id={`${controlId}-video-fit`}
							value={doc.presentation?.videoFit ?? "LEGACY"}
							disabled={disabled || props.presentationDisabled}
							onChange={(event) =>
								attempt(() =>
									setCompositionPresentation(doc, {
										videoFit:
											event.target.value === "AUTO"
												? "AUTO"
												: event.target.value === "FIT"
													? "FIT"
													: "FILL",
									}),
								)
							}
						>
							<option value="LEGACY" disabled>
								{c.keepFraming}
							</option>
							<option value="AUTO">
								{preserveSource ? c.videoPreserveAuto : c.videoAuto}
							</option>
							<option value="FILL">
								{preserveSource ? c.videoPreserveFill : c.videoFill}
							</option>
							<option value="FIT">
								{preserveSource ? c.videoPreserveContain : c.videoContain}
							</option>
						</SelectNative>
					</Field>
					<EditingDetails summary={c.videoFitDetails}>
						{autoFraming ? (
							<>
								<p>
									{preserveSource ? c.videoPreserveDetails : c.videoAutoDetails}
								</p>
								<p>{c.videoAutoBandsHelp}</p>
							</>
						) : staticFraming ? (
							<>
								<p>{c.videoStaticHelp}</p>
								<p>{c.videoStaticReferenceHelp}</p>
							</>
						) : (
							<p>
								{doc.presentation?.videoFit
									? c.videoFitHelp
									: c.keepFramingHelp}
							</p>
						)}
					</EditingDetails>
					{source && (
						<CropCandidates
							document={doc}
							clip={clip}
							source={source}
							context={props.candidateContext}
							frame={frame}
							expectedSourceFrame={props.expectedSourceFrame}
							frameReader={props.sourceFrameReader}
							frameRevision={props.sourceFrameRevision ?? 0}
							disabled={disabled || Boolean(props.presentationDisabled)}
							onChange={onChange}
						/>
					)}
					<div className="border-zinc-800 border-t pt-3">
						<h2 className="mb-3 font-medium text-sm">
							{c.selected} · {doc.clips.indexOf(clip) + 1}
						</h2>
						<div className="grid grid-cols-2 gap-2">
							{number(
								c.start,
								clip.timelineStartFrame / 30,
								(value) =>
									attempt(() =>
										moveCompositionClip(doc, clip.id, {
											timelineStartFrame: Math.round(value * 30),
										}),
									),
								{ step: 1 / 30, max: 180 },
							)}
							{number(
								c.duration,
								clip.durationFrames / 30,
								(value) =>
									attempt(() =>
										trimCompositionClip(
											doc,
											clip.id,
											{
												sourceInUs: clip.sourceInUs,
												durationFrames: Math.round(value * 30),
											},
											sources,
										),
									),
								{ step: 1 / 30, min: 1 / 30, max: 180 },
							)}
							{number(
								c.sourceIn,
								clip.sourceInUs / 1_000_000,
								(value) =>
									attempt(() =>
										trimCompositionClip(
											doc,
											clip.id,
											{
												sourceInUs: sourceUs(
													value,
													clip.mediaVersionId ?? doc.mediaVersionId,
												),
												durationFrames: clip.durationFrames,
											},
											sources,
										),
									),
								{ step: 1 / 30, max: 3600 },
							)}
							<label
								htmlFor={`${controlId}-track`}
								className="text-xs text-zinc-400"
							>
								{c.track}
								<SelectNative
									disabled={disabled}
									id={`${controlId}-track`}
									value={clip.trackId ?? "main"}
									onChange={(event) =>
										attempt(() =>
											moveCompositionClip(doc, clip.id, {
												timelineStartFrame: clip.timelineStartFrame,
												trackId: event.target.value,
											}),
										)
									}
								>
									{(
										doc.videoTracks ?? [{ id: "main", name: c.clips, order: 0 }]
									).map((track) => (
										<option key={track.id} value={track.id}>
											{track.name}
										</option>
									))}
								</SelectNative>
							</label>
						</div>
					</div>
					<div className="flex flex-wrap gap-2">
						<Button
							size="sm"
							variant="secondary"
							disabled={
								disabled || localFrame <= 0 || localFrame >= clip.durationFrames
							}
							onClick={() =>
								attempt(() =>
									splitCompositionClip(
										doc,
										clip.id,
										localFrame,
										crypto.randomUUID(),
										sources,
									),
								)
							}
						>
							{c.split}
						</Button>
						<Button
							size="sm"
							variant="secondary"
							disabled={disabled || doc.clips.length <= 1}
							onClick={() => attempt(() => removeCompositionClip(doc, clip.id))}
						>
							{c.remove}
						</Button>
						<Button
							size="sm"
							variant="secondary"
							disabled={disabled || clip.timelineStartFrame < 15}
							onClick={() => {
								const prior = doc.clips
									.filter(
										(item) =>
											(item.trackId ?? "main") === (clip.trackId ?? "main") &&
											item.timelineStartFrame < clip.timelineStartFrame,
									)
									.sort(
										(a, b) => b.timelineStartFrame - a.timelineStartFrame,
									)[0];
								if (!prior) return onError();
								const overlap = Math.min(
										15,
										clip.durationFrames,
										prior.durationFrames,
									),
									shift =
										prior.timelineStartFrame +
										prior.durationFrames -
										overlap -
										clip.timelineStartFrame;
								attempt(() =>
									moveCompositionClip(doc, clip.id, {
										timelineStartFrame: clip.timelineStartFrame + shift,
										transitionIn: {
											type: "CROSSFADE",
											durationFrames: overlap,
										},
									}),
								);
							}}
						>
							{c.crossfade}
						</Button>
					</div>
					<fieldset
						className="min-w-0 space-y-2 border-zinc-800 border-t pt-3"
						disabled={disabled}
					>
						<legend className="pt-3 font-medium text-sm">{c.crop}</legend>
						<Button
							size="sm"
							variant="secondary"
							onClick={() =>
								patch({
									videoFit: "FIT",
									cropKeyframes: undefined,
									framing: [
										{
											fromFrame: 0,
											toFrame: clip.durationFrames,
											mode: "FIT",
											origin: "MANUAL",
											manualOverride: true,
										},
									],
								})
							}
						>
							{c.fit}
						</Button>
						{(
							[
								[
									c.cropX,
									rect.x + rect.w / 2,
									(v: number) => crop(v, rect.y + rect.h / 2, zoom),
									0,
									1,
								],
								[
									c.cropY,
									rect.y + rect.h / 2,
									(v: number) => crop(rect.x + rect.w / 2, v, zoom),
									0,
									1,
								],
								[
									c.cropZoom,
									zoom,
									(v: number) =>
										crop(rect.x + rect.w / 2, rect.y + rect.h / 2, v),
									1,
									3,
								],
							] as const
						).map(([label, value, change, min, max]) => (
							<label
								key={label}
								className="flex items-center gap-2 text-xs text-zinc-400"
							>
								<span className="w-32">{label}</span>
								<input
									type="range"
									min={min}
									max={max}
									step={0.01}
									value={value}
									onChange={(event) => change(Number(event.target.value))}
									className="min-w-0 flex-1 accent-emerald-500"
								/>
							</label>
						))}
						<div className="flex flex-wrap gap-2">
							<Button
								size="sm"
								onClick={() =>
									crop(rect.x + rect.w / 2, rect.y + rect.h / 2, zoom, true)
								}
							>
								{c.keyframe}
							</Button>
							<Button
								size="sm"
								variant="ghost"
								onClick={() => patch({ cropKeyframes: undefined })}
							>
								{c.clearKeys}
							</Button>
						</div>
						<p className="text-xs text-zinc-500">
							{c.keys}:{" "}
							{clip.cropKeyframes
								?.map((key) => `${(key.frame / 30).toFixed(2)}s`)
								.join(" · ") || "0"}
						</p>
					</fieldset>
					<details className="space-y-3">
						<summary className="cursor-pointer text-sm">{c.style}</summary>
						<div className="grid grid-cols-2 gap-2">
							{(["x", "y", "w", "h"] as const).map((key, index) =>
								number(
									[c.horizontal, c.vertical, c.width, c.height][index] ?? key,
									(clip.layout ?? { x: 0, y: 0, w: 1, h: 1 })[key],
									(value) =>
										patch({
											layout: {
												...(clip.layout ?? { x: 0, y: 0, w: 1, h: 1 }),
												[key]: value,
											},
										}),
									{
										step: 0.01,
										min: key === "w" || key === "h" ? 0.01 : 0,
										max: 1,
									},
								),
							)}
							{number(
								c.opacity,
								clip.opacity ?? 1,
								(value) => patch({ opacity: value }),
								{ step: 0.05, max: 1 },
							)}
						</div>
					</details>
					<label
						htmlFor={`${controlId}-template`}
						className="block text-xs text-zinc-400"
					>
						{c.template}
						<SelectNative
							id={`${controlId}-template`}
							value={doc.template?.presetId ?? ""}
							disabled={disabled}
							onChange={(event) =>
								attempt(() =>
									applyCompositionTemplate(doc, event.target.value, sources),
								)
							}
						>
							<option value="" disabled>
								—
							</option>
							{COMPOSITION_TEMPLATE_PRESETS.map((preset) => (
								<option key={preset.id} value={preset.id}>
									{preset.id === "portrait-clean"
										? c.portrait
										: preset.id === "landscape-clean"
											? c.landscape
											: c.square}
								</option>
							))}
						</SelectNative>
					</label>
				</div>
			)}
			{tab === "AUDIO" && (
				<div className="space-y-4">
					{clip && (
						<section className="space-y-3 border-zinc-800 border-t pt-3">
							<h2 className="text-sm">
								{c.selected} · {doc.clips.indexOf(clip) + 1}
							</h2>
							<label className="flex items-center gap-2 text-sm">
								<input
									type="checkbox"
									disabled={disabled}
									checked={clip.audio.mode === "MUTE"}
									onChange={(event) =>
										patch({
											audio: {
												...clip.audio,
												mode: event.target.checked ? "MUTE" : "SOURCE",
											},
										})
									}
								/>
								{c.mute}
							</label>
							<div className="grid grid-cols-2 gap-2">
								{number(
									c.gain,
									clip.audio.gainDb ?? 0,
									(value) => patch({ audio: { ...clip.audio, gainDb: value } }),
									{ min: -60, max: 12 },
								)}
								{number(
									c.fadeIn,
									(clip.audio.fadeInFrames ?? 0) / 30,
									(value) => clipFade("fadeInFrames", Math.round(value * 30)),
									{ step: 0.1, max: clip.durationFrames / 30 },
								)}
								{number(
									c.fadeOut,
									(clip.audio.fadeOutFrames ?? 0) / 30,
									(value) => clipFade("fadeOutFrames", Math.round(value * 30)),
									{ step: 0.1, max: clip.durationFrames / 30 },
								)}
							</div>
						</section>
					)}
					{doc.audioTracks?.map((track, index) => {
						const update = (value: Partial<typeof track>) =>
							onChange({
								...doc,
								audioTracks: doc.audioTracks?.map((item) =>
									item.id === track.id ? { ...item, ...value } : item,
								),
							});
						const fade = (
							field: "fadeInFrames" | "fadeOutFrames",
							frames: number,
						) =>
							update({
								fadeWindow: undefined,
								fadeInFrames: Math.min(
									track.durationFrames,
									track.fadeInFrames,
								),
								fadeOutFrames: Math.min(
									track.durationFrames,
									track.fadeOutFrames,
								),
								[field]: frames,
							});
						return (
							<section
								key={track.id}
								className="space-y-3 border-zinc-800 border-t pt-3"
							>
								<h3 className="text-sm">
									{c.audio} {index + 1}
								</h3>
								<div className="grid grid-cols-2 gap-2">
									{number(
										c.start,
										track.timelineStartFrame / 30,
										(value) =>
											update({ timelineStartFrame: Math.round(value * 30) }),
										{ step: 1 / 30, max: 180 },
									)}
									{number(
										c.sourceIn,
										track.sourceInUs / 1_000_000,
										(value) =>
											update({
												sourceInUs: sourceUs(value, track.mediaVersionId),
											}),
										{ step: 1 / 30, max: 3600 },
									)}
									{number(
										c.duration,
										track.durationFrames / 30,
										(value) =>
											update({ durationFrames: Math.round(value * 30) }),
										{ step: 1 / 30, min: 1 / 30, max: 180 },
									)}
									{number(
										c.gain,
										track.gainDb,
										(value) => update({ gainDb: value }),
										{ min: -60, max: 12 },
									)}
									{number(
										c.fadeIn,
										track.fadeInFrames / 30,
										(value) => fade("fadeInFrames", Math.round(value * 30)),
										{ step: 0.1, max: track.durationFrames / 30 },
									)}
									{number(
										c.fadeOut,
										track.fadeOutFrames / 30,
										(value) => fade("fadeOutFrames", Math.round(value * 30)),
										{ step: 0.1, max: track.durationFrames / 30 },
									)}
								</div>
								<label className="flex items-center gap-2 text-xs">
									<input
										type="checkbox"
										disabled={
											disabled ||
											(!track.ducking &&
												(captionCount === 0 ||
													captionCount > COMPOSITION_LIMITS.duckIntervals))
										}
										aria-describedby={
											captionCount > COMPOSITION_LIMITS.duckIntervals
												? `${controlId}-duck-limit-${track.id}`
												: undefined
										}
										checked={Boolean(track.ducking)}
										onChange={(event) =>
											update({
												ducking: event.target.checked
													? {
															source: "CAPTIONS",
															gainDb: -18,
															attackFrames: 3,
															releaseFrames: 6,
															intervals: [],
														}
													: undefined,
											})
										}
									/>
									{c.duck}
								</label>
								{track.ducking && track.ducking.source !== "CAPTIONS" && (
									<p className="text-xs text-zinc-500">{c.duckFixed}</p>
								)}
								{captionCount > COMPOSITION_LIMITS.duckIntervals && (
									<p
										id={`${controlId}-duck-limit-${track.id}`}
										className="text-xs text-zinc-500"
									>
										{c.duckLimit}
									</p>
								)}
								<Button
									size="sm"
									variant="ghost"
									disabled={disabled}
									onClick={() =>
										onChange({
											...doc,
											audioTracks: doc.audioTracks?.filter(
												(item) => item.id !== track.id,
											),
										})
									}
								>
									{c.remove}
								</Button>
							</section>
						);
					})}
				</div>
			)}
			{tab === "TEXT" && <CompositionTextInspector {...props} />}
		</aside>
	);
}

function CompositionTextInspector({
	document: doc,
	frame,
	disabled,
	onChange,
	onUpload,
	onError,
	presentationDisabled,
}: Props) {
	const controlId = useId();
	const c = useCompositionCopy(),
		duration = compositionDurationFrames(doc),
		captionLinked = doc.audioTracks?.some(
			(track) => track.ducking?.source === "CAPTIONS",
		),
		captionLimit = captionLinked
			? COMPOSITION_LIMITS.duckIntervals
			: COMPOSITION_LIMITS.captions,
		end = Math.min(duration, frame + 60);
	const background =
		doc.captionStyle?.backgroundColor ??
		DEFAULT_COMPOSITION_TEXT_STYLE.backgroundColor;
	const backgroundAlpha =
		background.length === 9 ? background.slice(7, 9) : "ff";
	const backgroundOpacity = Math.round(
		(Number.parseInt(backgroundAlpha, 16) / 255) * 100,
	);
	const captionLayout = doc.captionLayout ?? DEFAULT_CAPTION_LAYOUT;
	const bands = doc.presentation?.captionPlacement === "BANDS";
	const captionLanguage = doc.captionDisplayLanguage ?? "ORIGINAL";
	const hasJapanese =
		doc.captions?.some(
			(caption) => resolveCompositionCaptionDisplay(caption, "ja").translated,
		) ?? false;
	return (
		<div className="space-y-4">
			{Boolean(doc.captions?.length) && (
				<Field
					label={c.captionDisplayLanguage}
					htmlFor={`${controlId}-caption-language`}
					help={
						<EditingHelpText>
							<p>{c.captionLanguageHelp}</p>
							<p>{c.captionTranslationCreateHelp}</p>
						</EditingHelpText>
					}
				>
					<SelectNative
						id={`${controlId}-caption-language`}
						value={captionLanguage}
						disabled={disabled}
						onChange={(event) =>
							onChange({
								...doc,
								captionDisplayLanguage:
									event.target.value === "ja" ? "ja" : "ORIGINAL",
							})
						}
					>
						<option value="ORIGINAL">{c.captionOriginal}</option>
						<option value="ja" disabled={!hasJapanese}>
							{c.captionJapanese}
						</option>
					</SelectNative>
				</Field>
			)}
			<Field
				label={c.captionPlacement}
				htmlFor={`${controlId}-caption-placement`}
				help={
					<EditingHelpText>
						<p>{bands ? c.captionBandsSummary : c.captionPlacementHelp}</p>
					</EditingHelpText>
				}
			>
				<SelectNative
					id={`${controlId}-caption-placement`}
					value={doc.presentation?.captionPlacement ?? "LEGACY"}
					disabled={disabled || presentationDisabled}
					onChange={(event) =>
						onChange(
							setCompositionPresentation(doc, {
								captionPlacement:
									event.target.value === "BANDS" ? "BANDS" : "OVERLAY",
							}),
						)
					}
				>
					<option value="LEGACY" disabled>
						{c.keepCaptionPlacement}
					</option>
					<option value="OVERLAY">{c.captionOverlay}</option>
					<option value="BANDS">{c.captionBands}</option>
				</SelectNative>
			</Field>
			{bands && (
				<EditingDetails summary={c.captionBandsDetails}>
					<p>{c.captionBandsLayoutHelp}</p>
					<p>{c.captionBandsHelp}</p>
				</EditingDetails>
			)}
			<div className="flex flex-wrap gap-2">
				<Button
					size="sm"
					disabled={disabled || (doc.captions?.length ?? 0) >= captionLimit}
					onClick={() =>
						onChange({
							...doc,
							captions: [
								...(doc.captions ?? []),
								{
									id: crypto.randomUUID(),
									fromFrame: frame,
									toFrame: end,
									text: c.captionText,
								},
							],
						})
					}
				>
					{c.addCaption}
				</Button>
				<Button
					size="sm"
					variant="secondary"
					disabled={disabled || (doc.overlays?.length ?? 0) >= 32}
					onClick={() =>
						onChange({
							...doc,
							overlays: [
								...(doc.overlays ?? []),
								{
									id: crypto.randomUUID(),
									kind: "TEXT",
									text: c.addTitle,
									fromFrame: frame,
									toFrame: end,
									rect: { x: 0.05, y: 0.05, w: 0.9, h: 0.2 },
									opacity: 1,
									zIndex: 1,
								},
							],
						})
					}
				>
					{c.addTitle}
				</Button>
			</div>
			{captionLinked &&
				(doc.captions?.length ?? 0) >= COMPOSITION_LIMITS.duckIntervals && (
					<p className="text-xs text-zinc-500">{c.duckLimit}</p>
				)}
			<label className="block space-y-2 text-xs text-zinc-400">
				{c.uploadImage}
				<input
					type="file"
					accept="image/png"
					disabled={
						disabled ||
						(doc.imageAssets?.length ?? 0) >= 16 ||
						(doc.overlays?.length ?? 0) >= 32
					}
					onChange={(event) => {
						const file = event.target.files?.[0];
						if (file) void onUpload(file);
						event.target.value = "";
					}}
					className="block max-w-full text-xs"
				/>
				<span className="block">{c.imageHelp}</span>
			</label>
			<fieldset disabled={disabled} className="grid min-w-0 grid-cols-2 gap-3">
				<label htmlFor={`${controlId}-color`} className="text-xs text-zinc-400">
					{c.color}
					<Input
						type="color"
						id={`${controlId}-color`}
						value={doc.captionStyle?.color?.slice(0, 7) ?? "#ffffff"}
						onChange={(event) =>
							onChange({
								...doc,
								captionStyle: {
									...doc.captionStyle,
									color: event.target.value,
								},
							})
						}
					/>
				</label>
				<label
					htmlFor={`${controlId}-emphasis`}
					className="text-xs text-zinc-400"
				>
					{c.emphasis}
					<Input
						type="color"
						id={`${controlId}-emphasis`}
						value={doc.captionStyle?.emphasisColor?.slice(0, 7) ?? "#ffe04b"}
						onChange={(event) =>
							onChange({
								...doc,
								captionStyle: {
									...doc.captionStyle,
									emphasisColor: event.target.value,
								},
							})
						}
					/>
				</label>
				<label
					htmlFor={`${controlId}-background`}
					className="min-w-0 text-xs text-zinc-400"
				>
					{c.captionBackground}
					<Input
						type="color"
						id={`${controlId}-background`}
						value={background.slice(0, 7)}
						onChange={(event) =>
							onChange({
								...doc,
								captionStyle: {
									...doc.captionStyle,
									backgroundColor: `${event.target.value}${backgroundAlpha}`,
								},
							})
						}
					/>
				</label>
				<label
					htmlFor={`${controlId}-background-opacity`}
					className="col-span-2 block min-w-0 space-y-2 text-xs text-zinc-400"
				>
					<span className="flex flex-wrap justify-between gap-2">
						<span>{c.captionBackgroundOpacity}</span>
						<output aria-hidden="true">{backgroundOpacity}%</output>
					</span>
					<input
						id={`${controlId}-background-opacity`}
						type="range"
						aria-label={c.captionBackgroundOpacity}
						min={0}
						max={100}
						step={1}
						value={backgroundOpacity}
						className="block w-full min-w-0 accent-emerald-500"
						onChange={(event) =>
							onChange({
								...doc,
								captionStyle: {
									...doc.captionStyle,
									backgroundColor: `${background.slice(0, 7)}${Math.round(
										(Number(event.target.value) * 255) / 100,
									)
										.toString(16)
										.padStart(2, "0")}`,
								},
							})
						}
					/>
				</label>
				<CompositionNumber
					label={c.captionMaxSize}
					value={doc.captionStyle?.fontSize ?? 0.045}
					min={0.01}
					max={0.25}
					step={0.005}
					onChange={(fontSize) =>
						onChange({
							...doc,
							captionStyle: { ...doc.captionStyle, fontSize },
						})
					}
				/>
			</fieldset>
			{!bands && (
				<fieldset
					disabled={disabled}
					className="grid min-w-0 grid-cols-2 gap-3"
				>
					{(
						[
							["x", c.captionX],
							["y", c.captionY],
							["w", c.captionWidth],
							["h", c.captionHeight],
						] as const
					).map(([key, label]) => (
						<CompositionNumber
							key={key}
							label={label}
							value={captionLayout[key]}
							min={key === "w" || key === "h" ? 0.01 : 0}
							max={1}
							step={0.01}
							onChange={(value) =>
								onChange({
									...doc,
									captionLayout: { ...captionLayout, [key]: value },
								})
							}
						/>
					))}
				</fieldset>
			)}
			<div className="flex items-center gap-1 border-zinc-800 border-t pt-3">
				<h3 className="font-medium text-sm">{c.captions}</h3>
				<EditingHelp label={c.wordTiming}>
					<p>{c.wordHelp}</p>
				</EditingHelp>
			</div>
			{doc.captions?.map((caption, index) => {
				const displayed = resolveCompositionCaptionDisplay(
					caption,
					captionLanguage,
				);
				const update = (value: Partial<typeof caption>) =>
					onChange({
						...doc,
						captions: doc.captions?.map((item) =>
							item.id === caption.id ? { ...item, ...value } : item,
						),
					});
				return (
					<fieldset
						key={caption.id}
						disabled={disabled}
						className="space-y-2 rounded-md border border-zinc-800 p-3"
					>
						<label className="block text-xs text-zinc-400">
							{c.captionText} {index + 1}
							<textarea
								value={displayed.text}
								maxLength={1000}
								className="mt-1 w-full rounded bg-zinc-900 p-2 text-sm text-zinc-100"
								onChange={(event) => {
									try {
										const changed = setCompositionCaptionDisplayText(
											caption,
											captionLanguage,
											event.target.value,
										);
										onChange({
											...doc,
											captions: doc.captions?.map((item) =>
												item.id === caption.id ? changed : item,
											),
										});
									} catch {
										onError();
									}
								}}
							/>
						</label>
						{captionLanguage === "ja" && displayed.staleTranslation && (
							<p className="text-xs text-zinc-500">
								{c.captionTranslationStale}
							</p>
						)}
						<div className="grid grid-cols-2 gap-2">
							<CompositionNumber
								label={c.from}
								value={caption.fromFrame / 30}
								step={1 / 30}
								max={duration / 30}
								onChange={(value) =>
									update({
										fromFrame: Math.round(value * 30),
										words: undefined,
									})
								}
							/>
							<CompositionNumber
								label={c.to}
								value={caption.toFrame / 30}
								step={1 / 30}
								max={duration / 30}
								onChange={(value) =>
									update({ toFrame: Math.round(value * 30), words: undefined })
								}
							/>
						</div>
						{!displayed.translated && caption.words?.length ? (
							<details>
								<summary className="cursor-pointer text-xs text-amber-300">
									{c.wordTiming} · {caption.words.length}
								</summary>
								<div className="space-y-2 pt-2">
									{caption.words.map((word, wordIndex) => (
										<div
											key={`${word.startChar}:${word.endChar}`}
											className="grid grid-cols-3 items-center gap-2 text-xs"
										>
											<span>{word.text}</span>
											<CompositionNumber
												label={c.from}
												value={word.fromFrame / 30}
												step={1 / 30}
												max={duration / 30}
												onChange={(value) =>
													update({
														words: caption.words?.map((item, at) =>
															at === wordIndex
																? { ...item, fromFrame: Math.round(value * 30) }
																: item,
														),
													})
												}
											/>
											<CompositionNumber
												label={c.to}
												value={word.toFrame / 30}
												step={1 / 30}
												max={duration / 30}
												onChange={(value) =>
													update({
														words: caption.words?.map((item, at) =>
															at === wordIndex
																? { ...item, toFrame: Math.round(value * 30) }
																: item,
														),
													})
												}
											/>
										</div>
									))}
								</div>
							</details>
						) : null}
						<Button
							size="sm"
							variant="ghost"
							onClick={() =>
								onChange({
									...doc,
									captions: doc.captions?.filter(
										(item) => item.id !== caption.id,
									),
								})
							}
						>
							{c.remove}
						</Button>
					</fieldset>
				);
			})}
			<h3 className="border-zinc-800 border-t pt-3 font-medium text-sm">
				{c.overlays}
			</h3>
			{doc.overlays?.map((overlay, index) => {
				const update = (value: Partial<typeof overlay>) =>
					onChange({
						...doc,
						overlays: doc.overlays?.map((item) =>
							item.id === overlay.id ? { ...item, ...value } : item,
						),
					} as CompositionDocument);
				return (
					<fieldset
						key={overlay.id}
						disabled={disabled}
						className="space-y-2 rounded-md border border-zinc-800 p-3"
					>
						<p className="text-xs text-zinc-400">
							{c.overlays} {index + 1}
						</p>
						{overlay.kind === "TEXT" && (
							<Input
								aria-label={c.addTitle}
								value={overlay.text}
								maxLength={2000}
								onChange={(event) => update({ text: event.target.value })}
							/>
						)}
						<div className="grid grid-cols-2 gap-2">
							<CompositionNumber
								label={c.from}
								value={overlay.fromFrame / 30}
								step={1 / 30}
								max={duration / 30}
								onChange={(value) =>
									update({ fromFrame: Math.round(value * 30) })
								}
							/>
							<CompositionNumber
								label={c.to}
								value={overlay.toFrame / 30}
								step={1 / 30}
								max={duration / 30}
								onChange={(value) =>
									update({ toFrame: Math.round(value * 30) })
								}
							/>
							{(["x", "y", "w", "h"] as const).map((key, i) => (
								<CompositionNumber
									key={key}
									label={
										[c.horizontal, c.vertical, c.width, c.height][i] ?? key
									}
									value={overlay.rect[key]}
									step={0.01}
									min={key === "w" || key === "h" ? 0.01 : 0}
									max={1}
									onChange={(value) =>
										update({ rect: { ...overlay.rect, [key]: value } })
									}
								/>
							))}
							<CompositionNumber
								label={c.opacity}
								value={overlay.opacity}
								step={0.05}
								max={1}
								onChange={(opacity) => update({ opacity })}
							/>
						</div>
						<Button
							size="sm"
							variant="ghost"
							onClick={() =>
								onChange({
									...doc,
									overlays: doc.overlays?.filter(
										(item) => item.id !== overlay.id,
									),
								})
							}
						>
							{c.remove}
						</Button>
					</fieldset>
				);
			})}
		</div>
	);
}
