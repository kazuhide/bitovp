"use client";

import { type ReactNode, useState } from "react";
import { Field } from "@/components/ui/field";
import { HelpOverlay } from "@/components/ui/help-overlay";
import { Input, SelectNative } from "@/components/ui/input";
import type { MessageKey } from "@/lib/i18n";
import { useT } from "@/lib/i18n/context";

/**
 * Shared form machinery for the P2 wizard surface. Every optional schema
 * field renders through these helpers so the unset state is first-class:
 * an empty input emits nothing (buildPlan prunes undefined) and schema
 * defaults fill at parse — plans stay sample-minimal.
 */

/** Collapsible section (<details>) for Advanced / extras groups. */
export function Collapsible({
	summary,
	help,
	children,
	deferContent = false,
}: {
	summary: string;
	/**
	 *  (owner 2026-08-20): the explanation that used to render as an
	 * always-on paragraph at the top of the section. It moves behind a ? beside
	 * the summary, so the section opens to its CONTROLS rather than to prose.
	 *
	 * `Field` has had this since #129; sections did not, which is why the
	 * standalone paragraphs were the row's stated remainder.
	 */
	help?: string;
	children: ReactNode;
	/** Mount large optional editors on first open, then retain their state. */
	deferContent?: boolean;
}) {
	const [activated, setActivated] = useState(false);
	return (
		<details
			className="rounded-md border border-zinc-800 bg-zinc-900/40"
			onToggle={(event) => {
				if (deferContent && event.currentTarget.open) setActivated(true);
			}}
		>
			<summary className="cursor-pointer select-none px-3 py-2 font-medium text-xs text-zinc-300 hover:text-zinc-100">
				{summary}
				{help ? (
					<span className="ml-1.5 inline-flex">
						<HelpOverlay labelFor={summary}>{help}</HelpOverlay>
					</span>
				) : null}
			</summary>
			{!deferContent || activated ? (
				<div className="space-y-3 border-zinc-800 border-t p-3">{children}</div>
			) : null}
		</details>
	);
}

export type OptionValue = string | number | boolean | null | undefined;

export type OptionFieldSpec = {
	key: string;
	labelKey?: MessageKey;
	label?: string;
	help?: string;
	/** "num" | "text" | "bool" | enum options for a select. */
	control:
		| "num"
		| "text"
		| "bool"
		| {
				options: readonly string[];
				labels?: Readonly<Record<string, string>>;
		  };
	hintKey?: MessageKey;
	/** Tri-state extras: bool gains a "null" choice, num gains an
	 * "auto (null)" checkbox — per-title samples pass explicit nulls. */
	nullable?: boolean;
};

function readOption(value: Record<string, unknown>, key: string): OptionValue {
	const raw = value[key];
	if (
		typeof raw === "string" ||
		typeof raw === "number" ||
		typeof raw === "boolean" ||
		raw === null ||
		raw === undefined
	) {
		return raw;
	}
	return undefined;
}

function OptionControl({
	id,
	spec,
	raw,
	onValue,
}: {
	id: string;
	spec: OptionFieldSpec;
	raw: OptionValue;
	onValue: (next: OptionValue) => void;
}) {
	const { t } = useT();
	if (spec.control === "num") {
		return (
			<div className="flex items-center gap-2">
				<Input
					id={id}
					type="number"
					step="any"
					disabled={raw === null}
					value={typeof raw === "number" ? raw : ""}
					onChange={(e) =>
						onValue(e.target.value === "" ? undefined : Number(e.target.value))
					}
				/>
				{spec.nullable ? (
					<label className="flex shrink-0 items-center gap-1 text-xs text-zinc-400">
						<input
							type="checkbox"
							className="h-3.5 w-3.5 accent-emerald-600"
							checked={raw === null}
							onChange={(e) => onValue(e.target.checked ? null : undefined)}
						/>
						{t("wizard.autoNull")}
					</label>
				) : null}
			</div>
		);
	}
	if (spec.control === "text") {
		return (
			<Input
				id={id}
				value={typeof raw === "string" ? raw : ""}
				onChange={(e) =>
					onValue(e.target.value === "" ? undefined : e.target.value)
				}
			/>
		);
	}
	if (spec.control === "bool") {
		const current =
			raw === true
				? "true"
				: raw === false
					? "false"
					: raw === null
						? "null"
						: "";
		return (
			<SelectNative
				id={id}
				value={current}
				onChange={(e) =>
					onValue(
						e.target.value === ""
							? undefined
							: e.target.value === "null"
								? null
								: e.target.value === "true",
					)
				}
			>
				<option value="">{t("wizard.unset")}</option>
				<option value="true">{t("wizard.true")}</option>
				<option value="false">{t("wizard.false")}</option>
				{spec.nullable ? (
					<option value="null">{t("wizard.null")}</option>
				) : null}
			</SelectNative>
		);
	}
	const control = spec.control;
	return (
		<SelectNative
			id={id}
			value={typeof raw === "string" ? raw : ""}
			onChange={(e) =>
				onValue(e.target.value === "" ? undefined : e.target.value)
			}
		>
			<option value="">{t("wizard.default")}</option>
			{typeof raw === "string" &&
			raw !== "" &&
			!control.options.includes(raw) ? (
				<option value={raw}>{raw}</option>
			) : null}
			{control.options.map((option) => (
				<option key={option} value={option}>
					{control.labels?.[option] ?? option}
				</option>
			))}
		</SelectNative>
	);
}

/**
 * Declarative grid of optional fields over a flat options record. The two
 * casts are contained here: option records are flat string-keyed shapes
 * (WizardH264Options & co) whose values are all OptionValue.
 */
export function OptionsGrid<T extends object>({
	idBase,
	value,
	fields,
	onChange,
}: {
	idBase: string;
	value: T;
	fields: OptionFieldSpec[];
	onChange: (next: T) => void;
}) {
	const { t } = useT();
	const record = value as Record<string, unknown>;
	return (
		<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
			{fields.map((spec) => {
				const id = `${idBase}-${spec.key}`;
				return (
					<Field
						key={spec.key}
						label={spec.label ?? (spec.labelKey ? t(spec.labelKey) : spec.key)}
						htmlFor={id}
						{...(spec.help
							? { help: spec.help }
							: spec.hintKey
								? { help: t(spec.hintKey) }
								: {})}
					>
						<OptionControl
							id={id}
							spec={spec}
							raw={readOption(record, spec.key)}
							onValue={(next) => onChange({ ...record, [spec.key]: next } as T)}
						/>
					</Field>
				);
			})}
		</div>
	);
}

/** Comma-separated codes ("ja, ko") kept editable while parsed as a list. */
export function CodesInput({
	id,
	value,
	onChange,
	placeholder = "ja, ko",
}: {
	id: string;
	value: string[] | undefined;
	onChange: (codes: string[] | undefined) => void;
	placeholder?: string;
}) {
	const canonical = (value ?? []).join(", ");
	const [draft, setDraft] = useState<{ raw: string; canonical: string } | null>(
		null,
	);
	return (
		<Input
			id={id}
			placeholder={placeholder}
			value={draft?.canonical === canonical ? draft.raw : canonical}
			onChange={(e) => {
				const codes = e.target.value
					.split(",")
					.map((code) => code.trim())
					.filter((code) => code !== "");
				setDraft({ raw: e.target.value, canonical: codes.join(", ") });
				onChange(codes.length > 0 ? codes : undefined);
			}}
			onBlur={() => setDraft(null)}
		/>
	);
}

/** Small inline remove button used by every row editor. */
export function RowRemoveButton({
	label,
	onClick,
}: {
	label: string;
	onClick: () => void;
}) {
	const { t } = useT();
	return (
		<button
			type="button"
			aria-label={label}
			className="rounded-md border border-zinc-800 px-2 py-1 text-xs text-zinc-400 hover:border-red-900 hover:text-red-400"
			onClick={onClick}
		>
			{t("wizard.remove")}
		</button>
	);
}

/** Keep a resource rename atomic so a cleared draft never retargets references. */
export function ResourceKeyInput({
	id,
	value,
	onCommit,
	className,
}: {
	id: string;
	value: string;
	onCommit: (key: string) => void;
	className?: string;
}) {
	const [draft, setDraft] = useState<{ original: string; text: string } | null>(
		null,
	);
	return (
		<Input
			id={id}
			className={className}
			value={draft?.original === value ? draft.text : value}
			onChange={(event) =>
				setDraft({ original: value, text: event.target.value })
			}
			onBlur={(event) => {
				if (event.target.value !== value) onCommit(event.target.value);
				setDraft(null);
			}}
			onKeyDown={(event) => {
				if (event.key === "Enter") {
					event.preventDefault();
					event.currentTarget.blur();
				}
			}}
		/>
	);
}
