"use client";

import type { PerTitleAutomaticTemplate, PerTitleGoal } from "@bitovp/core";
import { useId, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { SelectNative } from "@/components/ui/input";
import { useT } from "@/lib/i18n/context";
import { perTitleSimulatorCopy } from "./per-title-simulator-copy";
import { PerTitleSimulatorNumberField as NumberField } from "./per-title-simulator-fields";

export function PerTitleAutomaticTemplates({
	goal,
	onChange,
}: {
	goal: PerTitleGoal;
	onChange: (goal: PerTitleGoal) => void;
}) {
	const { locale } = useT();
	const copy = perTitleSimulatorCopy[locale];
	const id = useId();
	const nextId = useRef(0);
	const rows = goal.automaticTemplates ?? [];
	const patch = (index: number, next: Partial<PerTitleAutomaticTemplate>) =>
		onChange({
			...goal,
			automaticTemplates: rows.map((row, i) =>
				i === index ? { ...row, ...next } : row,
			),
		});
	return (
		<section
			className="space-y-3 border-t border-zinc-800 pt-4"
			aria-labelledby={`${id}-automatic`}
		>
			<h3 id={`${id}-automatic`} className="font-medium text-sm text-zinc-200">
				{copy.automaticRows}
			</h3>
			<p className="text-xs text-zinc-400">{copy.automaticHint}</p>
			{rows.map((row, index) => (
				<div key={row.id} className="space-y-2 border-b border-zinc-800 pb-3">
					<div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
						{(
							[
								["height", copy.optionalHeight, 1, true],
								["width", copy.width, 1, true],
								["minBitrate", copy.minimum, 1000, false],
								["maxBitrate", copy.maximum, 1000, false],
							] as const
						).map(([key, label, unit, integer]) => (
							<NumberField
								key={key}
								id={`${id}-${row.id}-${key}`}
								label={label}
								accessibleLabel={`${label}, ${copy.automaticRow} ${index + 1}`}
								value={row[key]}
								unit={unit}
								integer={integer}
								optional
								onChange={(value) => patch(index, { [key]: value })}
							/>
						))}
					</div>
					<details className="text-xs text-zinc-400">
						<summary className="cursor-pointer">{copy.advanced}</summary>
						<div className="mt-3 grid gap-3 sm:grid-cols-3">
							<Field
								htmlFor={`${id}-${row.id}-selection`}
								label={copy.selectionMode}
							>
								<SelectNative
									id={`${id}-${row.id}-selection`}
									aria-label={`${copy.selectionMode}, ${copy.automaticRow} ${index + 1}`}
									value={row.bitrateSelectionMode ?? "OPTIMIZED"}
									onChange={(event) =>
										patch(index, {
											bitrateSelectionMode: event.target
												.value as PerTitleAutomaticTemplate["bitrateSelectionMode"],
										})
									}
								>
									<option value="OPTIMIZED">{copy.optimized}</option>
									<option value="COMPLEXITY_RANGE">
										{copy.complexityRange}
									</option>
								</SelectNative>
							</Field>
							{row.bitrateSelectionMode === "COMPLEXITY_RANGE"
								? (
										[
											["lowComplexityBoundaryForMaxBitrate", copy.lowBoundary],
											[
												"highComplexityBoundaryForMaxBitrate",
												copy.highBoundary,
											],
										] as const
									).map(([key, label]) => (
										<NumberField
											key={key}
											id={`${id}-${row.id}-${key}`}
											label={label}
											accessibleLabel={`${label}, ${copy.automaticRow} ${index + 1}`}
											value={row[key]}
											unit={1000}
											onChange={(value) => patch(index, { [key]: value })}
										/>
									))
								: null}
						</div>
					</details>
					<div className="flex justify-end">
						<Button
							variant="ghost"
							size="sm"
							aria-label={`${copy.removeAutomatic} ${index + 1}`}
							onClick={() =>
								onChange({
									...goal,
									automaticTemplates: rows.filter((_, i) => i !== index),
								})
							}
						>
							{copy.remove}
						</Button>
					</div>
				</div>
			))}
			<Button
				variant="secondary"
				size="sm"
				disabled={rows.length + (goal.rows?.length ?? 0) >= 64}
				onClick={() => {
					const reserved = new Set(
						[...(goal.rows ?? []), ...rows].map((row) => row.id),
					);
					let rowId: string;
					do {
						nextId.current++;
						rowId = `${id}-auto-${nextId.current}`;
					} while (reserved.has(rowId));
					onChange({ ...goal, automaticTemplates: [...rows, { id: rowId }] });
				}}
			>
				{copy.addAutomatic}
			</Button>
		</section>
	);
}
