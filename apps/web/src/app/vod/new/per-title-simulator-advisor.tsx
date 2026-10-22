"use client";

import type { PerTitleGoal } from "@bitovp/core";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { Locale } from "@/lib/i18n";
import { useT } from "@/lib/i18n/context";
import {
	hasAutomaticPerTitleSettings,
	type PerTitleAdvice,
	type PerTitleAdviceChange,
	type PerTitleAdviceEdit,
	perTitleAdvice,
} from "./per-title-simulator-advice";
import { perTitleSettingLabel } from "./per-title-simulator-control-copy";
import {
	getPerTitleGoalSetting,
	type PerTitleSettingValue,
	perTitleGlobalFields,
	perTitleStreamFields,
} from "./per-title-simulator-tuning";

function singleEdit(
	before: PerTitleGoal,
	after: PerTitleGoal,
): PerTitleAdviceEdit | undefined {
	if (before.codec !== after.codec || before.strategy !== after.strategy)
		return;
	const edits: PerTitleAdviceEdit[] = perTitleGlobalFields(after.codec)
		.filter(
			({ key }) =>
				!Object.is(
					getPerTitleGoalSetting(before, "global", key),
					getPerTitleGoalSetting(after, "global", key),
				),
		)
		.map(({ key }) => ({ scope: "global", key }));
	for (const row of [
		...(after.rows ?? []),
		...(after.automaticTemplates ?? []),
	]) {
		for (const { key } of perTitleStreamFields(after.codec)) {
			if (
				!Object.is(
					getPerTitleGoalSetting(before, "stream", key, row.id),
					getPerTitleGoalSetting(after, "stream", key, row.id),
				)
			)
				edits.push({ scope: "stream", key, rowId: row.id });
		}
	}
	if (
		before.countPolicy.kind !== after.countPolicy.kind ||
		(before.countPolicy.kind !== "unrestricted" &&
			after.countPolicy.kind !== "unrestricted" &&
			before.countPolicy.count !== after.countPolicy.count)
	)
		edits.push({ scope: "count", key: "countPolicy" });
	return edits.length === 1 ? edits[0] : undefined;
}

const bitrateKey = (key: string) =>
	key.endsWith("Bitrate") && !key.endsWith("StepSize");

function valueText(
	value: PerTitleSettingValue,
	key: string,
	locale: Locale,
): string {
	if (value === undefined) return locale === "ja" ? "未設定" : "Unset";
	if (typeof value === "boolean") return value ? "true" : "false";
	if (typeof value !== "number") return value;
	return bitrateKey(key)
		? new Intl.NumberFormat(locale, { maximumFractionDigits: 3 }).format(
				value / 1000,
			)
		: String(value);
}

function changeGroups(changes: PerTitleAdviceChange[]) {
	const groups: PerTitleAdviceChange[][] = [];
	for (const change of changes) {
		const matching = groups.find(
			([first]) =>
				first?.scope === change.scope &&
				first.key === change.key &&
				Object.is(first.before, change.before) &&
				Object.is(first.after, change.after),
		);
		if (matching) matching.push(change);
		else groups.push([change]);
	}
	return groups;
}

function AdviceOption({
	advice,
	goal,
	onAdopt,
	locale,
}: {
	advice: PerTitleAdvice;
	goal: PerTitleGoal;
	onAdopt: (advice: PerTitleAdvice) => void;
	locale: Locale;
}) {
	const ja = locale === "ja";
	const reason = {
		"joint-range": ja
			? "全体の下限と段構成を保ち、各段の範囲・複雑度境界・間隔・追加倍率をまとめて調整する案です。"
			: "Keep the overall minimum and template structure, and adjust rendition ranges, complexity boundaries, steps and the additional-rendition factor together.",
		"upper-boundary": ja
			? "全体上限と揃えていた複雑度の上側境界も、新しい上限に合わせる案です。各段のビットレート範囲は維持します。"
			: "Align the previously coupled upper complexity boundaries with the new overall maximum. Keep each rendition's bitrate range.",
		"lower-boundary": ja
			? "最高固定段の最小ビットレートと間隔の下限から、従来と同じ関係を保つ複雑度の下側境界を求めます。"
			: "Keep the previous lower-boundary relationship to the highest fixed rendition's minimum and the minimum bitrate step.",
		"global-range": ja
			? "変更した段の範囲が収まるように、全体の範囲を広げる案です。"
			: "Expand the overall range to contain the rendition range you changed.",
		"row-range": ja
			? "変更した全体の範囲に収まるように、はみ出した段の端だけを合わせる案です。"
			: "Keep your overall limits and bring only the outlying rendition endpoints inside them.",
		spacing: ja
			? "変更した値と各段の範囲を保って、ビットレート間隔を調整する案です。"
			: "Keep the value you changed and the rendition ranges, and adjust the bitrate steps.",
	}[advice.reason];
	const allRows = [...(goal.rows ?? []), ...(goal.automaticTemplates ?? [])];
	return (
		<div className="space-y-3">
			<p className="text-xs text-zinc-300">{reason}</p>
			<dl className="space-y-2 text-xs">
				{changeGroups(advice.changes).map((group) => {
					const first = group[0];
					if (!first) return null;
					const label = perTitleSettingLabel(first.key, locale);
					const rows = group
						.map(
							(change) =>
								allRows.findIndex((row) => row.id === change.rowId) + 1,
						)
						.join(", ");
					return (
						<div
							key={`${first.scope}-${first.key}-${first.rowId ?? "global"}`}
							className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1"
						>
							<dt className="min-w-0 text-zinc-400">
								{first.scope === "stream"
									? `${ja ? "段" : "Rendition"} ${rows}: `
									: ""}
								{label}
							</dt>
							<dd className="break-all tabular-nums text-zinc-100">
								{valueText(first.before, first.key, locale)} →{" "}
								{valueText(first.after, first.key, locale)}
								{bitrateKey(first.key) ? " kbps" : ""}
							</dd>
						</div>
					);
				})}
			</dl>
			<details className="space-y-2 text-xs text-zinc-400">
				<summary className="cursor-pointer">
					{ja ? "根拠と確認範囲" : "Reasoning and scope"}
				</summary>
				{advice.reason === "lower-boundary" ? (
					<p>
						{ja ? "下側境界" : "Lower boundary"} = trunc(
						{new Intl.NumberFormat(locale).format(
							advice.facts.highestFixedMinimum ?? Number.NaN,
						)}{" "}
						× {advice.facts.minimumStep}) ={" "}
						{new Intl.NumberFormat(locale).format(
							advice.facts.lower ?? Number.NaN,
						)}{" "}
						bps
					</p>
				) : null}
				{advice.reason === "joint-range" ? (
					<p>
						{ja
							? "下限を支点に対数上の配置を保って範囲と倍率を求めます。複雑度境界は、同じ解析値で補間の上限目標が下がらない範囲に限定します。丸め後の配置余地・固定段同士の接続・追加段の上限も評価しています。配置余地は実際の出力本数ではありません。"
							: "Ranges and ratios retain their logarithmic placement above the overall minimum. Complexity boundaries are limited so interpolated upper targets do not decrease for the same analysis input. Rounded placement room, fixed-row connections and the additional-rendition cap are also evaluated. Placement room is not the actual output count."}
					</p>
				) : null}
				<p>
					{advice.proof === "model-count"
						? ja
							? "本数条件をこの計算モデルで確認しています。実際の出力本数・解像度・画質の確認には素材解析が必要です。"
							: "Count conditions are checked in this model. Actual output count, resolutions and quality still require content analysis."
						: ja
							? "変更後の設定を再計算した案です。自動生成を含む実際の本数や画質は、この計算では確定しません。"
							: "The edited settings are recalculated. This check does not establish the actual generated count or quality."}
				</p>
			</details>
			<Button variant="secondary" size="sm" onClick={() => onAdopt(advice)}>
				{ja ? "この調整を採用" : "Use this adjustment"}
			</Button>
		</div>
	);
}

/** Keep a continuous slider/text edit tied to its original dependency values. */
export function PerTitleAdvisor({
	goal,
	session,
	onAdopt,
}: {
	goal: PerTitleGoal;
	session: PerTitleGoal;
	onAdopt: (advice: PerTitleAdvice) => void;
}) {
	const { locale } = useT();
	const id = useId();
	const previous = useRef({ goal, session });
	const active = useRef<{
		before: PerTitleGoal;
		edit: PerTitleAdviceEdit;
	} | null>(null);
	const [snapshot, setSnapshot] = useState<{
		goal: PerTitleGoal;
		session: PerTitleGoal;
		items: PerTitleAdvice[];
	} | null>(null);
	useEffect(() => {
		const prior = previous.current;
		previous.current = { goal, session };
		if (prior.session !== session) {
			active.current = null;
			setSnapshot(null);
			return;
		}
		if (prior.goal === goal) return;
		const edit = singleEdit(prior.goal, goal);
		if (!edit) {
			active.current = null;
			setSnapshot(
				hasAutomaticPerTitleSettings(goal)
					? { goal, session, items: [] }
					: null,
			);
			return;
		}
		if (
			!active.current ||
			active.current.edit.scope !== edit.scope ||
			active.current.edit.key !== edit.key ||
			active.current.edit.rowId !== edit.rowId
		)
			active.current = { before: prior.goal, edit };
		setSnapshot({
			goal,
			session,
			items: perTitleAdvice(active.current.before, goal, edit),
		});
	}, [goal, session]);
	const items =
		snapshot?.goal === goal && snapshot.session === session
			? snapshot.items
			: [];
	const first = items[0];
	if (!first) {
		return snapshot?.goal === goal &&
			snapshot.session === session &&
			hasAutomaticPerTitleSettings(goal) ? (
			<p role="status" className="text-xs text-zinc-400">
				{locale === "ja"
					? "自動調整が有効です。値を保持して調整案を確認する場合は、各項目を固定にしてください。"
					: "Automatic adjustment is enabled. Set the fields to Fixed to retain their values and review dependent adjustments."}
			</p>
		) : null;
	}
	const adopt = (advice: PerTitleAdvice) => {
		active.current = null;
		setSnapshot(null);
		onAdopt(advice);
	};
	return (
		<section
			aria-labelledby={id}
			className="space-y-3 rounded-md border border-zinc-700 p-3"
		>
			<h3 id={id} className="font-medium text-sm text-zinc-200">
				{locale === "ja" ? "調整案" : "Suggested adjustment"}
			</h3>
			<AdviceOption
				advice={first}
				goal={goal}
				onAdopt={adopt}
				locale={locale}
			/>
			{items.length > 1 ? (
				<details className="space-y-3 text-xs text-zinc-400">
					<summary className="cursor-pointer">
						{locale === "ja" ? "ほかの案" : "Other adjustments"}
					</summary>
					{items.slice(1).map((item) => (
						<AdviceOption
							key={item.id}
							advice={item}
							goal={goal}
							onAdopt={adopt}
							locale={locale}
						/>
					))}
				</details>
			) : null}
		</section>
	);
}
