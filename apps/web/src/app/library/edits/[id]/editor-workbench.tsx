"use client";

import {
	type EditDocument,
	type HighlightCandidate,
	MAX_EDIT_DURATION_FRAMES,
} from "@bitovp/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n/context";
import type { EditingProjectView } from "@/lib/library-editing";
import {
	changeClipRange,
	moveClip,
	reflowClips,
	removeClip,
	replaceClip,
	shotFramingForClip,
	splitClip,
} from "../edit-model";
import { timelinePoint } from "../timeline-model";
import { CandidatePanel } from "./candidate-panel";
import { ClipControls } from "./clip-controls";
import { LiveCompositionPreview } from "./live-composition-preview";
import { RenderPanel } from "./render-panel";
import { TimelineActions } from "./timeline-actions";
import { VisualTimeline } from "./visual-timeline";

export function EditorWorkbench({
	project,
	document,
	disabled,
	rangePending,
	onChange,
	onRangePending,
	onCandidates,
	onAddCandidate,
	onGenerate,
	onCancel,
	generationDisabled,
}: {
	project: EditingProjectView;
	document: EditDocument;
	disabled: boolean;
	rangePending: boolean;
	onChange: (next: EditDocument) => void;
	onRangePending: (id: string, pending: boolean) => void;
	onCandidates: (
		query: string,
		sceneId: string,
		targetFrames: number,
	) => Promise<HighlightCandidate[]>;
	onAddCandidate: (candidate: HighlightCandidate) => void;
	onGenerate: (kind: "PREVIEW" | "EXPORT") => void;
	onCancel: (id: string) => void;
	generationDisabled: boolean;
}) {
	const { t } = useT();
	const video = useRef<HTMLVideoElement>(null);
	const sourceDetails = useRef<HTMLDetailsElement>(null);
	const inspectedDocument = useRef<EditDocument | null>(null);
	const [timelinePending, setTimelinePending] = useState(false);
	const [pauseSignal, setPauseSignal] = useState(0);
	const [seekSignal, setSeekSignal] = useState(0);
	const [coordinatesConfirmed, setCoordinatesConfirmed] = useState(false);
	const [cursorFrame, setCursorFrame] = useState(0);
	const [selectedClipId, setSelectedClipId] = useState<string | null>(
		document.clips[0]?.id ?? null,
	);
	const total = document.clips.reduce(
		(sum, clip) => sum + clip.durationFrames,
		0,
	);
	const map = project.media.timeMap;
	const inspection = map ? timelinePoint(document, cursorFrame, map) : null;
	const selectedFrame = inspection?.frame ?? 0;
	const sourceSeconds = inspection?.sourceSeconds;
	const selectedClip = document.clips[inspection?.index ?? 0];
	const selectedFraming =
		selectedClip?.framing[inspection?.part ?? 0] ?? selectedClip?.framing[0];
	const rect = selectedFraming?.mode === "CROP" ? selectedFraming.rect : null;
	const foundSelection = document.clips.findIndex(
		(clip) => clip.id === selectedClipId,
	);
	const editingIndex =
		foundSelection >= 0 ? foundSelection : (inspection?.index ?? 0);
	const pending = rangePending || timelinePending;
	const previewOutdated = useMemo(
		() =>
			!project.currentRevisionMatchesDraft ||
			JSON.stringify(document) !== JSON.stringify(project.draft),
		[document, project.draft, project.currentRevisionMatchesDraft],
	);
	const synchronizeSource = useCallback(() => {
		const element = video.current;
		if (!element || sourceSeconds === undefined) return;
		if (!element.paused) element.pause();
		if (element.currentTime !== sourceSeconds)
			element.currentTime = sourceSeconds;
	}, [sourceSeconds]);
	useEffect(() => {
		// A new edit can remap the same output frame to another source/shot.
		// Native source playback and unrelated polling do not drive this effect.
		if (inspectedDocument.current !== document) {
			inspectedDocument.current = document;
			synchronizeSource();
		}
		setCursorFrame(selectedFrame);
	}, [document, selectedFrame, synchronizeSource]);
	function inspect(index: number, part: number) {
		const clip = document.clips[index];
		const frame = clip?.framing[part];
		if (clip && frame) seek(clip.timelineStartFrame + frame.fromFrame);
	}
	function seek(frame: number) {
		const map = project.media.timeMap;
		if (!map) return;
		const point = timelinePoint(document, frame, map);
		setSeekSignal((signal) => signal + 1);
		setCursorFrame(point.frame);
		if (!pending) setSelectedClipId(document.clips[point.index]?.id ?? null);
		if (video.current) {
			video.current.pause();
			video.current.currentTime = point.sourceSeconds;
		}
	}
	function selectClip(id: string) {
		if (!pending) setSelectedClipId(id);
	}
	function playbackFrame(frame: number) {
		setCursorFrame(frame);
		if (video.current && !video.current.paused) video.current.pause();
		if (sourceDetails.current?.open && video.current && map) {
			video.current.currentTime = timelinePoint(
				document,
				frame,
				map,
			).sourceSeconds;
		}
	}
	function add() {
		const frames = Math.min(
			900,
			MAX_EDIT_DURATION_FRAMES - total,
			Math.floor(((project.media.durationUs ?? 0) * 30) / 1_000_000),
		);
		if (disabled || pending || document.clips.length >= 20 || frames < 1)
			return;
		onChange(
			reflowClips(document, [
				...document.clips,
				{
					id: crypto.randomUUID(),
					sourceInUs: 0,
					durationFrames: frames,
					timelineStartFrame: 0,
					framing: [
						{ fromFrame: 0, toFrame: frames, mode: "FIT", origin: "MANUAL" },
					],
					audio: { mode: "SOURCE" },
				},
			]),
		);
	}
	function shotSuggestions() {
		if (
			disabled ||
			pending ||
			!coordinatesConfirmed ||
			!project.analysis ||
			!project.media.timeMap ||
			!project.media.width ||
			!project.media.height
		)
			return;
		const sourceStartUs = project.media.timeMap.sourceStartUs;
		onChange({
			...document,
			clips: document.clips.map((clip) => ({
				...clip,
				framing: shotFramingForClip(
					clip,
					project.analysis?.document.scenes.flatMap((scene) => scene.shots) ??
						[],
					{
						sourceWidth: project.media.width ?? 0,
						sourceHeight: project.media.height ?? 0,
						targetWidth: document.canvas.width,
						targetHeight: document.canvas.height,
					},
					true,
					sourceStartUs,
				),
			})),
		});
	}
	return (
		<div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-12">
			<div className="order-2 min-w-0 space-y-4 xl:order-1 xl:col-span-3">
				<CandidatePanel
					project={project}
					disabled={disabled || pending}
					remainingFrames={MAX_EDIT_DURATION_FRAMES - total}
					onFind={onCandidates}
					onAdd={onAddCandidate}
				/>
				{project.analysis && (
					<div className="space-y-2 rounded-md border border-zinc-800 p-3">
						<p className="text-xs text-zinc-400">
							{t("editing.proposalNotice")}
						</p>
						<label className="flex items-start gap-2 text-sm">
							<input
								type="checkbox"
								checked={coordinatesConfirmed}
								disabled={disabled}
								onChange={(e) => setCoordinatesConfirmed(e.target.checked)}
							/>
							{t("editing.coordinateConfirm")}
						</label>
						<Button
							size="sm"
							variant="secondary"
							disabled={
								disabled ||
								pending ||
								!coordinatesConfirmed ||
								!project.media.timeMap
							}
							onClick={shotSuggestions}
						>
							{t("editing.shotProposal")}
						</Button>
					</div>
				)}
				<RenderPanel
					project={project}
					disabled={disabled}
					generationDisabled={generationDisabled}
					onGenerate={onGenerate}
					onCancel={onCancel}
					previewOutdated={previewOutdated}
				/>
			</div>
			<section className="order-1 min-w-0 space-y-4 xl:order-2 xl:col-span-9">
				<LiveCompositionPreview
					document={document}
					media={project.media}
					frame={selectedFrame}
					onFrameChange={playbackFrame}
					blocked={pending}
					pauseSignal={pauseSignal}
					seekSignal={seekSignal}
				/>
				<details
					ref={sourceDetails}
					className="rounded-md border border-zinc-800 p-3"
					onToggle={(event) => {
						if (event.currentTarget.open) synchronizeSource();
					}}
				>
					<summary className="cursor-pointer text-sm text-zinc-300">
						{t("editing.sourceInspect")}
					</summary>
					<div className="mt-3 space-y-3">
						<h2 className="font-semibold">{t("editing.source")}</h2>
						{project.media.url ? (
							<div
								className="relative overflow-hidden rounded-lg border border-zinc-800 bg-black"
								style={{
									aspectRatio: `${project.media.width ?? 16}/${project.media.height ?? 9}`,
								}}
							>
								<video
									ref={video}
									controls
									muted
									playsInline
									preload="metadata"
									src={project.media.url}
									className="h-full w-full"
									aria-label={t("editing.source")}
									onLoadedMetadata={synchronizeSource}
									onPlay={() => setPauseSignal((signal) => signal + 1)}
								/>
								{rect && (
									<div
										aria-hidden="true"
										className="pointer-events-none absolute border-2 border-emerald-400"
										style={{
											left: `${rect.x * 100}%`,
											top: `${rect.y * 100}%`,
											width: `${rect.w * 100}%`,
											height: `${rect.h * 100}%`,
										}}
									/>
								)}
							</div>
						) : (
							<p role="status" className="text-sm text-zinc-400">
								{t("editing.noSource")}
							</p>
						)}
						<p className="text-xs text-zinc-400">{t("editing.sourceHelp")}</p>
					</div>
				</details>
				<div className="flex items-center justify-between gap-3">
					<h2 className="font-semibold">{t("editing.timeline")}</h2>
					<Button
						size="sm"
						variant="secondary"
						disabled={
							disabled ||
							document.clips.length >= 20 ||
							total >= MAX_EDIT_DURATION_FRAMES
						}
						onClick={add}
					>
						{t("editing.add")}
					</Button>
				</div>
				<p className="text-sm text-zinc-400">
					{t("editing.duration", {
						seconds: (total / 30).toFixed(2),
						frames: total,
					})}
				</p>
				<VisualTimeline
					document={document}
					map={project.media.timeMap}
					positionFrame={selectedFrame}
					selectedClipId={selectedClipId}
					disabled={disabled}
					rangePending={rangePending}
					onSeek={seek}
					onSelectClip={selectClip}
					onChange={onChange}
					onPending={(id, value) => {
						setTimelinePending(value);
						onRangePending(id, value);
					}}
				/>
				<TimelineActions
					document={document}
					map={map}
					positionFrame={selectedFrame}
					selectedClipId={document.clips[editingIndex]?.id ?? null}
					blocked={disabled || pending}
					selectionDisabled={pending}
					onChange={onChange}
					onSelectClip={selectClip}
				/>
				<ol className="space-y-3">
					{document.clips.map((clip, index) => (
						<li key={clip.id} hidden={index !== editingIndex}>
							<ClipControls
								clip={clip}
								index={index}
								count={document.clips.length}
								media={project.media}
								canvas={document.canvas}
								disabled={disabled}
								onChange={(next) =>
									onChange(replaceClip(document, index, next))
								}
								onRange={(from, to) =>
									onChange(
										changeClipRange(
											document,
											index,
											from,
											to,
											project.media.durationUs ?? 0,
											project.media.timeMap?.sourceStartUs ?? 0,
										),
									)
								}
								onSplit={(atFrame) => {
									if (project.media.timeMap)
										onChange(
											splitClip(
												document,
												index,
												atFrame,
												crypto.randomUUID(),
												project.media.timeMap,
											),
										);
								}}
								onPending={onRangePending}
								onMove={(direction) =>
									onChange(moveClip(document, index, direction))
								}
								onRemove={() => onChange(removeClip(document, index))}
								onInspect={(part) => inspect(index, part)}
							/>
						</li>
					))}
				</ol>
			</section>
		</div>
	);
}
