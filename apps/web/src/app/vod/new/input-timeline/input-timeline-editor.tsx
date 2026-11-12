"use client";

import { MAX_VOD_TIMELINE_CLIPS } from "@bitovp/core/vod-input-timeline";
import { Button } from "@/components/ui/button";
import { ClipInspector } from "./clip-inspector";
import { EditorToolbar } from "./editor-toolbar";
import { taskErrorText } from "./labels";
import { PreviewMonitor } from "./preview-monitor";
import { SourceBin } from "./source-bin";
import { TimelineTracks } from "./timeline-tracks";
import type { VodInputTimelineEditorProps } from "./types";
import { useInputTimelineWorkbench } from "./use-input-timeline-workbench";

export type {
	InputTimelineReadiness,
	VodInputTimelineEditorProps,
} from "./types";

export function VodInputTimelineEditor(props: VodInputTimelineEditorProps) {
	const { document, sources, onAddSource, disabled = false } = props;
	const w = useInputTimelineWorkbench(props);
	return (
		<section
			ref={w.container}
			tabIndex={-1}
			aria-label={w.l.title}
			className="min-w-0 space-y-3 rounded-md border border-zinc-800 p-3"
			onKeyDown={w.onKeyDown}
		>
			<div className="grid min-w-0 grid-cols-1 gap-3 lg:grid-cols-[minmax(140px,0.8fr)_minmax(0,2fr)_minmax(110px,0.65fr)]">
				<SourceBin
					sources={sources}
					facts={w.state.facts}
					selectedKey={w.mode === "source" ? w.sourceKey : null}
					disabled={disabled || w.dragging}
					full={document.clips.length >= MAX_VOD_TIMELINE_CLIPS}
					onAddSource={onAddSource}
					onAdd={w.add}
					onSelect={w.selectSource}
				/>
				<PreviewMonitor
					task={w.state.preview.ready ?? w.state.preview.previous}
					stale={w.state.preview.stale}
					pending={w.state.probe.pending || w.state.preview.pending}
					mode={w.mode}
					positionMs={
						w.mode === "source" ? w.sourcePosition : w.editor.positionMs
					}
					durationMs={w.previewDurationMs}
					whole={w.whole}
					fullAllowed={w.state.fullAllowed}
					onWhole={w.setWhole}
					onMode={w.setMode}
					onPosition={w.onPlayback}
					onSeek={w.sourceSeek}
					onError={w.mediaError}
				/>
				{w.selected ? (
					<ClipInspector
						key={`${w.selected.id}:${w.selected.inMs}:${w.selected.outMs}`}
						clip={w.selected}
						source={w.state.facts.find(
							(source) => source.key === w.selected?.sourceKey,
						)}
						name={w.names[w.selected.sourceKey] ?? w.selected.sourceKey}
						disabled={disabled || w.dragging}
						onChange={w.changeRange}
						onError={w.invalid}
					/>
				) : (
					<div className="text-xs text-zinc-400">{w.l.addClip}</div>
				)}
			</div>
			<EditorToolbar
				disabled={disabled || w.dragging}
				canUndo={w.editor.canUndo}
				canRedo={w.editor.canRedo}
				canSplit={w.canSplit}
				canMoveEarlier={w.selectedIndex > 0}
				canMoveLater={
					w.selectedIndex >= 0 && w.selectedIndex < document.clips.length - 1
				}
				canDelete={!!w.selected}
				audioEnabled={document.audioEnabled}
				onUndo={w.editor.undo}
				onRedo={w.editor.redo}
				onSplit={w.split}
				onEarlier={() => w.move(-1)}
				onLater={() => w.move(1)}
				onDelete={() => w.selected && w.remove(w.selected.id)}
				onAudio={w.toggleAudio}
			/>
			<TimelineTracks
				document={document}
				facts={w.state.facts}
				names={w.names}
				selectedId={w.editor.selectedId}
				positionMs={w.editor.positionMs}
				disabled={disabled}
				onSelect={w.selectClip}
				onSeek={w.seek}
				onChange={w.commit}
				onDelete={w.remove}
				onError={w.invalid}
				onDragging={w.setDragging}
			/>
			{w.state.probe.pending && (
				<p role="status" className="text-xs text-zinc-400">
					{w.l.preparing}
				</p>
			)}
			{w.error && (
				<div
					role="alert"
					className="flex flex-wrap items-center gap-2 text-xs text-amber-300"
				>
					<span>{taskErrorText(w.error, w.l)}</span>
					{w.canRetry && (
						<Button
							size="sm"
							variant="ghost"
							disabled={disabled || (!w.state.probeError && !w.state.probeId)}
							onClick={w.retry}
						>
							{w.state.probeError ? w.l.retrySources : w.l.retry}
						</Button>
					)}
				</div>
			)}
		</section>
	);
}
