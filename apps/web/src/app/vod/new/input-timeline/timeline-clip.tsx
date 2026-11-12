import type {
	VodInputTimelineClip,
	VodInputTimelineSourceFacts,
} from "@bitovp/core/vod-input-timeline";
import { useTimelineLabels } from "./labels";
import { formatTime } from "./timeline-state";
import type { useTimelineGesture } from "./use-timeline-gesture";

export function TimelineClip({
	clip,
	index,
	name,
	durationMs,
	selected,
	fact,
	disabled,
	helpId,
	handlers,
	consumeClick,
	onSeek,
	onSelect,
	onDelete,
}: {
	clip: VodInputTimelineClip;
	index: number;
	name: string;
	durationMs: number;
	selected: boolean;
	fact: VodInputTimelineSourceFacts | undefined;
	disabled: boolean;
	helpId: string;
	handlers: ReturnType<typeof useTimelineGesture>["handlers"];
	consumeClick: ReturnType<typeof useTimelineGesture>["consumeClick"];
	onSeek: (localMs: number) => void;
	onSelect: (id: string) => void;
	onDelete: (id: string) => void;
}) {
	const l = useTimelineLabels();
	const moveHandlers = handlers(clip.id, "move");
	return (
		<div
			className="relative h-16 min-w-0 shrink-0 py-1"
			style={{ width: `${((clip.outMs - clip.inMs) / durationMs) * 100}%` }}
		>
			<button
				type="button"
				data-clip-id={clip.id}
				aria-label={`${l.clip} ${index + 1}, ${name}`}
				aria-pressed={selected}
				className={`h-full w-full touch-none overflow-hidden border px-3 text-left text-xs focus-visible:outline-2 focus-visible:outline-emerald-300 ${selected ? "border-emerald-400 bg-emerald-950 text-emerald-100" : "border-zinc-600 bg-zinc-800 text-zinc-200"}`}
				{...moveHandlers}
				onKeyDown={(event) => {
					if (event.key === "Delete" || event.key === "Backspace") {
						event.preventDefault();
						if (!disabled) onDelete(clip.id);
					} else moveHandlers.onKeyDown(event);
				}}
				onClick={(event) => {
					if (consumeClick(clip.id)) return;
					onSelect(clip.id);
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
			{selected &&
				(["in", "out"] as const).map((edge) => (
					<div
						key={edge}
						role="slider"
						tabIndex={0}
						aria-orientation="horizontal"
						aria-label={`${edge === "in" ? l.trimStart : l.trimEnd}, ${name}, ${l.clip.toLowerCase()} ${index + 1}`}
						aria-valuemin={edge === "in" ? 0 : clip.inMs + 1}
						aria-valuemax={
							edge === "in" ? clip.outMs - 1 : (fact?.durationMs ?? clip.outMs)
						}
						aria-valuenow={edge === "in" ? clip.inMs : clip.outMs}
						aria-valuetext={formatTime(edge === "in" ? clip.inMs : clip.outMs)}
						aria-disabled={disabled || !fact}
						aria-describedby={helpId}
						className={`absolute top-1 z-10 h-14 w-3 touch-none cursor-ew-resize rounded-sm border border-emerald-300 bg-emerald-600/80 focus-visible:outline-2 focus-visible:outline-emerald-100 ${edge === "in" ? "left-0" : "right-0"}`}
						{...handlers(clip.id, edge)}
					/>
				))}
		</div>
	);
}
