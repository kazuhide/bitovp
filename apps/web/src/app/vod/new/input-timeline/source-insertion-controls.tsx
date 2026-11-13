"use client";
import type { VodInputTimelinePlacedClip } from "@bitovp/core/vod-input-timeline";
import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { taskErrorText, useTimelineLabels } from "./labels";
import { formatTime } from "./timeline-state";

export function SourceInsertionControls({
	availableDurationMs,
	range,
	targetLabel,
	selected,
	appendPositionMs,
	canAppend,
	canReplace,
	error,
	disabled,
	onRange,
	onAppend,
	onReplace,
	onInvalid,
}: {
	availableDurationMs: number;
	range: { inMs: number; outMs: number };
	targetLabel: string;
	selected: VodInputTimelinePlacedClip | undefined;
	appendPositionMs: number;
	canAppend: boolean;
	canReplace: boolean;
	error: string | null;
	disabled: boolean;
	onRange: (inMs: number, outMs: number) => void;
	onAppend: () => void;
	onReplace: () => void;
	onInvalid: () => void;
}) {
	const l = useTimelineLabels(),
		id = useId();
	const [values, setValues] = useState({
		inMs: String(range.inMs / 1000),
		outMs: String(range.outMs / 1000),
	});
	const [invalid, setInvalid] = useState(false);
	const inMs = Math.round(Number(values.inMs) * 1000);
	const outMs = Math.round(Number(values.outMs) * 1000);
	const draftValid =
		!!values.inMs.trim() &&
		!!values.outMs.trim() &&
		Number.isFinite(inMs) &&
		Number.isFinite(outMs) &&
		inMs >= 0 &&
		outMs > inMs &&
		outMs <= availableDurationMs;
	useEffect(() => {
		setValues({
			inMs: String(range.inMs / 1000),
			outMs: String(range.outMs / 1000),
		});
		setInvalid(false);
	}, [range.inMs, range.outMs]);
	function commit() {
		if (!draftValid) {
			setInvalid(true);
			onInvalid();
			return;
		}
		setInvalid(false);
		onRange(inMs, outMs);
	}
	return (
		<section
			aria-label={l.sourceRange}
			className="mt-3 space-y-2 border-zinc-800 border-t pt-3"
		>
			<div className="grid grid-cols-2 gap-2">
				{(["inMs", "outMs"] as const).map((field) => (
					<Field
						key={field}
						label={field === "inMs" ? l.sourceIn : l.sourceOut}
						htmlFor={id + field}
					>
						<Input
							id={id + field}
							type="number"
							inputMode="decimal"
							min={0}
							max={availableDurationMs / 1000}
							step="0.001"
							className="h-8 tabular-nums"
							disabled={disabled}
							aria-invalid={invalid}
							value={values[field]}
							onChange={(event) => {
								setValues({ ...values, [field]: event.target.value });
								setInvalid(false);
							}}
							onBlur={commit}
							onKeyDown={(event) => {
								if (event.key === "Enter") {
									event.preventDefault();
									commit();
								}
								if (event.key === "Escape") {
									event.preventDefault();
									setValues({
										inMs: String(range.inMs / 1000),
										outMs: String(range.outMs / 1000),
									});
									setInvalid(false);
								}
							}}
						/>
					</Field>
				))}
			</div>
			<output
				aria-label={l.selectionTarget}
				className="flex flex-wrap items-center gap-2 text-xs text-zinc-400"
			>
				<span className="rounded border border-zinc-700 px-1.5 py-0.5 font-medium text-zinc-200">
					{targetLabel}
				</span>
				<span className="tabular-nums">
					{selected
						? `${formatTime(selected.startMs)} – ${formatTime(selected.startMs + selected.outMs - selected.inMs)}`
						: formatTime(appendPositionMs)}
				</span>
			</output>
			<div className="flex flex-wrap gap-2">
				<Button
					size="sm"
					variant="secondary"
					disabled={!canAppend || invalid || !draftValid}
					onClick={onAppend}
				>
					{l.append}
				</Button>
				<Button
					size="sm"
					variant="secondary"
					disabled={!canReplace || invalid || !draftValid}
					onClick={onReplace}
				>
					{l.replace}
				</Button>
			</div>
			{error && (
				<p role="status" className="text-xs text-amber-300">
					{taskErrorText(error, l)}
				</p>
			)}
		</section>
	);
}
