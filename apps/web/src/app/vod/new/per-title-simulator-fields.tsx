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
	accessibleLabel?: string;
}) {
	const { locale } = useT();
	const copy = perTitleSimulatorCopy[locale];
	const valid =
		(optional && value === undefined) ||
		(value !== undefined &&
			Number.isFinite(value) &&
			(integer
				? Number.isSafeInteger(value) && value >= minimum && value > 0
				: value > minimum));
	const error = valid
		? undefined
		: integer
			? copy.positiveInteger
			: copy.finitePositive;
	return (
		<Field htmlFor={id} label={label} error={error}>
			<Input
				id={id}
				type="number"
				min={minimum}
				step={integer ? 1 : "any"}
				value={
					value !== undefined && Number.isFinite(value) ? value / unit : ""
				}
				aria-label={accessibleLabel}
				aria-invalid={error ? true : undefined}
				onChange={(event) =>
					onChange(
						event.target.value === ""
							? optional
								? undefined
								: Number.NaN
							: Number(event.target.value) * unit,
					)
				}
			/>
		</Field>
	);
}
