"use client";

import type {
	VodInputTimelineClip,
	VodInputTimelineSourceFacts,
} from "@bitovp/core/vod-input-timeline";
import { useId, useState } from "react";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useTimelineLabels } from "./labels";
import { formatTime } from "./timeline-state";

export function ClipInspector({
	clip,
	source,
	name,
	disabled,
	onChange,
	onError,
}: {
	clip: VodInputTimelineClip;
	source: VodInputTimelineSourceFacts | undefined;
	name: string;
	disabled: boolean;
	onChange: (inMs: number, outMs: number) => void;
	onError: () => void;
}) {
	const l = useTimelineLabels();
	const id = useId();
	const [values, setValues] = useState({
		inMs: String(clip.inMs / 1000),
		outMs: String(clip.outMs / 1000),
	});
	const [invalid, setInvalid] = useState(false);
	function reset() {
		setValues({
			inMs: String(clip.inMs / 1000),
			outMs: String(clip.outMs / 1000),
		});
		setInvalid(false);
	}
	function commit() {
		const inMs = Math.round(Number(values.inMs) * 1000);
		const outMs = Math.round(Number(values.outMs) * 1000);
		if (
			!source ||
			!values.inMs.trim() ||
			!values.outMs.trim() ||
			!Number.isFinite(inMs) ||
			!Number.isFinite(outMs) ||
			inMs < 0 ||
			outMs <= inMs ||
			outMs > source.durationMs
		) {
			setInvalid(true);
			onError();
			return;
		}
		setInvalid(false);
		onChange(inMs, outMs);
	}
	return (
		<section
			aria-label={name}
			className="min-w-0 space-y-2 border-zinc-800 border-t pt-3 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-3"
		>
			<h3 className="truncate font-medium text-sm text-zinc-200" title={name}>
				{name}
			</h3>
			<div className="grid grid-cols-2 gap-2 lg:grid-cols-1">
				{(["inMs", "outMs"] as const).map((field) => (
					<Field
						key={field}
						label={field === "inMs" ? l.in : l.out}
						htmlFor={`${id}-${field}`}
					>
						<Input
							id={`${id}-${field}`}
							type="number"
							inputMode="decimal"
							min={0}
							step="0.001"
							max={source ? source.durationMs / 1000 : undefined}
							className="h-8 tabular-nums"
							disabled={disabled || !source}
							value={values[field]}
							aria-invalid={invalid}
							onChange={(event) =>
								setValues({ ...values, [field]: event.target.value })
							}
							onBlur={commit}
							onKeyDown={(event) => {
								if (event.key === "Enter") {
									event.preventDefault();
									commit();
								}
								if (event.key === "Escape") {
									event.preventDefault();
									reset();
								}
							}}
						/>
					</Field>
				))}
			</div>
			<p className="flex flex-wrap gap-x-2 text-xs text-zinc-400">
				<span>{l.duration}</span>
				<span className="tabular-nums">
					{formatTime(clip.outMs - clip.inMs)}
				</span>
			</p>
		</section>
	);
}
