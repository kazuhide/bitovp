"use client";

import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useT } from "@/lib/i18n/context";
import { perTitleSimulatorCopy } from "./per-title-simulator-copy";

export function PerTitleSimulatorNumberField({
	id,
	label,
	value,
	onChange,
	unit = 1,
	optional = false,
	integer = false,
	minimum = 0,
	maximum,
	inclusiveMinimum = false,
	errorMessage,
	accessibleLabel,
}: {
	id: string;
	label: string;
	value: number | undefined;
	onChange: (value: number | undefined) => void;
	unit?: number;
	optional?: boolean;
	integer?: boolean;
	minimum?: number;
	maximum?: number;
	inclusiveMinimum?: boolean;
	errorMessage?: string;
	accessibleLabel?: string;
}) {
	const { locale } = useT();
	const copy = perTitleSimulatorCopy[locale];
	const valid =
		(optional && value === undefined) ||
		(value !== undefined &&
			Number.isFinite(value) &&
			(maximum === undefined || value <= maximum) &&
			(integer
				? Number.isSafeInteger(value) &&
					value >= minimum &&
					(inclusiveMinimum || value > 0)
				: inclusiveMinimum
					? value >= minimum
					: value > minimum));
	const error = valid
		? undefined
		: (errorMessage ?? (integer ? copy.positiveInteger : copy.finitePositive));
	return (
		<Field htmlFor={id} label={label} error={error}>
			<Input
				id={id}
				type="number"
				min={Number.isFinite(minimum) ? minimum / unit : undefined}
				max={maximum === undefined ? undefined : maximum / unit}
				step={integer ? 1 / unit : "any"}
				value={
					value !== undefined && Number.isFinite(value) ? value / unit : ""
				}
				aria-label={accessibleLabel}
				aria-invalid={error ? true : undefined}
				onChange={(event) => {
					if (event.target.value === "") {
						onChange(optional ? undefined : Number.NaN);
						return;
					}
					const scaled = Number(event.target.value) * unit;
					const rounded = Math.round(scaled);
					onChange(
						integer &&
							Math.abs(scaled - rounded) <=
								Number.EPSILON * Math.max(1, Math.abs(scaled))
							? rounded
							: scaled,
					);
				}}
			/>
		</Field>
	);
}
