"use client";

import {
	type CompositionClip,
	type CompositionDocument,
	type CompositionSourceFacts,
	compositionUsesMainPresentation,
	compositionVideoFit,
	type NormalizedCropRect,
	resolvePresentedCompositionGeometry,
	type ShotCropCandidate,
	shotCropCandidates,
} from "@bitovp/core";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
	AnyEditingProjectView,
	EditingMediaView,
} from "@/lib/library-editing";
import { EditingHelp } from "../../editing-help";
import { useCompositionCopy } from "./composition-copy";
import type {
	CompositionSourceFrame,
	CompositionSourceFrameReader,
} from "./composition-source-frame";

export type CropCandidateContext = {
	media: EditingMediaView;
	analysis: AnyEditingProjectView["analysis"];
};

/** AISA positions are usable only for the exact server-owned primary-source tuple. */
export function cropCandidateSubjects(
	document: CompositionDocument,
	clip: CompositionClip,
	source: CompositionSourceFacts,
	context?: CropCandidateContext,
) {
	const binding = document.autoGeneration?.binding,
		analysis = context?.analysis,
		media = context?.media,
		map = source.timeMap;
	if (
		(document.presentation?.fallbackFraming !== "AISA_STATIC_V1" &&
			document.presentation?.fallbackFraming !== "PRESERVE_SOURCE_V1") ||
		!binding ||
		!analysis ||
		!media?.timeMap ||
		binding.kind === "FIXTURE_AUTHORED" ||
		(clip.mediaVersionId ?? document.mediaVersionId) !==
			document.mediaVersionId ||
		document.mediaVersionId !== media.id ||
		source.mediaVersionId !== media.id ||
		binding.mediaVersionId !== media.id ||
		binding.sourceId !== media.sourceId ||
		document.analysisRevisionId !== analysis.id ||
		binding.analysisRevisionId !== analysis.id ||
		document.locale !== analysis.locale ||
		binding.locale !== analysis.locale ||
		document.timeMapId !== map.id ||
		binding.timeMapId !== map.id ||
		media.timeMap.id !== map.id ||
		map.mediaVersionId !== media.id ||
		binding.width !== source.width ||
		binding.height !== source.height ||
		media.width !== source.width ||
		media.height !== source.height ||
		binding.sourceStartUs !== map.sourceStartUs ||
		binding.sourceEndUs !== map.sourceEndUs ||
		media.timeMap.sourceStartUs !== map.sourceStartUs ||
		media.timeMap.sourceEndUs !== map.sourceEndUs ||
		clip.evidence?.shotIndex === undefined
	)
		return undefined;
	return analysis.document.scenes.find(
		(scene) => scene.id === clip.evidence?.sceneId,
	)?.shots[clip.evidence.shotIndex]?.mainSubjects;
}
const sameCrop = (a: NormalizedCropRect | undefined, b: NormalizedCropRect) =>
	a !== undefined &&
	(["x", "y", "w", "h"] as const).every(
		(key) => Math.abs(a[key] - b[key]) < 1e-9,
	);
type Props = {
	document: CompositionDocument;
	clip: CompositionClip;
	source: CompositionSourceFacts;
	context?: CropCandidateContext;
	frame: number;
	expectedSourceFrame?: number;
	frameReader?: CompositionSourceFrameReader | null;
	frameRevision: number;
	disabled: boolean;
	onChange(document: CompositionDocument): void;
};
export function CropCandidates(props: Props) {
	const { document, clip } = props;
	if (
		!compositionUsesMainPresentation(document, clip) ||
		compositionVideoFit(document, clip) !== "FILL" ||
		!clip.framing.some((part) => part.mode === "FIT")
	)
		return null;
	return <CropCandidateChoices {...props} />;
}
function CropCandidateChoices({
	document,
	clip,
	source,
	context,
	frame,
	expectedSourceFrame,
	frameReader,
	frameRevision,
	disabled,
	onChange,
}: Props) {
	const c = useCompositionCopy(),
		mediaVersionId = clip.mediaVersionId ?? document.mediaVersionId;
	const subjects = useMemo(
		() => cropCandidateSubjects(document, clip, source, context),
		[document, clip, source, context],
	);
	const candidates = useMemo(
		() =>
			shotCropCandidates({
				sourceWidth: source.width,
				sourceHeight: source.height,
				targetWidth: document.canvas.width,
				targetHeight: document.canvas.height,
				mainSubjects: subjects,
			}),
		[document.canvas, source.width, source.height, subjects],
	);
	const key = `${clip.id}:${mediaVersionId}:${frame}:${expectedSourceFrame ?? "inactive"}:${frameRevision}:${source.width}:${source.height}`;
	const [preview, setPreview] = useState<{
		key: string;
		image: CompositionSourceFrame | null;
		state: "pending" | "unavailable" | "ready";
	}>({ key: "", image: null, state: "pending" });
	useEffect(() => {
		const image = frameReader?.(clip.id) ?? null;
		const valid =
			image &&
			image.clipId === clip.id &&
			image.mediaVersionId === mediaVersionId &&
			image.sourceFrame === expectedSourceFrame &&
			image.width === source.width &&
			image.height === source.height &&
			image.image.width === source.width &&
			image.image.height === source.height;
		setPreview({
			key,
			image: valid ? image : null,
			state: valid ? "ready" : frameReader ? "unavailable" : "pending",
		});
	}, [
		key,
		frameReader,
		clip.id,
		mediaVersionId,
		expectedSourceFrame,
		source.width,
		source.height,
	]);
	// A new clip/frame never renders the previous request's image, even before effects run.
	const image = preview.key === key ? preview.image : null,
		state = preview.key === key ? preview.state : "pending";
	let aisaIndex = 0;
	const select = (candidate: ShotCropCandidate) => {
		if (disabled || !image || sameCrop(clip.fallbackCrop, candidate.rect))
			return;
		onChange({
			...document,
			presentation: {
				version: "portrait-layout-v1",
				captionPlacement: "OVERLAY",
				...document.presentation,
				centerCropConfirmed: false,
			},
			clips: document.clips.map((item) =>
				item.id === clip.id
					? { ...item, fallbackCrop: { ...candidate.rect } }
					: item,
			),
		});
	};
	return (
		<section
			className="min-w-0 space-y-3 border-zinc-800 border-t pt-3"
			aria-label={c.cropCandidates}
			data-preview-state={state}
		>
			<div className="flex items-center gap-1">
				<h3 className="font-medium text-sm">{c.cropCandidates}</h3>
				<EditingHelp label={c.cropCandidates}>
					<p>{c.cropCandidatesHelp}</p>
					<p>{c.cropTrackedHelp}</p>
				</EditingHelp>
			</div>
			<p className="text-pretty text-xs leading-relaxed text-zinc-400">
				{state === "ready"
					? c.cropCurrentFrame
					: state === "pending"
						? c.cropFramePending
						: c.cropFrameUnavailable}
			</p>
			<div className="flex min-w-0 gap-2 overflow-x-auto pb-2">
				{candidates.map((candidate) => {
					const label =
						candidate.kind === "AISA"
							? c.cropAisa.replace("{number}", String(++aisaIndex))
							: candidate.id === "left"
								? c.cropLeft
								: candidate.id === "right"
									? c.cropRight
									: c.cropCenter;
					return (
						<CropCandidateCard
							key={candidate.id}
							candidate={candidate}
							label={label}
							box={subjects?.[candidate.subjectIndex ?? -1]?.box2d}
							source={source}
							document={document}
							clip={clip}
							image={image}
							previewKey={key}
							active={sameCrop(clip.fallbackCrop, candidate.rect)}
							disabled={disabled}
							onSelect={() => select(candidate)}
						/>
					);
				})}
			</div>
		</section>
	);
}
function CropCandidateCard({
	candidate,
	label,
	box,
	source,
	document,
	clip,
	image,
	previewKey,
	active,
	disabled,
	onSelect,
}: {
	candidate: ShotCropCandidate;
	label: string;
	box?: readonly [number, number, number, number];
	source: CompositionSourceFacts;
	document: CompositionDocument;
	clip: CompositionClip;
	image: CompositionSourceFrame | null;
	previewKey: string;
	active: boolean;
	disabled: boolean;
	onSelect(): void;
}) {
	const canvas = useRef<HTMLCanvasElement>(null),
		c = useCompositionCopy();
	const width = 160,
		height = Math.max(
			1,
			Math.round((160 * document.canvas.height) / document.canvas.width),
		);
	const geometry = useMemo(() => {
		try {
			// Compare a FIT interval with the same resolver and source pixels as the image.
			const previewClip: CompositionClip = {
				...clip,
				videoFit: "FILL",
				fallbackCrop: candidate.rect,
				cropKeyframes: undefined,
				framing: [
					{
						fromFrame: 0,
						toFrame: clip.durationFrames,
						mode: "FIT",
						origin: "MANUAL",
					},
				],
			};
			return resolvePresentedCompositionGeometry({
				document,
				clip: previewClip,
				sourceWidth: source.width,
				sourceHeight: source.height,
				width,
				height,
				frame: 0,
			});
		} catch {
			return null;
		}
	}, [document, clip, candidate.rect, source.width, source.height, height]);
	let displayedCoverage: ShotCropCandidate["coverage"] = "UNKNOWN";
	if (box && geometry) {
		const rect = geometry.sourceRect,
			left = (box[1] * source.width) / 1000,
			top = (box[0] * source.height) / 1000,
			right = (box[3] * source.width) / 1000,
			bottom = (box[2] * source.height) / 1000;
		displayedCoverage =
			rect.x <= left + 1e-7 &&
			rect.y <= top + 1e-7 &&
			rect.x + rect.w >= right - 1e-7 &&
			rect.y + rect.h >= bottom - 1e-7
				? "FULL"
				: "PARTIAL";
	}
	const coverage =
		candidate.kind !== "AISA"
			? ""
			: displayedCoverage === "PARTIAL"
				? c.cropPartial
				: displayedCoverage === "FULL"
					? c.cropFull
					: c.cropPositionOnly;
	const [painted, setPainted] = useState({ key: "", ready: false });
	useLayoutEffect(() => {
		const target = canvas.current;
		if (!image || !target) return;
		try {
			const context = target.getContext("2d");
			if (!context || !geometry) throw Error("Canvas unavailable");
			target.width = width;
			target.height = height;
			context.clearRect(0, 0, target.width, target.height);
			context.fillStyle = "#09090b";
			context.fillRect(0, 0, target.width, target.height);
			const s = geometry.sourceRect,
				d = geometry.drawRect;
			context.drawImage(image.image, s.x, s.y, s.w, s.h, d.x, d.y, d.w, d.h);
			setPainted({ key: previewKey, ready: true });
		} catch {
			setPainted({ key: previewKey, ready: false });
		}
	}, [image, previewKey, geometry, height]);
	const ready = image !== null && painted.key === previewKey && painted.ready;
	return (
		<button
			type="button"
			data-crop-candidate={candidate.id}
			data-crop-kind={candidate.kind}
			data-preview-state={
				ready
					? "ready"
					: image && painted.key === previewKey
						? "unavailable"
						: "pending"
			}
			data-source-frame={image?.sourceFrame}
			aria-pressed={active}
			disabled={disabled || !ready}
			onClick={onSelect}
			className={`w-28 shrink-0 space-y-2 rounded-md border p-2 text-left text-xs disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-emerald-500 ${active ? "border-emerald-400 bg-emerald-950/30" : "border-zinc-700 bg-zinc-900"}`}
		>
			{image ? (
				<canvas
					ref={canvas}
					aria-hidden="true"
					tabIndex={-1}
					className="h-auto w-full rounded bg-zinc-950"
				/>
			) : (
				<div
					aria-hidden="true"
					className="flex aspect-[9/16] items-center justify-center rounded bg-zinc-950 text-zinc-500"
				>
					{c.cropNoImage}
				</div>
			)}
			<span className="block whitespace-nowrap font-medium">{label}</span>
			{coverage && (
				<span
					className={`block text-pretty leading-relaxed ${displayedCoverage === "PARTIAL" ? "text-amber-300" : "text-zinc-400"}`}
				>
					{coverage}
				</span>
			)}
		</button>
	);
}
