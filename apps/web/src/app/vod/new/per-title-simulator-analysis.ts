import type { PerTitleGoal } from "@bitovp/core";
import {
	createPerTitleEvaluationAdvice,
	hasAutomaticPerTitleSettings,
	type PerTitleAdvice,
	type PerTitleAdviceOptions,
} from "./per-title-simulator-advice";
import { perTitleAnalysisCandidates } from "./per-title-simulator-analysis-candidates";
import {
	assessPerTitleDependencies,
	type PerTitleDependencyAssessment,
} from "./per-title-simulator-analysis-dependencies";
import {
	assessPerTitleReach,
	type PerTitleReachAssessment,
} from "./per-title-simulator-analysis-reach";
import { tunePerTitleSettings } from "./per-title-simulator-tuning";

export type PerTitleAnalysisIntent = "cap" | "bandwidth" | "count";
type Message = { en: string; ja: string };
export type PerTitleAnalysisResult = {
	intent: PerTitleAnalysisIntent;
	reach: PerTitleReachAssessment;
	findings: Array<{
		code: string;
		severity: "conflict" | "warning" | "info";
		message: Message;
	}>;
	dependencies: PerTitleDependencyAssessment[];
	advice: PerTitleAdvice[];
	quality: {
		status: "requires-media";
		message: Message;
		checks: readonly Message[];
	};
};

export const perTitleAnalysisContextKey = (intent: PerTitleAnalysisIntent) =>
	`analysis:${intent}`;
const quality: PerTitleAnalysisResult["quality"] = {
	status: "requires-media",
	message: {
		en: "Settings alone cannot establish the best quality or bitrate savings. Keep quality controls unchanged until a representative-media comparison is available.",
		ja: "画質と削減率の判断には素材での比較が必要です。比較前に画質関連の設定を変更する提案はしません。",
	},
	checks: [
		{
			en: "Encode the same representative low- and high-complexity content with the current and candidate settings, keeping source, codec, frame rate, filters and encoder version equal.",
			ja: "単純な素材と複雑な素材を、現設定と候補設定で比較します。入力・コーデック・フレームレート・フィルター・エンコーダー版を揃えます。",
		},
		{
			en: "Compare the actual rendition count, resolutions, measured video bitrate and segment peaks. A target bitrate or codec rate-control ceiling is not measured bandwidth.",
			ja: "実際の本数・解像度・映像ビットレート・セグメントのピーク値を確認します。設定ビットレートやレート制御の上限は、実測の転送量とは異なります。",
		},
		{
			en: "Compare quality at the same display resolution using a suitable metric such as VMAF plus visual checks of difficult scenes; accept savings only within the agreed quality tolerance.",
			ja: "同じ表示解像度で、VMAFなどの画質指標と難しい場面の目視確認を併用します。許容する画質差を決めてから削減効果を判断します。",
		},
	],
};
const reachRank = (reach: PerTitleReachAssessment) =>
	reach.status === "conditional-reachable"
		? (reach.certainty === "all-permitted-rates" ? 4 : 2) +
			(reach.adaptation === "conditional" ? 1 : 0)
		: 0;

function explanation(
	item: PerTitleAdvice,
	reach: PerTitleReachAssessment,
): Message {
	const rate = (value: number) =>
		new Intl.NumberFormat("en", {
			maximumFractionDigits: 3,
		}).format(value / 1000);
	const global = item.proposal.api.global;
	if (reach.status !== "conditional-reachable" || !reach.high || !reach.low)
		return {
			en: `The count model satisfies the requested count with bitrate steps ${global.minBitrateStepSize}–${global.maxBitrateStepSize}; rendition ranges and quality controls are unchanged.`,
			ja: `各段の範囲と画質設定を保ち、段間比率を ${global.minBitrateStepSize}～${global.maxBitrateStepSize} にすると、本数条件を計算モデル上で満たします。`,
		};
	const rule = global.fixedResolutionAndBitrateConfiguration;
	const factor = rule?.forcedRenditionAboveHighestFixedRepresentationFactor;
	const count = rule?.forcedRenditionAboveHighestFixedRepresentation;
	const method: Message =
		reach.branch === "forced" && factor && count
			? {
					en: `Use ${count} forced step(s) at factor ${factor}, rounding after each multiplication.`,
					ja: `追加段 ${count} 本の倍率を ${factor} とし、1段ごとに整数丸めします。`,
				}
			: reach.branch === "direct" && reach.topFixed
				? {
						en: `The top connection fits bitrate steps ${global.minBitrateStepSize}–${global.maxBitrateStepSize}.`,
						ja: `最上段への接続が、段間比率 ${global.minBitrateStepSize}～${global.maxBitrateStepSize} に収まります。`,
					}
				: {
						en: "Use the existing highest fixed rendition's target range.",
						ja: "既存の最上固定段の目標範囲を使います。",
					};
	return {
		en: `${method.en} At analysis input ${rate(reach.highInput)} kbps, the top can reach ${rate(reach.high.maximum)} kbps; at input ${rate(reach.lowInput)} kbps, its upper target is ${rate(reach.low.maximum)} kbps. These are conditional settings examples.`,
		ja: `${method.ja} 解析値を ${rate(reach.highInput)} kbps と置くと上限 ${rate(reach.high.maximum)} kbps、${rate(reach.lowInput)} kbps と置くと最上段の上側目標は ${rate(reach.low.maximum)} kbps になります。`,
	};
}

/** Configuration dependency analysis, not a replacement for native media analysis. */
export function analyzePerTitleSettings(
	goal: PerTitleGoal,
	intent: PerTitleAnalysisIntent,
	options: PerTitleAdviceOptions = {},
): PerTitleAnalysisResult {
	const normalized = tunePerTitleSettings(goal, goal);
	const proposal = normalized.proposal;
	const reach = assessPerTitleReach(normalized.goal, proposal);
	const findings: PerTitleAnalysisResult["findings"] = [];
	const add = (
		code: string,
		severity: "conflict" | "warning" | "info",
		en: string,
		ja: string,
	) => findings.push({ code, severity, message: { en, ja } });
	const result: PerTitleAnalysisResult = {
		intent,
		reach,
		findings,
		dependencies: assessPerTitleDependencies(normalized.goal, proposal),
		advice: [],
		quality,
	};
	if (
		proposal.status === "conflict" ||
		proposal.diagnostics.some(
			(diagnostic) => diagnostic.severity === "conflict",
		)
	)
		add(
			"configuration-conflict",
			"conflict",
			"The current configuration has conflicting settings. Any candidate must pass validation before adoption.",
			"現在の設定には競合があります。調整案も、設定の検証を通ったものだけを表示します。",
		);
	if (reach.status === "blocked")
		add(
			"cap-blocked",
			"warning",
			"The global maximum is an upper limit. The current fixed targets, spacing or forced-rendition rule prevent the model from reaching it at the high analysis input.",
			"全体上限を設定しても、現在の固定段・段間比率・追加レンディションの条件では、複雑度が高い想定でもそこまで届きません。",
		);
	else if (reach.status === "unknown")
		add(
			"cap-unresolved",
			"info",
			"Media analysis or unresolved template selection determines the top bitrate. This configuration does not provide a static reach guarantee.",
			"最上段は素材の解析やテンプレートの選択で変わるため、設定だけでは上限に届くか判断できません。",
		);
	else
		add(
			"cap-conditionally-reachable",
			"info",
			"The upper limit is reachable under the stated high-input hypothesis. This is a configuration result, not a prediction that the media will use the limit.",
			"複雑度が高い想定では上限に届く設定です。実際にそのビットレートを使うかは素材の解析で決まります。",
		);
	if (reach.adaptation === "flat")
		add(
			"flat-top",
			"warning",
			"The modeled top stays the same at both input hypotheses. Review the forced calculation mode and the stream complexity ranges if adaptation is required.",
			"単純な素材と複雑な素材の想定で、最上段が同じ値になります。追加段の計算方法と各段の複雑度範囲を確認してください。",
		);
	if (
		goal.countPolicy.kind !== "unrestricted" &&
		reach.count.status !== "model-checked"
	)
		add(
			"count-conditional",
			"warning",
			"The requested count remains a constraint, but the current native template selection is not statically proven to satisfy it. Verify the generated ladder with media.",
			"指定した本数は条件として維持しますが、実際に生成される本数は設定だけでは保証できません。素材で出力ラダーを確認してください。",
		);
	if (
		proposal.derivation?.targetSatisfied === true &&
		goal.countPolicy.kind !== "unrestricted"
	)
		add(
			"count-model-checked",
			"info",
			"The current settings satisfy the count requirement in the configuration model. Confirm the native generated count with representative media.",
			"現在の設定は、計算モデル上では本数条件を満たします。実際の出力本数は素材で確認してください。",
		);
	if (intent === "bandwidth")
		add(
			"quality-measurement-required",
			"info",
			"Bitrate and quality controls are not reduced without media evidence. Only a checked count or spacing repair can be proposed here; a quality-preserving optimum requires a rate-quality comparison.",
			"画質を保てる根拠なしにビットレートや画質設定は下げません。ここでは本数・段間の条件を確認し、削減効果は素材で比較します。",
		);
	if (intent === "count" && goal.countPolicy.kind === "unrestricted") {
		add(
			"count-required",
			"info",
			"Choose an exact or maximum rendition count in the requirements, then evaluate again.",
			"左の要件で「本数を固定」または「本数の上限」を指定して、再評価してください。",
		);
		return result;
	}
	if (hasAutomaticPerTitleSettings(goal)) {
		add(
			"automatic-settings",
			"info",
			"The resolved automatic settings are evaluated. Freeze them to review explicit changes before adoption.",
			"自動調整後の値を評価しています。個別の変更案を確認するには、各設定を「固定」にしてください。",
		);
		return result;
	}
	const context = {
		...options,
		contextKey: perTitleAnalysisContextKey(intent),
	};
	const seen = new Set<string>();
	for (const candidate of perTitleAnalysisCandidates(
		goal,
		proposal,
		reach,
		intent,
		context,
	)) {
		const item = createPerTitleEvaluationAdvice(goal, candidate, context);
		if (!item) continue;
		const checked = assessPerTitleReach(item.goal, item.proposal);
		if (
			reach.count.status === "model-checked" &&
			checked.count.status !== "model-checked"
		)
			continue;
		if (intent === "cap") {
			if (
				checked.status !== "conditional-reachable" ||
				checked.adaptation !== "conditional" ||
				reachRank(checked) <= reachRank(reach)
			)
				continue;
		} else if (
			item.proof !== "model-count" ||
			(!proposal.diagnostics.some(
				(diagnostic) => diagnostic.severity === "conflict",
			) &&
				proposal.derivation?.targetSatisfied === true)
		)
			continue;
		const key = JSON.stringify(item.proposal.api);
		if (seen.has(key)) continue;
		seen.add(key);
		item.facts = {
			...item.facts,
			reachRank: reachRank(checked),
			maximum: goal.maxBitrate,
		};
		item.explanation = explanation(item, checked);
		result.advice.push(item);
	}
	result.advice.sort(
		(a, b) =>
			(b.facts.reachRank ?? 0) - (a.facts.reachRank ?? 0) ||
			a.changes.length - b.changes.length ||
			Number(
				a.changes.some((change) => change.key.endsWith("BitrateStepSize")),
			) -
				Number(
					b.changes.some((change) => change.key.endsWith("BitrateStepSize")),
				) ||
			JSON.stringify(a.proposal.api).localeCompare(
				JSON.stringify(b.proposal.api),
			),
	);
	result.advice = result.advice
		.slice(0, 3)
		.map((item, index) => ({ ...item, id: `evaluation-${intent}-${index}` }));
	if (
		!result.advice.length &&
		(intent === "cap"
			? reachRank(reach) < 5
			: proposal.derivation?.targetSatisfied !== true)
	)
		add(
			"no-checked-candidate",
			"info",
			"The bounded search found no certified improvement with the held values. This does not establish impossibility; review the fixed constraints and media-dependent settings below.",
			"固定した値を守る調整案は、今回の探索では検証できませんでした。実現不可能という意味ではありません。固定条件と素材に依存する設定を確認してください。",
		);
	return result;
}
