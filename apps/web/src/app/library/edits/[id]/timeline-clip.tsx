import type { CfrTimeMap, EditClip } from "@bitovp/core";
import { useT } from "@/lib/i18n/context";
import { clipSourceFrame, timelineTimecode } from "../timeline-model";
import type { useTimelineTrim } from "./use-timeline-trim";

export function TimelineClip({
	clip,
	index,
	total,
	selected,
	map,
	mutationDisabled,
	helpId,
	onSeek,
	trimHandlers,
}: {
	clip: EditClip;
	index: number;
	total: number;
	selected: boolean;
	map: CfrTimeMap | null;
	mutationDisabled: boolean;
	helpId: string;
	onSeek: (frame: number) => void;
	trimHandlers: ReturnType<typeof useTimelineTrim>["trimHandlers"];
}) {
	const { t } = useT();
	return (
		<div
			className="relative min-w-0 shrink-0 py-2"
			style={{ width: `${(clip.durationFrames / total) * 100}%` }}
		>
			<button
				type="button"
				aria-label={t("editing.timelineSelect", { number: index + 1 })}
				aria-pressed={selected}
				className={`h-full w-full overflow-hidden border px-3 text-left text-xs focus-visible:outline-2 focus-visible:outline-emerald-400 ${selected ? "border-emerald-400 bg-emerald-950 text-emerald-100" : "border-zinc-600 bg-zinc-800 text-zinc-200"}`}
				disabled={!map}
				onClick={(event) => {
					const bounds = event.currentTarget.getBoundingClientRect();
					const local =
						event.detail === 0 && event.clientX === 0
							? 0
							: Math.floor(
									((event.clientX - bounds.left) / bounds.width) *
										clip.durationFrames,
								);
					onSeek(
						clip.timelineStartFrame +
							Math.max(0, Math.min(clip.durationFrames - 1, local)),
					);
				}}
			>
				<span className="block truncate">
					{t("editing.range", { number: index + 1 })}
				</span>
				<span className="block truncate tabular-nums">
					{timelineTimecode(clip.durationFrames)}
				</span>
			</button>
			{selected &&
				map &&
				(["IN", "OUT"] as const).map((edge) => {
					const start = clipSourceFrame(clip, map);
					const value = edge === "IN" ? start : start + clip.durationFrames;
					return (
						<div
							key={edge}
							role="slider"
							tabIndex={0}
							aria-orientation="horizontal"
							aria-label={t(
								edge === "IN"
									? "editing.timelineTrimIn"
									: "editing.timelineTrimOut",
								{ number: index + 1 },
							)}
							aria-valuemin={edge === "IN" ? 0 : start + 1}
							aria-valuemax={
								edge === "IN"
									? start + clip.durationFrames - 1
									: map.editingEndFrame - map.editingStartFrame
							}
							aria-valuenow={value}
							aria-valuetext={timelineTimecode(value)}
							aria-disabled={mutationDisabled}
							aria-describedby={helpId}
							className={`absolute top-2 z-10 h-12 w-3 touch-none cursor-ew-resize rounded-sm border border-emerald-300 bg-emerald-500/80 focus-visible:outline-2 focus-visible:outline-white ${edge === "IN" ? "left-0" : "right-0"}`}
							{...trimHandlers(index, edge)}
						/>
					);
				})}
		</div>
	);
}
