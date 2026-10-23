"use client";

import type { PerTitleGoal } from "@bitovp/core";
import { type ReactNode, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { SelectNative } from "@/components/ui/input";
import type { Locale } from "@/lib/i18n";
import {
	type PerTitleAdvice,
	type PerTitleAdviceField,
	perTitleAdviceFieldKey,
} from "./per-title-simulator-advice";
import {
	perTitleControlCopy,
	perTitleSettingLabel,
} from "./per-title-simulator-control-copy";
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

type ReviewArguments = [
	advice: PerTitleAdvice,
	selected: PerTitleAdviceField[],
	kept: PerTitleAdviceField[],
];
type ReviewHandler =
	| ((...args: ReviewArguments) => boolean)
	| ((...args: ReviewArguments) => void);

export function PerTitleAdviceChanges({
	advice,
	goal,
	locale,
	onReview,
	onAdoptAll,
	renderPreview,
	applying = false,
	pendingFields = [],
}: {
	advice: PerTitleAdvice;
	goal: PerTitleGoal;
	locale: Locale;
	onReview: ReviewHandler;
	onAdoptAll?: (advice: PerTitleAdvice) => void;
	renderPreview?: (selection: {
		selected: readonly PerTitleAdviceField[];
		kept: readonly PerTitleAdviceField[];
	}) => ReactNode;
	applying?: boolean;
	pendingFields?: readonly PerTitleAdviceField[];
}) {
	const ja = locale === "ja";
	const pending = new Set(pendingFields.map(perTitleAdviceFieldKey));
	type Choice = "keep" | "apply";
	const fingerprint = advice.inputFingerprint;
	const valueKey = (value: PerTitleSettingValue) =>
		`${typeof value}:${Object.is(value, -0) ? "-0" : String(value)}`;
	const changesKey = JSON.stringify(
		advice.changes.map((change) => [
			perTitleAdviceFieldKey(change),
			valueKey(change.before),
			valueKey(change.after),
			change.beforeAdjustment,
			change.afterAdjustment,
		]),
	);
	const [selection, setSelection] = useState({
		advice,
		goal,
		fingerprint,
		changesKey,
		choices: new Map<string, Choice>(),
	});
	const current = (value: typeof selection) =>
		value.advice === advice &&
		value.goal === goal &&
		value.fingerprint === fingerprint &&
		value.changesKey === changesKey;
	const choices = current(selection)
		? selection.choices
		: new Map<string, Choice>();
	useEffect(() => {
		setSelection({
			advice,
			goal,
			fingerprint,
			changesKey,
			choices: new Map(),
		});
	}, [advice, goal, fingerprint, changesKey]);
	const update = (
		change: (value: Map<string, Choice>) => Map<string, Choice>,
	) =>
		setSelection((value) => ({
			advice,
			goal,
			fingerprint,
			changesKey,
			choices: change(current(value) ? value.choices : new Map()),
		}));
	const fields = (choice: Choice) =>
		advice.changes
			.filter((field) => choices.get(perTitleAdviceFieldKey(field)) === choice)
			.map(({ scope, key, rowId }) => ({
				scope,
				key,
				...(rowId === undefined ? {} : { rowId }),
			}));
	const selected = fields("apply");
	const kept = fields("keep");
	const hasDecisions = selected.length + kept.length > 0;
	const review = () => {
		if (!hasDecisions || (applying && selected.length > 0)) return;
		if (onReview(advice, selected, kept) !== false)
			setSelection((value) =>
				current(value) ? { ...value, choices: new Map() } : value,
			);
	};
	const rows = [...(goal.rows ?? []), ...(goal.automaticTemplates ?? [])];
	return (
		<div className="min-w-0 space-y-3">
			{renderPreview?.({ selected, kept })}
			<div className="min-w-0 max-w-full overflow-x-auto">
				<table className="w-full min-w-[40rem] table-fixed text-left text-xs [&_td]:px-2 [&_td]:py-2 [&_td]:align-top [&_th]:px-2 [&_th]:py-2 [&_th]:align-top [&_th]:font-medium">
					<caption className="sr-only">
						{ja ? "項目ごとの変更" : "Review parameter changes"}
					</caption>
					<colgroup>
						<col className="w-[14%]" />
						<col className="w-[24%]" />
						<col className="w-[18%]" />
						<col className="w-[18%]" />
						<col className="w-[26%]" />
					</colgroup>
					<thead className="text-zinc-400">
						<tr>
							<th scope="col">{ja ? "対象" : "Target"}</th>
							<th scope="col">{ja ? "項目" : "Parameter"}</th>
							<th scope="col">{ja ? "現在値" : "Current"}</th>
							<th scope="col">{ja ? "提案値" : "Proposed"}</th>
							<th scope="col">{ja ? "選択" : "Decision"}</th>
						</tr>
					</thead>
					<tbody className="divide-y divide-zinc-800">
						{advice.changes.map((change) => {
							const { scope, key, rowId, before, after } = change;
							const { beforeAdjustment, afterAdjustment } = change;
							const field = {
								scope,
								key,
								...(rowId === undefined ? {} : { rowId }),
							};
							const identity = perTitleAdviceFieldKey(field);
							const label = perTitleSettingLabel(key, locale);
							const modeChange =
								beforeAdjustment?.mode === "auto" &&
								afterAdjustment?.mode === "fixed"
									? ja
										? `自動（${perTitleControlCopy[locale].methods[beforeAdjustment.method]}） → 固定`
										: `Auto (${perTitleControlCopy[locale].methods[beforeAdjustment.method]}) → Fixed`
									: undefined;
							const index = rows.findIndex((row) => row.id === rowId);
							const row = rows[index];
							const suffix =
								scope === "stream"
									? `, ${ja ? "段" : "rendition"} ${index + 1 || "?"}`
									: "";
							const dimensions =
								row?.width && row.height
									? `${row.width}×${row.height} px`
									: row?.height
										? `${row.height}p`
										: row?.width
											? `${ja ? "幅" : "Width"} ${row.width} px`
											: ja
												? "寸法未定"
												: "Dimensions unknown";
							const precise =
								!Object.is(before, after) &&
								perTitleAdviceValueText(before, key, locale) ===
									perTitleAdviceValueText(after, key, locale);
							const text = (value: PerTitleSettingValue) => {
								if (precise && typeof value === "number")
									return `${Object.is(value, -0) ? "-0" : String(value)}${isPerTitleBitrateKey(key) ? " bps" : ""}`;
								return `${perTitleAdviceValueText(value, key, locale)}${typeof value === "number" && isPerTitleBitrateKey(key) ? " kbps" : ""}`;
							};
							return (
								<tr key={identity} data-field-key={identity}>
									<td className="text-zinc-400 [overflow-wrap:anywhere]">
										<span className="block">
											{scope === "global"
												? ja
													? "全体"
													: "Global"
												: `${ja ? "段" : "Rendition"} ${index + 1 || "?"}`}
										</span>
										{scope === "stream" ? (
											<span className="block">{dimensions}</span>
										) : null}
									</td>
									<th
										scope="row"
										className="whitespace-normal text-zinc-300 [overflow-wrap:anywhere]"
									>
										{label}
										{modeChange ? (
											<span className="block font-normal text-zinc-400">
												{modeChange}
											</span>
										) : null}
									</th>
									<td className="tabular-nums text-zinc-200 [overflow-wrap:anywhere]">
										{text(before)}
									</td>
									<td className="tabular-nums text-emerald-300 [overflow-wrap:anywhere]">
										{text(after)}
									</td>
									<td>
										<SelectNative
											aria-label={`${ja ? "選択" : "Decision"}: ${label}${suffix}`}
											className="h-8 min-w-0 px-2 text-xs"
											value={choices.get(identity) ?? "skip"}
											onChange={(event) => {
												const choice = event.target.value;
												if (choice === "keep" && pending.has(identity)) return;
												update((value) => {
													const next = new Map(value);
													if (choice === "keep" || choice === "apply")
														next.set(identity, choice);
													else next.delete(identity);
													return next;
												});
											}}
										>
											<option value="skip">
												{ja ? "未選択" : "No decision"}
											</option>
											<option value="keep" disabled={pending.has(identity)}>
												{ja ? "現在値を維持" : "Keep current"}
											</option>
											<option value="apply">
												{ja ? "提案を反映" : "Apply proposed"}
											</option>
										</SelectNative>
									</td>
								</tr>
							);
						})}
					</tbody>
				</table>
			</div>
			{applying ? (
				<p role="status" className="text-xs text-zinc-400">
					{ja
						? "設定の反映を待っています。"
						: "Waiting for settings to update."}
				</p>
			) : null}
			<div className="flex flex-wrap items-center gap-2 text-xs">
				<Button
					variant="ghost"
					size="sm"
					disabled={!advice.changes.length}
					onClick={() =>
						update(
							() =>
								new Map(
									advice.changes.map((field) => [
										perTitleAdviceFieldKey(field),
										"apply",
									]),
								),
						)
					}
				>
					{ja ? "提案をすべて選択" : "Select all proposed"}
				</Button>
				<Button
					variant="ghost"
					size="sm"
					disabled={!hasDecisions}
					onClick={() => update(() => new Map())}
				>
					{ja ? "選択をクリア" : "Clear decisions"}
				</Button>
				<span className="text-zinc-400">
					{ja
						? `反映 ${selected.length} · 維持 ${kept.length}`
						: `Apply ${selected.length} · Keep ${kept.length}`}
				</span>
			</div>
			<div className="flex flex-wrap gap-2">
				<Button
					size="sm"
					disabled={!hasDecisions || (applying && selected.length > 0)}
					onClick={review}
				>
					{ja ? "選択した内容で再評価" : "Re-evaluate selected decisions"}
				</Button>
				{onAdoptAll ? (
					<Button
						data-advisor-adopt
						variant="secondary"
						size="sm"
						disabled={hasDecisions || applying}
						onClick={() => onAdoptAll(advice)}
					>
						{ja ? "この調整を採用" : "Use this adjustment"}
					</Button>
				) : null}
			</div>
		</div>
	);
}
