"use client";

import type { PerTitleGoal, PerTitleProposal } from "@bitovp/core";
import { Field } from "@/components/ui/field";
import { InfoHint } from "@/components/ui/info-hint";
import { SelectNative } from "@/components/ui/input";
import { useT } from "@/lib/i18n/context";
import { PerTitleSimulatorBitrateField } from "./per-title-simulator-bitrate-field";
import {
	perTitleControlCopy,
	perTitleSettingLabel,
} from "./per-title-simulator-control-copy";
import { PerTitleSimulatorNumberField } from "./per-title-simulator-fields";
import {
	getPerTitleAdjustment,
	getPerTitleGoalSetting,
	getPerTitleSetting,
	type PerTitleSettingField,
	type PerTitleSettingScope,
	perTitleGlobalFields,
	perTitleStreamFields,
	setPerTitleAdjustment,
	setPerTitleSetting,
} from "./per-title-simulator-tuning";

export type PerTitleControlContext = {
	draft: PerTitleGoal;
	anchor: PerTitleGoal;
	proposal: PerTitleProposal;
	onChange: (goal: PerTitleGoal) => void;
};

const fixedOnly = new Set([
	"minBitrate",
	"maxBitrate",
	"bitrateSelectionMode",
	"lowComplexityBoundaryForMaxBitrate",
	"highComplexityBoundaryForMaxBitrate",
]);

export function PerTitleSettingControl({
	id,
	context,
	scope,
	field,
	rowId,
	label,
	accessibleLabel,
	slider,
}: {
	id: string;
	context: PerTitleControlContext;
	scope: PerTitleSettingScope;
	field: PerTitleSettingField;
	rowId?: string;
	label?: string;
	accessibleLabel?: string;
	slider?: {
		label: string;
		minimum: number;
		maximum: number;
		keyboardStep?: number;
		disabled?: boolean;
	};
}) {
	const { locale } = useT();
	const text = perTitleControlCopy[locale];
	const { draft, anchor, proposal, onChange } = context;
	const adjustment = getPerTitleAdjustment(
		draft,
		anchor,
		scope,
		field.key,
		rowId,
	);
	const emitted = getPerTitleSetting(proposal, scope, field.key, rowId);
	const value =
		adjustment.mode === "fixed"
			? getPerTitleGoalSetting(draft, scope, field.key, rowId)
			: emitted;
	const title = label ?? perTitleSettingLabel(field.key, locale, field.label);
	const accessible = accessibleLabel ?? title;
	const stream = proposal.api.streams.find((item) => item.rowId === rowId);
	const thresholdInactive =
		scope === "global" &&
		field.key === "autoRepresentations.adoptConfigurationThreshold" &&
		proposal.api.global.autoRepresentations === undefined;
	const inactive =
		thresholdInactive ||
		(scope === "stream" &&
			fixedOnly.has(field.key) &&
			(stream?.mode !== "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE" ||
				(field.key.endsWith("ComplexityBoundaryForMaxBitrate") &&
					stream.perTitleSettings?.bitrateSelectionMode === "OPTIMIZED")));
	const method =
		adjustment.mode === "auto"
			? adjustment.method
			: (field.methods[0] ?? "default");
	const defaultLabel =
		scope === "global" && field.group === "range"
			? locale === "en"
				? "Loaded value"
				: "読み込み時の値"
			: scope === "global" && field.group === "spacing"
				? locale === "en"
					? "Default ratio"
					: "既定の比率"
				: text.defaults;
	const methodLabel = (item: typeof method) =>
		item === "default" ? defaultLabel : text.methods[item];
	const hint =
		method === "default" && field.group === "range"
			? locale === "en"
				? "Keep the loaded bound."
				: "読み込み時の上下限を使います。"
			: method === "default" && field.group === "spacing"
				? locale === "en"
					? "Use the documented default ratios: minimum 1.5, maximum 1.9."
					: "公開された既定の比率（下限1.5、上限1.9）を使います。"
				: method === "proportional" && scope === "global"
					? locale === "en"
						? "One fixed bound: keep the loaded min/max ratio. Both automatic: keep the loaded pair."
						: "片方が固定なら読み込み時の上下限の比率を保ち、両方自動なら読み込み時の上下限を使います。"
					: method === "constraints" &&
							scope === "stream" &&
							(field.key === "minBitrate" || field.key === "maxBitrate")
						? locale === "en"
							? "Create evenly spaced bands on the current logarithmic bitrate scale."
							: "現在の対数ビットレート目盛り上に、等間隔の範囲を作ります。"
						: text.hints[method];
	const changeValue = (next: number | string | boolean | undefined) => {
		if (!thresholdInactive)
			onChange(setPerTitleSetting(draft, scope, field.key, next, rowId));
	};
	const required =
		((field.key === "minBitrate" || field.key === "maxBitrate") &&
			(scope === "global" ||
				stream?.mode === "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE")) ||
		field.key.endsWith("BitrateStepSize");
	return (
		<div
			className="min-w-0 space-y-1.5"
			data-setting-key={field.key}
			data-setting-scope={scope}
			data-setting-row={rowId}
			data-setting-control={id}
		>
			<div className="flex flex-wrap items-center gap-1.5">
				<SelectNative
					className="w-auto text-xs"
					aria-label={`${accessible} ${text.adjustment}`}
					value={adjustment.mode}
					onChange={(event) => {
						const mode = event.target.value;
						if (mode === "fixed" || mode === "auto")
							onChange(
								setPerTitleAdjustment(
									draft,
									proposal,
									scope,
									field.key,
									mode === "fixed" ? { mode } : { mode, method },
									rowId,
								),
							);
					}}
				>
					<option value="auto">{text.auto}</option>
					<option value="fixed">{text.fixed}</option>
				</SelectNative>
				{adjustment.mode === "auto" ? (
					<>
						{field.methods.length > 1 ? (
							<SelectNative
								className="min-w-0 w-auto max-w-full text-xs"
								aria-label={`${accessible} ${text.method}`}
								value={method}
								onChange={(event) => {
									const selected = field.methods.find(
										(item) => item === event.target.value,
									);
									if (selected)
										onChange(
											setPerTitleAdjustment(
												draft,
												proposal,
												scope,
												field.key,
												{ mode: "auto", method: selected },
												rowId,
											),
										);
								}}
							>
								{field.methods.map((item) => (
									<option key={item} value={item}>
										{methodLabel(item)}
									</option>
								))}
							</SelectNative>
						) : (
							<span className="text-xs text-zinc-400">
								{methodLabel(method)}
							</span>
						)}
						<InfoHint text={hint} label={`${accessible} ${text.method}`} />
					</>
				) : null}
			</div>
			<fieldset disabled={thresholdInactive} className="min-w-0">
				{field.kind === "selection" ? (
					<Field htmlFor={id} label={title}>
						<SelectNative
							id={id}
							aria-label={accessibleLabel}
							value={typeof value === "string" ? value : ""}
							onChange={(event) => changeValue(event.target.value || undefined)}
						>
							<option value="">{text.unset}</option>
							{field.options?.map((item) => (
								<option key={item} value={item}>
									{item}
								</option>
							))}
						</SelectNative>
					</Field>
				) : field.kind === "toggle" ? (
					<Field htmlFor={id} label={title}>
						<input
							id={id}
							aria-label={accessibleLabel}
							type="checkbox"
							checked={value === true}
							onChange={(event) => changeValue(event.target.checked)}
							className="h-4 w-4 accent-emerald-500"
						/>
					</Field>
				) : slider ? (
					<PerTitleSimulatorBitrateField
						id={id}
						label={title}
						accessibleLabel={accessibleLabel}
						sliderLabel={slider.label}
						value={typeof value === "number" ? value : undefined}
						minimum={slider.minimum}
						maximum={slider.maximum}
						keyboardStep={slider.keyboardStep}
						disabled={slider.disabled}
						onChange={(next) => changeValue(next ?? Number.NaN)}
					/>
				) : (
					<PerTitleSimulatorNumberField
						id={id}
						label={title}
						accessibleLabel={accessibleLabel}
						value={typeof value === "number" ? value : undefined}
						unit={field.kind === "bitrate" ? 1000 : 1}
						integer={field.integer}
						minimum={field.minimum ?? Number.NEGATIVE_INFINITY}
						maximum={field.maximum}
						inclusiveMinimum={
							field.integer ||
							field.minimum === undefined ||
							field.key === "resolutionScaleFactor" ||
							field.key.endsWith("adoptConfigurationThreshold")
						}
						optional={!required}
						errorMessage={text.invalid}
						onChange={changeValue}
					/>
				)}
			</fieldset>
			<div className="flex flex-wrap gap-x-2 text-xs text-zinc-500">
				<code className="break-all">{field.key}</code>
				{inactive ? <span>{text.inactive}</span> : null}
			</div>
		</div>
	);
}

export function PerTitleGlobalControls({
	id,
	context,
}: {
	id: string;
	context: PerTitleControlContext;
}) {
	const { locale } = useT();
	const text = perTitleControlCopy[locale];
	return (
		<section className="space-y-3" aria-label={text.global}>
			{(["spacing", "analysis", "automatic", "additional"] as const).map(
				(group) => (
					<details
						key={group}
						className="border-t border-zinc-800 pt-3 text-xs text-zinc-400"
					>
						<summary className="cursor-pointer font-medium text-zinc-300">
							{text.groups[group]}
						</summary>
						<div className="grid items-start gap-3 pt-3 sm:grid-cols-2">
							{perTitleGlobalFields(context.draft.codec)
								.filter((field) => field.group === group)
								.map((field) => (
									<PerTitleSettingControl
										key={field.key}
										id={`${id}-${field.key}`}
										context={context}
										scope="global"
										field={field}
									/>
								))}
						</div>
					</details>
				),
			)}
		</section>
	);
}

export function PerTitleStreamControls({
	id,
	context,
	rowId,
	omitBounds = false,
	suffix,
}: {
	id: string;
	context: PerTitleControlContext;
	rowId: string;
	omitBounds?: boolean;
	suffix?: string;
}) {
	const { locale } = useT();
	const text = perTitleControlCopy[locale];
	return (
		<details className="border-t border-zinc-800 pt-2 text-xs text-zinc-400">
			<summary className="cursor-pointer">{text.stream}</summary>
			<div className="grid items-start gap-3 pt-3 sm:grid-cols-2">
				{perTitleStreamFields(context.draft.codec)
					.filter(
						(field) =>
							!omitBounds ||
							(field.key !== "minBitrate" && field.key !== "maxBitrate"),
					)
					.map((field) => (
						<PerTitleSettingControl
							key={field.key}
							id={`${id}-${field.key}`}
							context={context}
							scope="stream"
							field={field}
							rowId={rowId}
							accessibleLabel={
								suffix
									? `${perTitleSettingLabel(field.key, locale, field.label)}, ${suffix}`
									: undefined
							}
						/>
					))}
			</div>
		</details>
	);
}
