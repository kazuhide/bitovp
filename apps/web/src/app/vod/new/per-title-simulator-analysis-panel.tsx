"use client";

import type { PerTitleGoal } from "@bitovp/core";
import { useId } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { SelectNative } from "@/components/ui/input";
import { useT } from "@/lib/i18n/context";
import {
	isPerTitleBitrateKey,
	perTitleAdviceValueText,
} from "./per-title-simulator-advice-changes";
import type {
	PerTitleAnalysisIntent,
	PerTitleAnalysisResult,
} from "./per-title-simulator-analysis";
import { perTitleSettingLabel } from "./per-title-simulator-control-copy";

const purpose = {
	en: {
		cap: "Use the maximum for complex content",
		bandwidth: "Reduce bandwidth while keeping quality",
		count: "Prioritize the rendition count",
	},
	ja: {
		cap: "複雑な素材で上限まで使う",
		bandwidth: "画質を保って転送量を減らす",
		count: "本数の条件を優先",
	},
};
const dependencyStatus = {
	en: {
		active: "Active",
		inactive: "Inactive",
		"no-effect": "No effect",
		"media-dependent": "Needs media",
		unverified: "Unverified",
		unset: "Unset",
	},
	ja: {
		active: "有効",
		inactive: "無効",
		"no-effect": "効果なし",
		"media-dependent": "素材確認が必要",
		unverified: "未確認",
		unset: "未設定",
	},
};

export function PerTitleAnalysisPanel({
	goal,
	intent,
	onIntentChange,
	onEvaluate,
	result,
}: {
	goal: PerTitleGoal;
	intent: PerTitleAnalysisIntent;
	onIntentChange: (intent: PerTitleAnalysisIntent) => void;
	onEvaluate: () => void;
	result?: PerTitleAnalysisResult;
}) {
	const { locale } = useT();
	const ja = locale === "ja";
	const id = useId();
	const title = ja ? "現在の設定を評価" : "Evaluate current settings";
	const rate = (value: number) =>
		Number.isFinite(value)
			? new Intl.NumberFormat(locale, { maximumFractionDigits: 3 }).format(
					value / 1000,
				)
			: ja
				? "未確定"
				: "Unknown";
	const count =
		goal.countPolicy.kind === "unrestricted"
			? ja
				? "指定なし"
				: "Unrestricted"
			: `${goal.countPolicy.kind === "exact" ? (ja ? "指定" : "Exactly") : ja ? "最大" : "At most"} ${goal.countPolicy.count}`;
	const finding =
		result?.findings.find((item) => item.severity === "conflict") ??
		result?.findings.find((item) =>
			intent === "cap"
				? item.code.startsWith("cap-")
				: intent === "bandwidth"
					? item.code === "quality-measurement-required"
					: [
							"count-required",
							"count-model-checked",
							"count-conditional",
						].includes(item.code),
		) ??
		result?.findings[0];
	const rows = [...(goal.rows ?? []), ...(goal.automaticTemplates ?? [])];
	return (
		<section
			aria-labelledby={`${id}-title`}
			className="space-y-3 rounded-md border border-zinc-700 p-3"
		>
			<h3 id={`${id}-title`} className="font-medium text-sm text-zinc-200">
				{title}
			</h3>
			<div className="flex flex-wrap items-end gap-2">
				<div className="min-w-0 flex-1">
					<Field htmlFor={`${id}-purpose`} label={ja ? "目的" : "Goal"}>
						<SelectNative
							id={`${id}-purpose`}
							value={intent}
							onChange={(event) =>
								onIntentChange(event.target.value as PerTitleAnalysisIntent)
							}
						>
							{(["cap", "bandwidth", "count"] as const).map((value) => (
								<option key={value} value={value}>
									{purpose[locale][value]}
								</option>
							))}
						</SelectNative>
					</Field>
				</div>
				<Button variant="secondary" size="sm" onClick={onEvaluate}>
					{ja ? "評価する" : "Evaluate"}
				</Button>
			</div>
			<p className="text-xs text-zinc-400">
				{ja ? "全体上限" : "Overall maximum"}: {rate(goal.maxBitrate)} kbps
				{" · "}
				{ja ? "本数条件" : "Count goal"}: {count}
			</p>
			{result ? (
				<>
					<p role="status" className="text-xs text-zinc-300">
						{finding?.message[locale] ?? result.quality.message[locale]}
					</p>
					{result.reach.high || result.reach.low ? (
						<dl className="space-y-1 text-xs">
							{(["high", "low"] as const).map((bound) => {
								const top = result.reach[bound];
								if (!top) return null;
								return (
									<div
										key={bound}
										className="flex flex-wrap justify-between gap-x-3 gap-y-1"
									>
										<dt className="text-zinc-400">
											{bound === "high"
												? ja
													? "解析値が上限の場合の最上段"
													: "Top at high analysis input"
												: ja
													? "解析値が下限の場合の最上段"
													: "Top at low analysis input"}
										</dt>
										<dd className="tabular-nums text-zinc-200">
											{rate(top.minimum)}
											{top.maximum !== top.minimum
												? `–${rate(top.maximum)}`
												: ""}{" "}
											kbps
										</dd>
									</div>
								);
							})}
						</dl>
					) : null}
					<details className="space-y-3 text-xs text-zinc-400">
						<summary className="cursor-pointer">
							{ja ? "根拠と画質確認" : "Reasoning and quality checks"}
						</summary>
						<ul className="space-y-2">
							{result.findings.map((item) => (
								<li key={item.code}>{item.message[locale]}</li>
							))}
						</ul>
						<p>{result.quality.message[locale]}</p>
						<ul className="list-disc space-y-1 pl-4">
							{result.quality.checks.map((check) => (
								<li key={check.en}>{check[locale]}</li>
							))}
						</ul>
						<div className="overflow-x-auto">
							<table className="w-full text-left [&_td]:py-2 [&_td]:pr-3 [&_th]:py-2 [&_th]:pr-3 [&_th]:font-medium">
								<caption className="pb-2 text-left font-medium text-zinc-300">
									{ja ? "全項目の依存関係" : "All parameter dependencies"}
								</caption>
								<thead>
									<tr>
										<th scope="col">{ja ? "項目" : "Parameter"}</th>
										<th scope="col">{ja ? "現在値" : "Current"}</th>
										<th scope="col">
											{ja ? "状態・根拠" : "Status and reason"}
										</th>
									</tr>
								</thead>
								<tbody className="divide-y divide-zinc-800">
									{result.dependencies.map((item) => (
										<tr
											key={JSON.stringify([item.scope, item.rowId, item.key])}
										>
											<th scope="row">
												{item.scope === "stream"
													? `${ja ? "段" : "Rendition"} ${rows.findIndex((row) => row.id === item.rowId) + 1 || item.rowId}: `
													: ""}
												{perTitleSettingLabel(item.key, locale)}
											</th>
											<td className="tabular-nums">
												{perTitleAdviceValueText(item.value, item.key, locale)}
												{isPerTitleBitrateKey(item.key) ? " kbps" : ""}
											</td>
											<td>
												{dependencyStatus[locale][item.status]}:{" "}
												{item.explanation[locale]}{" "}
												<a
													href={item.sourceUrl}
													target="_blank"
													rel="noreferrer"
													className="underline"
												>
													{ja ? "出典" : "Source"}
												</a>
												{item.dependencies.length > 0 ? (
													<p className="pt-1 text-zinc-500">
														{ja ? "関連" : "Related"}:{" "}
														{item.dependencies
															.map((key) => perTitleSettingLabel(key, locale))
															.join(", ")}
													</p>
												) : null}
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					</details>
				</>
			) : null}
		</section>
	);
}
