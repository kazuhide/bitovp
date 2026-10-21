"use client";

import { useT } from "@/lib/i18n/context";
import { PerTitleSimulatorNumberField } from "./per-title-simulator-fields";

const MAX_BITRATE = 2147483647;
const validRate = (value: number | undefined): value is number =>
	value !== undefined &&
	Number.isSafeInteger(value) &&
	value > 0 &&
	value <= MAX_BITRATE;

function withoutConversionNoise(value: number | undefined) {
	if (value === undefined) return value;
	const integer = Math.round(value);
	// Remove multiplication noise without rounding genuine fractional bitrates.
	return validRate(integer) &&
		Math.abs(value - integer) <= Number.EPSILON * Math.max(1, Math.abs(value))
		? integer
		: value;
}

export function PerTitleSimulatorBitrateField({
	id,
	label,
	value,
	onChange,
	minimum,
	maximum,
	accessibleLabel,
	sliderLabel,
	keyboardStep,
	disabled = false,
}: {
	id: string;
	label: string;
	value: number | undefined;
	onChange: (value: number | undefined) => void;
	minimum: number;
	maximum: number;
	accessibleLabel?: string;
	sliderLabel: string;
	keyboardStep?: number;
	disabled?: boolean;
}) {
	const { locale } = useT();
	const validDomain =
		validRate(minimum) && validRate(maximum) && minimum <= maximum;
	const validValue =
		validDomain && validRate(value) && value >= minimum && value <= maximum;
	const enabled = !disabled && validValue && minimum < maximum;
	const safeMinimum = validDomain ? minimum : 1;
	const safeMaximum = validDomain ? maximum : 1;
	const defaultStep = Math.max(
		1,
		10 ** Math.floor(Math.log10(Math.max(1, safeMaximum - safeMinimum)) - 3),
	);
	const increment = validRate(keyboardStep) ? keyboardStep : defaultStep;
	const update = (next: number) => {
		if (
			!enabled ||
			!validRate(next) ||
			next < minimum ||
			next > maximum ||
			next === value
		)
			return;
		onChange(next);
	};
	return (
		<div className="space-y-2">
			<PerTitleSimulatorNumberField
				id={id}
				label={label}
				value={value}
				onChange={(next) => onChange(withoutConversionNoise(next))}
				unit={1000}
				accessibleLabel={accessibleLabel}
			/>
			<input
				id={`${id}-slider`}
				type="range"
				aria-label={sliderLabel}
				aria-valuetext={
					validValue
						? `${new Intl.NumberFormat(locale, { maximumFractionDigits: 3 }).format(value / 1000)} kbps`
						: undefined
				}
				min={safeMinimum / 1000}
				max={safeMaximum / 1000}
				step={0.001}
				value={(validValue ? value : safeMinimum) / 1000}
				disabled={!enabled}
				className="h-5 w-full cursor-pointer accent-emerald-500 focus-visible:outline-2 focus-visible:outline-emerald-500 focus-visible:outline-offset-2 disabled:opacity-50"
				onChange={(event) =>
					update(Math.round(Number(event.target.value) * 1000))
				}
				onKeyDown={(event) => {
					if (!enabled || value === undefined) return;
					if (event.key === "Home" || event.key === "End") {
						event.preventDefault();
						update(event.key === "Home" ? minimum : maximum);
						return;
					}
					const direction = ["ArrowRight", "ArrowUp", "PageUp"].includes(
						event.key,
					)
						? 1
						: ["ArrowLeft", "ArrowDown", "PageDown"].includes(event.key)
							? -1
							: 0;
					if (!direction) return;
					event.preventDefault();
					update(
						Math.min(
							maximum,
							Math.max(
								minimum,
								value +
									direction *
										increment *
										(event.key.startsWith("Page") ? 10 : 1),
							),
						),
					);
				}}
			/>
		</div>
	);
}
