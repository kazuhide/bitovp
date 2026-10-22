"use client";

import type { PerTitleGoal } from "@bitovp/core";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { Locale } from "@/lib/i18n";
import {
	type PerTitleAdvice,
	type PerTitleAdviceField,
	perTitleAdviceFieldKey,
} from "./per-title-simulator-advice";
import { perTitleSettingLabel } from "./per-title-simulator-control-copy";
import type { PerTitleSettingValue } from "./per-title-simulator-tuning";

export const isPerTitleBitrateKey = (key: string) =>
	key.endsWith("Bitrate") && !key.endsWith("StepSize");

export function perTitleAdviceValueText(
	value: PerTitleSettingValue,
	key: string,
	locale: Locale,
): string {
	if (value === undefined) return locale === "ja" ? "未設定" : "Unset";
	if (typeof value === "boolean") return value ? "true" : "false";
	if (typeof value !== "number") return value;
	return isPerTitleBitrateKey(key)
		? new Intl.NumberFormat(locale, { maximumFractionDigits: 3 }).format(
				value / 1000,
			)
		: String(value);
}

export function PerTitleAdviceChanges({
	advice,
	goal,
	locale,
	onKeep,
	onApplySelected,
}: {
	advice: PerTitleAdvice;
	goal: PerTitleGoal;
	locale: Locale;
	onKeep: (fields: PerTitleAdviceField[]) => void;
	onApplySelected: (
		advice: PerTitleAdvice,
		fields: PerTitleAdviceField[],
	) => void;
}) {
	const ja = locale === "ja";
	const [selection, setSelection] = useState<string[]>([]);
	const rows = [...(goal.rows ?? []), ...(goal.automaticTemplates ?? [])];
	return (
		<div className="space-y-3">
			<ul className="space-y-2 text-xs">
				{advice.changes.map(({ scope, key, rowId, before, after }) => {
					const field = {
						scope,
						key,
						...(rowId === undefined ? {} : { rowId }),
					};
					const identity = perTitleAdviceFieldKey(field);
					const label = perTitleSettingLabel(key, locale);
					const index = rows.findIndex((row) => row.id === rowId) + 1;
					const suffix =
						scope === "stream" ? `, ${ja ? "段" : "rendition"} ${index}` : "";
					return (
						<li
							key={identity}
							className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1"
						>
							<label className="flex min-w-0 cursor-pointer items-start gap-2 text-zinc-300">
								<input
									type="checkbox"
									className="mt-0.5 accent-emerald-600"
									aria-label={`${ja ? "反映する変更" : "Select change"}: ${label}${suffix}`}
									checked={selection.includes(identity)}
									onChange={(event) =>
										setSelection((current) =>
											event.target.checked
												? [...current, identity]
												: current.filter((item) => item !== identity),
										)
									}
								/>
								<span>
									{scope === "stream"
										? `${ja ? "段" : "Rendition"} ${index}: `
										: ""}
									{label}
								</span>
							</label>
							<div className="flex min-w-0 flex-wrap items-center gap-2 text-zinc-100">
								<span className="break-all tabular-nums">
									{perTitleAdviceValueText(before, key, locale)} →{" "}
									{perTitleAdviceValueText(after, key, locale)}
									{isPerTitleBitrateKey(key) ? " kbps" : ""}
								</span>
								<Button
									variant="secondary"
									size="sm"
									aria-label={`${ja ? "現在値を維持" : "Keep current value"}: ${label}${suffix}`}
									onClick={() => onKeep([field])}
								>
									{ja ? "現在値を維持" : "Keep current value"}
								</Button>
							</div>
						</li>
					);
				})}
			</ul>
			<Button
				variant="secondary"
				size="sm"
				disabled={!selection.length}
				onClick={() =>
					onApplySelected(
						advice,
						advice.changes
							.filter((field) =>
								selection.includes(perTitleAdviceFieldKey(field)),
							)
							.map(({ scope, key, rowId }) => ({
								scope,
								key,
								...(rowId === undefined ? {} : { rowId }),
							})),
					)
				}
			>
				{ja
					? "選択した変更を反映して再計算"
					: "Apply selected changes and recalculate"}
			</Button>
		</div>
	);
}
