import { useTimelineLabels } from "./labels";
import { formatTime } from "./timeline-state";

export function TimelineRuler({
	durationMs,
	positionMs,
	pixelsPerMs,
	ticks,
	disabled,
	onSeek,
}: {
	durationMs: number;
	positionMs: number;
	pixelsPerMs: number;
	ticks: number[];
	disabled: boolean;
	onSeek: (positionMs: number) => void;
}) {
	const l = useTimelineLabels();
	const maximum = Math.max(0, durationMs - 1);
	function seek(value: number) {
		if (!disabled) onSeek(Math.max(0, Math.min(maximum, Math.round(value))));
	}
	return (
		<div
			role="slider"
			tabIndex={disabled ? -1 : 0}
			aria-label={l.ruler}
			aria-orientation="horizontal"
			aria-valuemin={0}
			aria-valuemax={maximum}
			aria-valuenow={Math.min(positionMs, maximum)}
			aria-valuetext={formatTime(positionMs)}
			aria-disabled={disabled}
			className="relative h-7 cursor-crosshair border-zinc-800 border-b text-[10px] text-zinc-400 hover:bg-zinc-800/25 focus-visible:outline-2 focus-visible:outline-emerald-300"
			onClick={(event) => {
				if (disabled) return;
				event.currentTarget.focus();
				seek(
					(event.clientX - event.currentTarget.getBoundingClientRect().left) /
						pixelsPerMs,
				);
			}}
			onKeyDown={(event) => {
				const amount = event.shiftKey ? 10_000 : 1000;
				const value = {
					ArrowLeft: positionMs - amount,
					ArrowRight: positionMs + amount,
					Home: 0,
					End: maximum,
				}[event.key];
				if (value === undefined) return;
				event.preventDefault();
				seek(value);
			}}
		>
			{ticks.map((value) => (
				<span
					key={value}
					aria-hidden="true"
					className="pointer-events-none absolute bottom-1 whitespace-nowrap border-zinc-700 border-l pl-1 tabular-nums"
					style={{ left: value * pixelsPerMs }}
				>
					{formatTime(value)}
				</span>
			))}
		</div>
	);
}
