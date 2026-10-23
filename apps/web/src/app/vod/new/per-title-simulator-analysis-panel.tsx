"use client";

import type { PerTitleGoal } from "@bitovp/core";
import { useId, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldRow, FieldRowAction } from "@/components/ui/field";
import { SelectNative } from "@/components/ui/input";
import { useT } from "@/lib/i18n/context";
import {
	type PerTitleAdvice,
	type PerTitleAdviceField,
	perTitleAdviceFieldKey,
} from "./per-title-simulator-advice";
import {
	isPerTitleBitrateKey,
	perTitleAdviceValueText,
} from "./per-title-simulator-advice-changes";
import type {
	PerTitleAnalysisIntent,
	PerTitleAnalysisResult,
} from "./per-title-simulator-analysis";
import {
	assessPerTitleLadder,
	type PerTitleLadderAssessment,
} from "./per-title-simulator-analysis-ladder";
import { perTitleSettingLabel } from "./per-title-simulator-control-copy";
import {
	perTitleGlobalFields,
	perTitleStreamFields,
	tunePerTitleSettings,
} from "./per-title-simulator-tuning";
import { assessPerTitleUpperLimit } from "./per-title-simulator-upper-limit";

const purpose = {
	en: {
		preserve: "Optimize within the current bitrate limits and count",
		cap: "Use the maximum for complex content",
		bandwidth: "Reduce bandwidth while keeping quality",
		count: "Prioritize the rendition count",
	},
	ja: {
		preserve: "最小・最大と本数を保って見直す",
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

const rate = (value: number, locale: "en" | "ja") =>
	Number.isFinite(value)
		? new Intl.NumberFormat(locale, { maximumFractionDigits: 3 }).format(
				value / 1000,
			)
		: locale === "ja"
			? "未確定"
			: "Unknown";

function DeclaredOutputStructure({
	result,
	locale,
}: {
	result: PerTitleAnalysisResult;
	locale: "en" | "ja";
}) {
	const structure = result.countStructure;
	if (structure.status !== "declared-compatible") return null;
	const ja = locale === "ja";
	const templates = new Map(result.ladder.rows.map((row) => [row.rowId, row]));
	const label = (rowId: string) => {
		const row = templates.get(rowId);
		return row?.width && row.height
			? `${row.width}×${row.height} px`
			: row?.height
				? `${row.height}p`
				: row?.width
					? `${ja ? "幅" : "Width"} ${row.width} px`
					: ja
						? "未確定"
						: "Unknown";
	};
	const fixed = new Map<string, number>();
	for (const rowId of structure.fixedRowIds) {
		const dimension = label(rowId);
		fixed.set(dimension, (fixed.get(dimension) ?? 0) + 1);
	}
	const parts = [
		...(structure.lower?.required ? structure.lower.rowIds.map(label) : []),
		...[...fixed].map(([dimension, count]) =>
			count > 1 ? `${dimension} × ${count}` : dimension,
		),
		...(structure.upper?.required
			? [
					structure.upper.selection === "one-of"
						? `(${structure.upper.rowIds.map(label).join(ja ? " または " : " or ")})`
						: structure.upper.rowIds.map(label).join(" + "),
				]
			: []),
	];
	return (
		<p className="text-xs text-zinc-300">
			{ja
				? `指定した出力構成: ${structure.required}本 = ${parts.join(" + ")}。実際の本数は素材で確認します。`
				: `Declared output structure: ${structure.required} = ${parts.join(" + ")}. Native count requires media.`}
		</p>
	);
}

function FullLadderDetails({
	result,
	locale,
	advice,
}: {
	result: PerTitleAnalysisResult;
	locale: "en" | "ja";
	advice?: PerTitleAdvice;
}) {
	const ja = locale === "ja";
	const selected = advice ?? result.advice[0];
	const proposed = useMemo(
		() =>
			selected
				? assessPerTitleLadder(selected.goal, selected.proposal)
				: undefined,
		[selected],
	);
	const proposedRows = new Map(proposed?.rows.map((row) => [row.rowId, row]));
	const unknown = ja ? "未確定" : "Unknown";
	const media = ja ? "素材解析で決定" : "Determined by media";
	const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 3 });
	type Row = PerTitleLadderAssessment["rows"][number];
	const range = (value: Row["configured"], divisor = 1000) => {
		if (
			!value ||
			!Number.isFinite(value.minimum) ||
			!Number.isFinite(value.maximum) ||
			value.minimum > value.maximum
		)
			return unknown;
		const lower = number.format(value.minimum / divisor);
		return value.minimum === value.maximum
			? lower
			: `${lower}–${number.format(value.maximum / divisor)}`;
	};
	const cell = (row: Row | undefined, field: "configured" | "low" | "high") =>
		!row
			? unknown
			: row[field]
				? range(row[field])
				: row.mode === "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE"
					? unknown
					: media;
	const dimension = (row: Row) =>
		row.width && row.height
			? `${row.width}×${row.height} px`
			: row.height
				? `${row.height} px`
				: row.width
					? `${ja ? "幅" : "Width"} ${row.width} px`
					: media;
	const mode = (row: Row) =>
		row.mode === "PER_TITLE_TEMPLATE"
			? ja
				? "自動"
				: "Automatic"
			: row.mode === "PER_TITLE_TEMPLATE_FIXED_RESOLUTION"
				? ja
					? "固定解像度"
					: "Fixed resolution"
				: ja
					? "固定範囲"
					: "Fixed range";
	const segments = (ladder: PerTitleLadderAssessment) =>
		ladder.intervals
			? `${ladder.intervals.checkedSegments} (${range(ladder.input)} kbps)`
			: unknown;
	const response = (ladder: PerTitleLadderAssessment) => {
		const labels = ja
			? {
					tracked: "追従確認",
					gap: "接続条件外",
					unknown: "未確認",
					"not-applicable": "対象外",
				}
			: {
					tracked: "Tracked",
					gap: "Connection gap",
					unknown: "Unknown",
					"not-applicable": "Not applicable",
				};
		const { status, domain, checkedSegments } = ladder.topResponse;
		return `${labels[status]}${domain ? ` · ${range(domain)} kbps · ${checkedSegments}` : ""}`;
	};
	const saturated = (ladder: PerTitleLadderAssessment) =>
		ladder.earlySaturationRows.length
			? ladder.earlySaturationRows
					.map(
						(id) => ladder.rows.findIndex((row) => row.rowId === id) + 1 || id,
					)
					.join(", ")
			: ja
				? "なし"
				: "None";
	const facts = [
		{ label: ja ? "全区間の分割数" : "Full-interval segments", read: segments },
		{
			label: ja
				? "上段の応答・確認範囲・分割数"
				: "Top response, domain and segments",
			read: response,
		},
		{
			label: ja
				? "各段の上限へ早期到達"
				: "Templates reaching their own maximum early",
			read: saturated,
		},
		{
			label: ja
				? "上限解析値での上側配置余地（算術）"
				: "Upper slots at high input (arithmetic)",
			read: (ladder: PerTitleLadderAssessment) => range(ladder.upperSlots, 1),
		},
		{
			label: ja
				? "全解析範囲の下側配置余地（算術）"
				: "Lower slots across inputs (arithmetic)",
			read: (ladder: PerTitleLadderAssessment) => range(ladder.lowerSlots, 1),
		},
		{
			label: ja ? "全体の配置容量（算術）" : "Global capacity (arithmetic)",
			read: (ladder: PerTitleLadderAssessment) =>
				ladder.globalCapacity === null
					? unknown
					: number.format(ladder.globalCapacity),
		},
	];
	const title = ja ? "ラダー全体" : "Full ladder";
	return (
		<details className="space-y-3">
			<summary className="cursor-pointer">{title}</summary>
			<p>
				{ja
					? "設定範囲と、解析値の上限・下限を仮定した目標です。"
					: "Configured ranges and targets conditional on the low/high analysis inputs."}
			</p>
			<div className="overflow-x-auto">
				<table className="w-full text-left [&_td]:py-2 [&_td]:pr-3 [&_th]:py-2 [&_th]:pr-3 [&_th]:font-medium">
					<caption className="sr-only">{title}</caption>
					<thead>
						<tr>
							<th scope="col">{ja ? "テンプレート" : "Template"}</th>
							<th scope="col">
								{ja ? "設定範囲 (kbps)" : "Configured range (kbps)"}
							</th>
							<th scope="col">
								{ja ? "下限解析値の目標 (kbps)" : "Low-input target (kbps)"}
							</th>
							<th scope="col">
								{ja ? "上限解析値の目標 (kbps)" : "High-input target (kbps)"}
							</th>
							{proposed ? (
								<th scope="col">
									{ja ? "提案範囲 (kbps)" : "Proposed range (kbps)"}
								</th>
							) : null}
						</tr>
					</thead>
					<tbody className="divide-y divide-zinc-800">
						{result.ladder.rows.map((row, index) => (
							<tr key={row.rowId} data-row-id={row.rowId}>
								<th scope="row" className="align-top">
									<span className="block">
										{ja ? "テンプレート" : "Template"} {index + 1}
									</span>
									<span className="block text-zinc-500">
										{dimension(row)} · {mode(row)}
									</span>
								</th>
								<td className="tabular-nums">{cell(row, "configured")}</td>
								<td className="tabular-nums">{cell(row, "low")}</td>
								<td className="tabular-nums">{cell(row, "high")}</td>
								{proposed ? (
									<td className="tabular-nums">
										{cell(proposedRows.get(row.rowId), "configured")}
									</td>
								) : null}
							</tr>
						))}
					</tbody>
				</table>
			</div>
			<dl className="space-y-2">
				{facts.map((fact) => {
					const current = fact.read(result.ladder);
					const next = proposed ? fact.read(proposed) : undefined;
					return (
						<div
							key={fact.label}
							className="flex flex-wrap justify-between gap-x-3 gap-y-1"
						>
							<dt>{fact.label}</dt>
							<dd className="tabular-nums text-zinc-300">
								{current}
								{next !== undefined && next !== current ? ` → ${next}` : ""}
							</dd>
						</div>
					);
				})}
			</dl>
			<p>
				{ja
					? "配置余地と容量は算術値で、実際の出力本数ではありません。"
					: "Placement slots and capacity are arithmetic, not the native output count."}
			</p>
		</details>
	);
}

export function PerTitleAnalysisPanel({
	goal,
	referenceGoal = goal,
	intent,
	onIntentChange,
	onEvaluate,
	result,
	onInspectField,
	onReleaseMaintained,
	applying = false,
}: {
	goal: PerTitleGoal;
	referenceGoal?: PerTitleGoal;
	intent: PerTitleAnalysisIntent;
	onIntentChange: (intent: PerTitleAnalysisIntent) => void;
	onEvaluate: () => void;
	result?: PerTitleAnalysisResult;
	onInspectField?: (field: PerTitleAdviceField) => void;
	onReleaseMaintained?: () => void;
	applying?: boolean;
}) {
	const { locale } = useT();
	const ja = locale === "ja";
	const id = useId();
	const title = ja ? "現在の設定を評価" : "Evaluate current settings";
	const upperLimitFinding = useMemo(() => {
		const current = tunePerTitleSettings(goal, referenceGoal);
		return assessPerTitleUpperLimit(current.goal, current.proposal).finding;
	}, [goal, referenceGoal]);
	const count =
		goal.countPolicy.kind === "unrestricted"
			? ja
				? "指定なし"
				: "Unrestricted"
			: `${goal.countPolicy.kind === "exact" ? (ja ? "指定" : "Exactly") : ja ? "最大" : "At most"} ${goal.countPolicy.count}`;
	const conflict =
		result?.findings.find(
			(item) =>
				item.severity === "conflict" && item.code !== "configuration-conflict",
		) ?? result?.findings.find((item) => item.severity === "conflict");
	const finding =
		result?.findings.find((item) =>
			intent === "cap"
				? item.code.startsWith("cap-")
				: intent === "bandwidth"
					? item.severity === "warning" && item.code !== "count-conditional"
					: ["count-required", "declared-count-roles-mismatch"].includes(
							item.code,
						),
		) ??
		result?.findings.find(
			(item) =>
				item.severity === "warning" &&
				!["count-conditional", "preserve-count-unverified"].includes(item.code),
		) ??
		result?.findings.find((item) => item.severity === "warning") ??
		result?.findings[0];
	const cause =
		result?.decision.status === "proposal"
			? undefined
			: (conflict ??
				(result?.decision.status === "keep-current" ? undefined : finding));
	const affectedFields = [
		...new Map(
			(cause?.fields ?? []).map((field) => [
				perTitleAdviceFieldKey(field),
				field,
			]),
		).values(),
	].filter((field) =>
		field.scope === "global"
			? field.key === "countPolicy" ||
				(perTitleGlobalFields(goal.codec).some(
					({ key }) => key === field.key,
				) &&
					(field.key !== "autoRepresentations.adoptConfigurationThreshold" ||
						(goal.autoRepresentations !== undefined &&
							goal.autoRepresentations !== false)))
			: [...(goal.rows ?? []), ...(goal.automaticTemplates ?? [])].some(
					(row) => row.id === field.rowId,
				) &&
				((field.key === "height" &&
					goal.strategy !== "automatic" &&
					goal.strategy !== "count") ||
					perTitleStreamFields(goal.codec).some(
						({ key }) => key === field.key,
					)),
	);
	const rows = [...(goal.rows ?? []), ...(goal.automaticTemplates ?? [])];
	const fieldName = (field: PerTitleAdviceField) => {
		const name =
			field.key === "countPolicy"
				? ja
					? "本数条件"
					: "Count goal"
				: field.key === "height"
					? ja
						? "高さ (px)"
						: "Height (px)"
					: perTitleSettingLabel(field.key, locale);
		const row = rows.findIndex((item) => item.id === field.rowId) + 1;
		return field.scope === "stream"
			? `${name}, ${ja ? "段" : "rendition"} ${row || "?"}`
			: name;
	};
	const status = applying
		? ja
			? "調整の反映を待っています。反映後に再評価できます。"
			: "Waiting for the adjustment to be applied. Evaluate again after it finishes."
		: result?.decision.status === "proposal"
			? ja
				? "調整案があります。"
				: "A checked adjustment is available."
			: result?.decision.message[locale];
	return (
		<section
			aria-labelledby={`${id}-title`}
			aria-busy={applying || undefined}
			className="space-y-3 rounded-md border border-zinc-700 p-3"
		>
			<h3 id={`${id}-title`} className="font-medium text-sm text-zinc-200">
				{title}
			</h3>
			<FieldRow>
				<div className="min-w-0 flex-1">
					<Field htmlFor={`${id}-purpose`} label={ja ? "目的" : "Goal"}>
						<SelectNative
							id={`${id}-purpose`}
							value={intent}
							onChange={(event) =>
								onIntentChange(event.target.value as PerTitleAnalysisIntent)
							}
						>
							{(["preserve", "cap", "bandwidth", "count"] as const).map(
								(value) => (
									<option key={value} value={value}>
										{purpose[locale][value]}
									</option>
								),
							)}
						</SelectNative>
					</Field>
				</div>
				<FieldRowAction>
					<Button
						variant="secondary"
						size="sm"
						onClick={onEvaluate}
						disabled={applying}
						aria-describedby={applying ? `${id}-status` : undefined}
					>
						{ja ? "評価する" : "Evaluate"}
					</Button>
				</FieldRowAction>
			</FieldRow>
			<p className="text-xs text-zinc-400">
				{ja ? "全体上限" : "Overall maximum"}: {rate(goal.maxBitrate, locale)}{" "}
				kbps
				{" · "}
				{ja ? "本数条件" : "Count goal"}: {count}
			</p>
			{upperLimitFinding ? (
				<p
					role="alert"
					className="rounded-md border border-red-800/60 bg-red-950/20 p-2 text-red-300 text-xs"
				>
					<span className="font-medium">{ja ? "エラー: " : "Error: "}</span>
					{upperLimitFinding.message[locale]}
				</p>
			) : null}
			{result ? (
				<>
					<div
						id={`${id}-status`}
						role="status"
						className="space-y-2 text-xs text-zinc-300"
					>
						<p>{status}</p>
						{!applying && cause && cause.message[locale] !== status ? (
							<p>{cause.message[locale]}</p>
						) : null}
					</div>
					{!applying && onInspectField && affectedFields.length > 0 ? (
						<div className="flex flex-wrap gap-2">
							{affectedFields.map((field) => (
								<Button
									key={perTitleAdviceFieldKey(field)}
									variant="secondary"
									size="sm"
									className="h-auto whitespace-normal text-left"
									onClick={() => onInspectField(field)}
								>
									{ja ? "設定を確認: " : "Review setting: "}
									{fieldName(field)}
								</Button>
							))}
						</div>
					) : null}
					{!applying &&
					result.advice.length === 0 &&
					onReleaseMaintained &&
					result.relaxation &&
					result.relaxation.certifiedAlternatives > 0 &&
					result.relaxation.fields.length > 0 ? (
						<div className="space-y-2 text-xs text-zinc-300">
							<p>
								{ja
									? "次の項目の維持を解除すると検証済みの別案があります: "
									: "A checked alternative is available if you release these maintained values: "}
								{result.relaxation.fields.map(fieldName).join(ja ? "、" : "; ")}
							</p>
							<Button
								variant="secondary"
								size="sm"
								className="h-auto whitespace-normal text-left"
								onClick={onReleaseMaintained}
							>
								{ja
									? "該当項目の維持を解除して再評価"
									: "Release these maintained values and re-evaluate"}
							</Button>
						</div>
					) : null}
					<DeclaredOutputStructure result={result} locale={locale} />
				</>
			) : null}
		</section>
	);
}

export function PerTitleAnalysisDetails({
	goal,
	result,
	advice,
}: {
	goal: PerTitleGoal;
	result?: PerTitleAnalysisResult;
	advice?: PerTitleAdvice;
}) {
	const { locale } = useT();
	if (!result) return null;
	const ja = locale === "ja";
	const rows = [...(goal.rows ?? []), ...(goal.automaticTemplates ?? [])];
	return (
		<details className="space-y-3 text-xs text-zinc-400">
			<summary className="cursor-pointer">
				{ja ? "評価の詳細" : "Evaluation details"}
			</summary>
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
									{rate(top.minimum, locale)}
									{top.maximum !== top.minimum
										? `–${rate(top.maximum, locale)}`
										: ""}{" "}
									kbps
								</dd>
							</div>
						);
					})}
				</dl>
			) : null}
			<FullLadderDetails result={result} locale={locale} advice={advice} />
			<ul className="space-y-2">
				{result.findings.map((item) => {
					const affected = [
						...new Set(
							item.fields?.flatMap((field) =>
								field.rowId ? [field.rowId] : [],
							),
						),
					]
						.map((rowId) => rows.findIndex((row) => row.id === rowId) + 1)
						.filter((index) => index > 0);
					return (
						<li key={JSON.stringify([item.code, item.fields])}>
							{affected.length
								? `${ja ? "段" : "Rendition"} ${affected.join(", ")}: `
								: ""}
							{item.message[locale]}
						</li>
					);
				})}
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
							<th scope="col">{ja ? "状態・根拠" : "Status and reason"}</th>
						</tr>
					</thead>
					<tbody className="divide-y divide-zinc-800">
						{result.dependencies.map((item) => (
							<tr key={JSON.stringify([item.scope, item.rowId, item.key])}>
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
	);
}
