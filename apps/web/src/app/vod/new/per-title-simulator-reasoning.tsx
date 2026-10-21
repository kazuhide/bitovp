"use client";

import type { PerTitleGoal, PerTitleProposal } from "@bitovp/core";
import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n/context";
import {
	type PerTitleSuggestion,
	perTitleSuggestions,
} from "./per-title-simulator-suggestions";

const texts = {
	en: {
		title: "Why these settings",
		objective:
			"Keep the required resolutions and bitrate ranges, and change existing settings only when the count or interval conditions require it.",
		methods: {
			"joint-constraints":
				"Required ranges, complexity boundaries and additional-rendition rules are checked together for the stated input interval and row order. Open Parameter derivation for the values and their conditions.",
			"preserved-existing":
				"The existing bitrate steps satisfy the checked conditions, so they are retained. Raising the overall maximum does not scale the individual bitrate ranges.",
			"geometric-count":
				"The bitrate range and desired count define a spacing interval. The proposed value is checked against integer bitrate examples within that interval.",
			"required-intervals":
				"The allowed ranges of the required rows limit the spacing. Their feasible interval is checked against the desired count before selecting settings.",
			"documented-defaults":
				"No count or required-row constraint requires different spacing. The comparison uses the documented default ratios, 1.5 and 1.9.",
		},
		details: "Calculation and assumptions",
		minimumL: "Overall minimum L (kbps)",
		maximumU: "Overall maximum U (kbps)",
		span: "Bitrate span U/L",
		requestedCount: "Requested rendition count",
		requiredRows: "Required rows",
		modelCount: "Model count objective N",
		selectedMin: "Selected minimum ratio s",
		selectedMax: "Selected maximum ratio",
		lower: "Model count boundary (excluded)",
		upper: "Checked spacing upper bound (included)",
		checkedOrder: "Feasible spacing for the checked row order",
		witness: "Integer placement example (kbps)",
		witnessHint:
			"The model places integer bit/s values, shown here in kbps. This is an arithmetic existence example within the allowed ranges, not a prediction of encoder output.",
		unrestricted: "Unrestricted",
		undetermined: "Not established",
		exact: (count: number) => `Exactly ${count}`,
		atMost: (count: number) => `At most ${count}`,
		definitions:
			"L and U are the overall minimum and maximum bitrates. N is the model's count objective, when specified. s is the minimum ratio between neighboring bitrate points.",
		precision:
			"Displayed ratios are approximate. Checks use unrounded values; a displayed boundary is not an equality condition. The count boundary below is a model result and can differ from the continuous sufficient condition.",
		midpoint:
			"The selected ratio is based on the geometric midpoint of the checked spacing bounds, giving similar proportional room on either side. Integer bitrate placement is then checked again for rounding. This choice retains the required rows and their bitrate ranges.",
		capacity:
			"For continuous bitrate points in the overall range, s^N > U/L is a sufficient condition for at most N points. Equality permits another continuous point. Integer bitrate capacity is checked separately.",
		intervals:
			"For the checked required-row order, each integer point must satisfy p[i] = max(L[i], ceil(s × p[i−1])) ≤ U[i]. L[i] and U[i] are that row's allowed limits; p[i] is an integer bitrate and ceil rounds upward. The model also checks the largest ratio between these points.",
		order:
			"The search checks a bounded set of row orders. This is not a proof of the best spacing across every possible order.",
		unknown:
			"The count goal has not been established by this model. Check the proposed alternatives and the conditions below.",
		limit:
			"Content analysis is still needed for generated resolutions, quality and the actual rendition count. The examples do not establish a quality optimum.",
		suggestions: "Recommended adjustment",
		otherSuggestions: "Other adjustments",
		ranking:
			"Options that preserve all templates and ranges come first. Changes to generation rules are explicit alternatives. Each option is checked again in the model.",
		reasons: {
			"global-range":
				"Keep the per-rendition ranges and expand the overall limits to contain them.",
			"required-count":
				"Keep every required rendition and raise the count goal to accommodate them.",
			"fixed-only":
				"Prioritize the count goal by removing the automatic templates and retaining the required rows.",
			"without-forced":
				"Compare the template conditions with the additional-rendition rules excluded. The original reference remains available.",
		},
		actions: {
			"fixed-only": "Compare without automatic templates",
			"without-forced": "Compare without additional rules",
		},
		rangeAction: (minimum: string, maximum: string) =>
			`Use ${minimum}–${maximum} kbps`,
		countAction: (count: number) => `Use ${count} renditions`,
		use: "Use these conditions",
		changes: "Fields to change",
		maximum: "Overall maximum (kbps)",
		count: "Desired count",
		range: "Model count range at the upper limit",
		source: "Parameter definitions",
		constraints: "Combining bitrate constraints",
	},
	ja: {
		title: "提案の根拠",
		objective:
			"必須の解像度とビットレート範囲を維持し、本数や配置の条件を満たすために必要な設定を変更します。",
		methods: {
			"joint-constraints":
				"各段の範囲・複雑度境界・追加レンディションのルールを組み合わせ、指定した入力範囲と行順で確認しています。数値と条件は「パラメータの導出」で確認できます。",
			"preserved-existing":
				"元のビットレート間隔で確認対象の条件を満たすため、その値を維持します。全体の上限を上げても、各段のビットレート範囲は比例して変更しません。",
			"geometric-count":
				"全体のビットレート範囲と希望本数から、間隔の取り得る範囲を求めています。その範囲内で、整数のビットレートを配置できる値を選びます。",
			"required-intervals":
				"必須の各段を許容範囲内に配置できる間隔を求め、本数の条件とも両立するかを確認して値を選びます。",
			"documented-defaults":
				"本数や必須段の条件による間隔の変更が必要ないため、公開仕様の既定値である1.5・1.9を比較に使います。",
		},
		details: "計算手順と前提",
		minimumL: "全体の下限 L (kbps)",
		maximumU: "全体の上限 U (kbps)",
		span: "全体の上限と下限の比 U/L",
		requestedCount: "希望する本数",
		requiredRows: "必須の行数",
		modelCount: "モデルで確認する本数 N",
		selectedMin: "選んだ最小比率 s",
		selectedMax: "選んだ最大比率",
		lower: "モデル上の本数条件の下側境界（含まない）",
		upper: "確認した間隔の上側境界（含む）",
		checkedOrder: "確認した並びで配置できる間隔の上限",
		witness: "整数ビットレートの配置例 (kbps)",
		witnessHint:
			"モデルではbit/s単位の整数を配置し、ここではkbpsで表示しています。許容範囲内に値を置けることを示す計算例で、エンコーダの出力を予測したものではありません。",
		unrestricted: "制限なし",
		undetermined: "未確定",
		exact: (count: number) => `${count}本ちょうど`,
		atMost: (count: number) => `${count}本以下`,
		definitions:
			"LとUは全体の下限・上限ビットレートです。Nは本数の指定がある場合にモデルで確認する本数、sは隣り合うビットレート点の最小比率を表します。",
		precision:
			"表示した比率は概数です。判定には丸める前の値を使うため、表示上同じ数値でも境界と等しいとは限りません。本数条件の境界はモデルの計算結果で、連続値の十分条件とは異なる場合があります。",
		midpoint:
			"選んだ比率は、確認した間隔の上下の境界に対する比率の余裕が近くなるよう、幾何平均を基準にしています。その後、整数への切り上げを含めて配置を再確認しています。必須の行と各行のビットレート範囲は維持します。",
		capacity:
			"全体の範囲に連続値のビットレート点を高々N個置ける十分条件は s^N > U/L です。等号では連続値ならもう1点入る余地があります。整数値での上限は別途確認しています。",
		intervals:
			"確認した必須段の並びで、各整数点が p[i] = max(L[i], ceil(s × p[i−1])) ≤ U[i] を満たすかを調べます。L[i]とU[i]はその行の許容範囲、p[i]は整数のビットレート、ceilは整数への切り上げです。隣り合う点の最大比率も確認します。",
		order:
			"並び順の探索には上限があります。すべての並びについて最良の間隔であることを証明するものではありません。",
		unknown:
			"このモデルでは、本数の要件を満たすことを確認できていません。下の変更案と条件を確認してください。",
		limit:
			"生成される解像度、画質、実際の本数の判断には素材解析が必要です。計算例だけで画質の最適値は求められません。",
		suggestions: "先に見直す設定",
		otherSuggestions: "ほかの変更案",
		ranking:
			"テンプレートと各範囲を維持する案を先に示します。生成ルールを変更する案は、その変更点を明記します。各案はモデルで再確認しています。",
		reasons: {
			"global-range":
				"各段のビットレート範囲を維持し、それらが収まるよう全体の範囲を広げます。",
			"required-count":
				"必須のレンディションをすべて残すため、それらが収まる本数に希望値を変更します。",
			"fixed-only":
				"希望本数を優先し、自動生成の候補を外して、必須の行を残す案です。",
			"without-forced":
				"追加レンディションのルールを外し、残りのテンプレート条件で比較する案です。元の参照設定は保持します。",
		},
		actions: {
			"fixed-only": "自動テンプレートを外して比較",
			"without-forced": "追加ルールを外して比較",
		},
		rangeAction: (minimum: string, maximum: string) =>
			`全体を${minimum}–${maximum} kbpsに変更`,
		countAction: (count: number) => `希望本数を${count}本に変更`,
		use: "この条件で比較する",
		changes: "変更する項目",
		maximum: "全体の最大ビットレート (kbps)",
		count: "希望する本数",
		range: "上限値でのモデル上の本数",
		source: "パラメータの定義",
		constraints: "ビットレート条件の組み合わせ",
	},
};

export function PerTitleReasoning({
	goal,
	proposal,
	onChange,
}: {
	goal: PerTitleGoal;
	proposal: PerTitleProposal;
	onChange: (goal: PerTitleGoal) => void;
}) {
	const { locale } = useT();
	const copy = texts[locale];
	const validRange =
		Number.isSafeInteger(goal.minBitrate) &&
		Number.isSafeInteger(goal.maxBitrate) &&
		goal.minBitrate > 0 &&
		goal.maxBitrate >= goal.minBitrate;
	const suggestions = useMemo(
		() => (validRange ? perTitleSuggestions(goal) : []),
		[goal, validRange],
	);
	const derivation = proposal.derivation;
	const number = (value: number) =>
		new Intl.NumberFormat(locale, { maximumSignificantDigits: 10 }).format(
			value,
		);
	const ratio = (value: number | undefined) =>
		value !== undefined && Number.isFinite(value) && value >= 1;
	const checked =
		validRange &&
		proposal.applicable &&
		proposal.status === "candidate" &&
		derivation?.targetSatisfied === true &&
		ratio(derivation.selectedMinStep) &&
		ratio(derivation.selectedMaxStep) &&
		derivation.selectedMaxStep >= derivation.selectedMinStep;
	const lower = derivation?.ratioLowerExclusive;
	const upper = derivation?.ratioUpperInclusive;
	const interior =
		checked &&
		(derivation.method === "geometric-count" ||
			derivation.method === "required-intervals") &&
		lower !== undefined &&
		upper !== undefined &&
		ratio(lower) &&
		ratio(upper) &&
		derivation.selectedMinStep > lower &&
		derivation.selectedMinStep < upper;
	const witness =
		checked &&
		derivation.integerWitness?.length &&
		derivation.integerWitness.every(
			(point) =>
				Number.isSafeInteger(point) &&
				point >= goal.minBitrate &&
				point <= goal.maxBitrate,
		)
			? derivation.integerWitness
			: undefined;
	const count = goal.countPolicy;
	const requestedCount =
		count.kind === "unrestricted"
			? copy.unrestricted
			: Number.isSafeInteger(count.count) && count.count > 0
				? count.kind === "exact"
					? copy.exact(count.count)
					: copy.atMost(count.count)
				: copy.undetermined;
	const renderSuggestion = (suggestion: PerTitleSuggestion) => {
		const scenario = suggestion.proposal.scenarios.find(
			(item) => item.fraction === 1,
		);
		const countChecked =
			suggestion.proposal.applicable &&
			suggestion.proposal.status === "candidate" &&
			suggestion.proposal.derivation?.targetSatisfied === true &&
			scenario?.status === "modelled";
		const high = countChecked ? scenario.modelCountRange : undefined;
		return (
			<div
				key={suggestion.id}
				className="space-y-2 rounded-md border border-zinc-800 p-3 text-xs text-zinc-300"
			>
				<p>{copy.reasons[suggestion.reason]}</p>
				<p>
					{copy.maximum}: {suggestion.goal.maxBitrate / 1000}
				</p>
				{countChecked && suggestion.goal.countPolicy.kind !== "unrestricted" ? (
					<p>
						{copy.count}: {suggestion.goal.countPolicy.count}
					</p>
				) : null}
				{high ? (
					<p>
						{copy.range}: {high.minimum}–{high.maximum}
					</p>
				) : null}
				<details className="text-zinc-400">
					<summary className="cursor-pointer">{copy.changes}</summary>
					<p className="mt-2 break-all font-mono">
						{suggestion.changedFields.join(", ")}
					</p>
				</details>
				<Button
					variant="secondary"
					size="sm"
					onClick={() => onChange(structuredClone(suggestion.goal))}
				>
					{copy.use}
				</Button>
			</div>
		);
	};

	const actionBitrate = (value: number) =>
		new Intl.NumberFormat(locale, { maximumFractionDigits: 3 }).format(
			value / 1000,
		);
	const actionLabel = (suggestion: PerTitleSuggestion) => {
		if (suggestion.reason === "global-range")
			return copy.rangeAction(
				actionBitrate(suggestion.goal.minBitrate),
				actionBitrate(suggestion.goal.maxBitrate),
			);
		if (suggestion.reason === "required-count")
			return suggestion.goal.countPolicy.kind === "unrestricted"
				? copy.use
				: copy.countAction(suggestion.goal.countPolicy.count);
		return copy.actions[suggestion.reason];
	};

	const firstSuggestion = suggestions[0];
	return (
		<div className="space-y-3">
			{firstSuggestion ? (
				<Button
					variant="secondary"
					size="sm"
					onClick={() => onChange(structuredClone(firstSuggestion.goal))}
				>
					{actionLabel(firstSuggestion)}
				</Button>
			) : null}
			<details className="space-y-3 border-t border-zinc-800 pt-4 text-xs text-zinc-400">
				<summary className="cursor-pointer">{copy.title}</summary>
				<p className="text-xs text-zinc-300">{copy.objective}</p>
				{derivation ? (
					<>
						{checked ? (
							<p className="text-xs text-zinc-400">
								{copy.methods[derivation.method]}
							</p>
						) : (
							<p className="text-xs text-amber-300">{copy.unknown}</p>
						)}
						<details className="space-y-2 text-xs text-zinc-400">
							<summary className="cursor-pointer">{copy.details}</summary>
							<dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-x-4 gap-y-2 rounded-md bg-zinc-900 p-3">
								{[
									[
										copy.minimumL,
										validRange
											? number(goal.minBitrate / 1000)
											: copy.undetermined,
									],
									[
										copy.maximumU,
										validRange
											? number(goal.maxBitrate / 1000)
											: copy.undetermined,
									],
									[
										copy.span,
										validRange
											? `≈ ${number(goal.maxBitrate / goal.minBitrate)}`
											: copy.undetermined,
									],
									[copy.requestedCount, requestedCount],
									[
										copy.requiredRows,
										Number.isSafeInteger(derivation.requiredRowCount) &&
										derivation.requiredRowCount >= 0
											? number(derivation.requiredRowCount)
											: copy.undetermined,
									],
									...(Number.isSafeInteger(derivation.desiredCount) &&
									(derivation.desiredCount ?? 0) > 0
										? [
												[
													copy.modelCount,
													number(derivation.desiredCount as number),
												],
											]
										: []),
									[
										copy.selectedMin,
										validRange && ratio(derivation.selectedMinStep)
											? `≈ ${number(derivation.selectedMinStep)}`
											: copy.undetermined,
									],
									[
										copy.selectedMax,
										validRange && ratio(derivation.selectedMaxStep)
											? `≈ ${number(derivation.selectedMaxStep)}`
											: copy.undetermined,
									],
									...(validRange && lower !== undefined && ratio(lower)
										? [[copy.lower, `≈ ${number(lower)}`]]
										: []),
									...(validRange && upper !== undefined && ratio(upper)
										? [[copy.upper, `≈ ${number(upper)}`]]
										: []),
									...(validRange &&
									derivation.maximumFeasibleStep !== undefined &&
									ratio(derivation.maximumFeasibleStep)
										? [
												[
													copy.checkedOrder,
													`≈ ${number(derivation.maximumFeasibleStep)}`,
												],
											]
										: []),
									...(witness
										? [
												[
													copy.witness,
													witness
														.map((point) => number(point / 1000))
														.join(" → "),
												],
											]
										: []),
								].map(([label, value]) => (
									<div key={label} className="contents">
										<dt>{label}</dt>
										<dd className="max-w-md break-words text-right tabular-nums text-zinc-200">
											{value}
										</dd>
									</div>
								))}
							</dl>
							<p>{copy.definitions}</p>
							<p>{copy.precision}</p>
							{derivation.method !== "joint-constraints" ? (
								<p>{copy.capacity}</p>
							) : null}
							{interior ? <p>{copy.midpoint}</p> : null}
							{witness ? <p>{copy.witnessHint}</p> : null}
							{derivation.method !== "joint-constraints" &&
							derivation.requiredRowCount > 1 ? (
								<>
									<p>{copy.intervals}</p>
									<p>{copy.order}</p>
								</>
							) : null}
						</details>
					</>
				) : null}
				<p className="text-xs text-zinc-400">{copy.limit}</p>
				<div className="flex flex-wrap gap-3 text-xs text-emerald-400">
					<a
						href="https://developer.bitmovin.com/encoding/docs/per-title-configuration-options"
						target="_blank"
						rel="noreferrer"
					>
						{copy.source}
					</a>
					<a
						href="https://developer.bitmovin.com/encoding/docs/constraining-bandwidth-in-per-title-encoding"
						target="_blank"
						rel="noreferrer"
					>
						{copy.constraints}
					</a>
				</div>
				{suggestions.length ? (
					<div className="space-y-3">
						<h4 className="font-medium text-sm text-zinc-200">
							{copy.suggestions}
						</h4>
						<p className="text-xs text-zinc-400">{copy.ranking}</p>
						{suggestions[0] ? renderSuggestion(suggestions[0]) : null}
						{suggestions.length > 1 ? (
							<details className="space-y-3 text-xs text-zinc-400">
								<summary className="cursor-pointer">
									{copy.otherSuggestions}
								</summary>
								{suggestions.slice(1).map(renderSuggestion)}
							</details>
						) : null}
					</div>
				) : null}
			</details>
		</div>
	);
}
