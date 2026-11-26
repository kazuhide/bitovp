import type {
	VodInputTimelinePlacedClip,
	VodInputTimelineSourceFacts,
	VodInputTimelineTrack,
} from "@bitovp/core/vod-input-timeline";
import { useTimelineLabels } from "./labels";
import { availableSourceDuration } from "./source-availability";
import { formatTime } from "./timeline-state";
import type { useTimelineGesture } from "./use-timeline-gesture";

export function TimelineClip({
	clip,
	track,
	index,
	name,
	pixelsPerMs,
	durationMs,
	selected,
	fact,
	disabled,
	muted,
	linked,
	audioEnabled,
	handlers,
	onSeek,
	onSelect,
	onDelete,
}: {
	clip: VodInputTimelinePlacedClip;
	track: VodInputTimelineTrack;
	index: number;
	name: string;
	pixelsPerMs: number;
	durationMs: number;
	selected: boolean;
	fact: VodInputTimelineSourceFacts | undefined;
	disabled: boolean;
	muted?: boolean;
	linked: boolean;
	audioEnabled: boolean;
	handlers: ReturnType<typeof useTimelineGesture>["handlers"];
	onSeek: (localMs: number) => void;
	onSelect: (id: string, track: VodInputTimelineTrack) => void;
	onDelete: (id: string, track: VodInputTimelineTrack) => void;
}) {
	const l = useTimelineLabels(),
		isAudio = track === "audio",
		clipLabel = isAudio ? l.audioClip : l.clip;
	const moveHandlers = handlers(clip.id, "move", track);
	const sourceDuration = fact
		? availableSourceDuration(fact, linked ? "both" : track, audioEnabled)
		: clip.outMs;
	const minimumIn = linked ? 0 : Math.max(0, clip.inMs - clip.startMs);
	const maximumOut = linked
		? sourceDuration
		: Math.min(sourceDuration, clip.inMs + durationMs - clip.startMs);
	const width = (clip.outMs - clip.inMs) * pixelsPerMs;
	const trimDisabled = disabled || !fact?.[track];
	const tone = isAudio
		? selected
			? "border-sky-400 bg-sky-950 text-sky-100"
			: "border-sky-800 bg-sky-950/60 text-sky-200"
		: selected
			? "border-emerald-400 bg-emerald-950 text-emerald-100"
			: "border-zinc-600 bg-zinc-800 text-zinc-200";
	return (
		<div
			className={`group absolute top-0 min-w-0 py-1 ${isAudio ? "h-10" : "h-16"}`}
			style={{
				left: clip.startMs * pixelsPerMs,
				width,
			}}
		>
			<button
				type="button"
				data-clip-id={clip.id}
				data-clip-track={track}
				aria-label={`${clipLabel} ${index + 1}, ${name}`}
				aria-pressed={selected}
				title={linked ? l.dragReorder : l.dragMove}
				aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight Delete Backspace"
				className={`h-full w-full touch-none cursor-grab overflow-hidden border px-3 text-left text-xs active:cursor-grabbing focus-visible:outline-2 focus-visible:outline-emerald-300 ${tone} ${muted ? "opacity-60" : ""}`}
				{...moveHandlers}
				onKeyDown={(event) => {
					if (event.key === "Delete" || event.key === "Backspace") {
						event.preventDefault();
						if (!disabled) onDelete(clip.id, track);
					} else moveHandlers.onKeyDown(event);
				}}
				onClick={(event) => {
					// Captured pointer taps seek from the canvas; native keyboard clicks still activate this clip.
					if (event.detail !== 0 && !disabled) return;
					onSelect(clip.id, track);
					const bounds = event.currentTarget.getBoundingClientRect();
					const fraction =
						event.detail === 0
							? 0
							: (event.clientX - bounds.left) / bounds.width;
					onSeek(
						Math.max(
							0,
							Math.min(
								clip.outMs - clip.inMs - 1,
								Math.round(fraction * (clip.outMs - clip.inMs)),
							),
						),
					);
				}}
			>
				<span className="block truncate" title={name}>
					{name}
				</span>
				<span className="block truncate tabular-nums text-[10px]">
					{formatTime(clip.inMs)} – {formatTime(clip.outMs)}
				</span>
			</button>
			{(selected || width >= 32) &&
				(["in", "out"] as const).map((edge) => {
					const atLimit =
						edge === "in" ? clip.inMs === minimumIn : clip.outMs === maximumOut;
					const hint =
						edge === "in"
							? clip.inMs === 0
								? l.sourceStart
								: atLimit
									? l.sequenceStart
									: l.trimStart
							: clip.outMs === sourceDuration
								? l.sourceEnd
								: atLimit
									? l.sequenceEnd
									: l.trimEnd;
					return (
						<div
							key={edge}
							role="slider"
							tabIndex={selected && !trimDisabled ? 0 : -1}
							aria-hidden={!selected}
							title={hint}
							aria-orientation="horizontal"
							aria-label={`${edge === "in" ? l.trimStart : l.trimEnd}, ${name}, ${clipLabel.toLowerCase()} ${index + 1}`}
							aria-valuemin={edge === "in" ? minimumIn : clip.inMs + 1}
							aria-valuemax={edge === "in" ? clip.outMs - 1 : maximumOut}
							aria-valuenow={edge === "in" ? clip.inMs : clip.outMs}
							aria-valuetext={formatTime(
								edge === "in" ? clip.inMs : clip.outMs,
							)}
							aria-disabled={trimDisabled}
							aria-keyshortcuts="ArrowLeft ArrowRight Shift+ArrowLeft Shift+ArrowRight Home End"
							className={`absolute top-1 z-10 w-3 touch-none rounded-sm border focus-visible:outline-2 focus-visible:outline-emerald-100 ${isAudio ? "h-8 border-sky-300 bg-sky-600/80" : "h-14 border-emerald-300 bg-emerald-600/80"} ${edge === "in" ? "left-0" : "right-0"} ${atLimit ? (edge === "in" ? "cursor-e-resize" : "cursor-w-resize") : "cursor-ew-resize"} ${selected ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"} ${trimDisabled ? "pointer-events-none" : ""}`}
							{...handlers(clip.id, edge, track)}
						/>
					);
				})}
		</div>
	);
}
