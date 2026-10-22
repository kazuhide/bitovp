import type { PerTitleGoal } from "@bitovp/core";
import {
	createPerTitleEvaluationAdvice,
	hasAutomaticPerTitleSettings,
	hasPerTitleEvaluationCountEvidence,
	type PerTitleAdvice,
	type PerTitleAdviceOptions,
} from "./per-title-simulator-advice";
import { perTitleAnalysisCandidates } from "./per-title-simulator-analysis-candidates";
import { assessPerTitleCountStructure } from "./per-title-simulator-analysis-count";
import { perTitleCountDirectedCandidates } from "./per-title-simulator-analysis-count-layouts";
import {
	assessPerTitleDependencies,
	type PerTitleDependencyAssessment,
} from "./per-title-simulator-analysis-dependencies";
import {
	assessPerTitleLadder,
	type PerTitleLadderAssessment,
} from "./per-title-simulator-analysis-ladder";
import { perTitleWholeLadderCandidates } from "./per-title-simulator-analysis-layouts";
import {
	assessPerTitleReach,
	type PerTitleReachAssessment,
} from "./per-title-simulator-analysis-reach";
import {
	assessPerTitleValidity,
	type PerTitleValidityFinding,
} from "./per-title-simulator-analysis-validity";
import { tunePerTitleSettings } from "./per-title-simulator-tuning";

export type PerTitleAnalysisIntent = "cap" | "bandwidth" | "count" | "preserve";
type Message = { en: string; ja: string };
export type PerTitleAnalysisResult = {
	intent: PerTitleAnalysisIntent;
	reach: PerTitleReachAssessment;
	ladder: PerTitleLadderAssessment;
	countStructure: ReturnType<typeof assessPerTitleCountStructure>;
	decision: {
		status:
			| "proposal"
			| "keep-current"
			| "no-certified-candidate"
			| "inspect-only";
		message: Message;
	};
	search: {
		generated: number;
		certified: number;
		rejected: Record<string, number>;
	};
	findings: PerTitleValidityFinding[];
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
	before: PerTitleLadderAssessment,
	after: PerTitleLadderAssessment,
): Message {
	const rate = (value: number) =>
		new Intl.NumberFormat("en", {
			maximumFractionDigits: 3,
		}).format(value / 1000);
	const global = item.proposal.api.global;
	if ((item.facts.preservedCount ?? 0) > 0)
		return {
			en: `Keep the overall ${rate(global.minBitrate)}–${rate(global.maxBitrate)} kbps limits and the checked count of ${item.facts.preservedCount}. Recheck the revised boundaries and spacing over the whole input interval. This is a count-preserving configuration proposal, not a quality-equivalence result.`,
			ja: `全体 ${rate(global.minBitrate)}～${rate(global.maxBitrate)} kbps と、検証済みの ${item.facts.preservedCount} 本を維持します。変更後の境界と段間隔も全区間で再検証した案です。画質が同等という判定ではありません。`,
		};
	if ((item.facts.requiredCount ?? 0) > 0)
		return {
			en: `Keep the overall ${rate(global.minBitrate)}–${rate(global.maxBitrate)} kbps limits and the ${item.facts.countIsMaximum === 1 ? "maximum of" : "required"} ${item.facts.requiredCount} outputs. ${item.proof === "model-count" ? "The proposed count passes the configuration model." : "Template roles and whole-interval spacing are rechecked; upper alternatives share the same output slot."} The native generated count still needs a media check.`,
			ja: `全体 ${rate(global.minBitrate)}～${rate(global.maxBitrate)} kbps と、${item.facts.countIsMaximum === 1 ? "最大" : "指定の"} ${item.facts.requiredCount} 本という要件を維持する案です。${item.proof === "model-count" ? "候補の本数は計算モデルで確認しています。" : "構成と段間隔を全区間で再検査し、上位候補は同じ1枠の選択肢として扱います。"}実際の生成本数は素材で確認してください。`,
		};
	if ((item.facts.wholeLadderImprovement ?? 0) > 0) {
		const tracked = after.topResponse.status === "tracked";
		const simpleBefore = before.topResponse.floor;
		const simpleAfter = after.topResponse.floor;
		return {
			en: `${tracked ? `Direct connection passes over the whole ${rate(after.topResponse.domain?.minimum ?? global.minBitrate)}–${rate(global.maxBitrate)} kbps analysis interval.` : `Extend the fixed curves toward ${rate(global.maxBitrate)} kbps; spacing is rechecked over the whole input interval.`} Upper placement room: ${before.upperSlots?.maximum ?? "unknown"}→${after.upperSlots?.maximum ?? "unknown"} (not output count).${simpleBefore !== null && simpleAfter !== null && simpleAfter !== simpleBefore ? ` Simple-input forced target: ${rate(simpleBefore)}→${rate(simpleAfter)} kbps.` : ""} Global limits and quality controls stay unchanged; actual count and quality require media.`,
			ja: `${tracked ? `解析値 ${rate(after.topResponse.domain?.minimum ?? global.minBitrate)}～${rate(global.maxBitrate)} kbps の全区間で、最上固定段から直接接続できる案です。` : `固定段が ${rate(global.maxBitrate)} kbps まで応答するよう調整し、段間隔を全区間で再検証した案です。`} 上側の配置余地は ${before.upperSlots?.maximum ?? "未確定"}→${after.upperSlots?.maximum ?? "未確定"} 段です。${simpleBefore !== null && simpleAfter !== null && simpleAfter !== simpleBefore ? `単純側の強制追加目標は ${rate(simpleBefore)}→${rate(simpleAfter)} kbps に変わります。` : ""} 全体範囲と画質設定は維持します。実際の本数と画質は素材で確認してください。`,
		};
	}
	if (
		item.proof === "model-count" &&
		item.goal.strategy === "fixed-ranges" &&
		item.changes.some((change) =>
			change.key.endsWith("ComplexityBoundaryForMaxBitrate"),
		)
	)
		return {
			en: "Keep the requested bitrate bands and adjust complexity boundaries and steps. The count model is rechecked over the entire explicit minimum-to-maximum analysis interval; this is not a quality-equivalence result.",
			ja: "指定したビットレート範囲を保ち、複雑度境界と段間比率を調整します。全体下限～上限の解析値で本数条件を再検証した案で、画質が同等という判定ではありません。",
		};
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

/** Placement-risk wording applies to every certified objective and explanation path. */
function explainPlacementRisk(
	message: Message,
	facts: PerTitleAdvice["facts"],
): Message {
	if (!((facts.capacityIncrease ?? 0) > 0 || facts.capacityUnresolved === 1))
		return message;
	const warning =
		facts.capacityUnresolved === 1
			? {
					en: "Minimum spacing was reduced; arithmetic placement capacity exceeds the model bound. The increase is unresolved, not zero.",
					ja: "最小段間隔を下げると配置本数の検証上限を超えます。増加量は未確定で、増えないという意味ではありません。",
				}
			: {
					en: "Arithmetic placement room increases under the smaller minimum spacing. This is not a native output-count prediction.",
					ja: "最小段間隔を下げるため、計算上の配置余地が増えます。実際の出力本数の予測ではありません。",
				};
	return {
		en: `${message.en} ${warning.en}`,
		ja: `${message.ja}${warning.ja}`,
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
	const ladder = assessPerTitleLadder(normalized.goal, proposal);
	const countStructure = assessPerTitleCountStructure(
		normalized.goal,
		proposal,
	);
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
		ladder,
		countStructure,
		decision: {
			status: "inspect-only",
			message: {
				en: "Further verification is needed before a checked adjustment can be offered.",
				ja: "調整案の検証には追加の確認が必要です。",
			},
		},
		search: { generated: 0, certified: 0, rejected: {} },
		findings,
		dependencies: assessPerTitleDependencies(normalized.goal, proposal),
		advice: [],
		quality,
	};
	findings.push(...assessPerTitleValidity(goal, proposal));
	if (countStructure.status === "declared-compatible")
		add(
			"declared-count-structure",
			"info",
			`The required ${countStructure.required} outputs are evaluated as ${countStructure.lower?.required ?? 0} lower + ${countStructure.fixedRowIds.length} fixed + ${countStructure.upper?.required ?? 0} upper. Upper templates are alternatives, not one output each. The declared requirement is separate from the native count check.`,
			`指定の ${countStructure.required} 本を、下位 ${countStructure.lower?.required ?? 0} 本・固定 ${countStructure.fixedRowIds.length} 本・上位 ${countStructure.upper?.required ?? 0} 本として評価します。上位テンプレートは選択肢であり、候補ごとに1本とは数えません。指定要件と実際の生成本数は分けて確認します。`,
		);
	if (
		countStructure.status === "declared-compatible" &&
		countStructure.risks.includes("lower-extra-slot-capacity")
	)
		add(
			"declared-lower-reuse-risk",
			"warning",
			`One lower output is required, but the current spacing leaves room for more bitrate points below the first fixed output. The lower ordinary template can be reused. Recheck the minimum step together with the first fixed band and its neighbours; a template count is not an output-count limit.`,
			"下位は1本の要件ですが、現在の段間隔では最初の固定段より下に複数のビットレート点を置く余地があります。同じ通常テンプレートが複数回使われ得るため、最小段間隔・最初の固定段の範囲・隣接段を合わせて調整する必要があります。",
		);
	if (
		countStructure.declaredCount !== null &&
		countStructure.required !== null &&
		countStructure.declaredCount !== countStructure.required
	)
		add(
			"declared-count-roles-mismatch",
			"warning",
			`The declared template roles describe ${countStructure.declaredCount} outputs, while the requirement is ${countStructure.required}. Additional ordinary use or other output roles need analysis before a matching proposal can be checked.`,
			`テンプレートの役割から組み立てた構成は ${countStructure.declaredCount} 本、指定は ${countStructure.required} 本です。通常テンプレートの追加利用など、ほかの出力枠も検討する必要があります。`,
		);
	if (ladder.earlySaturationRows.length)
		add(
			"early-fixed-saturation",
			"warning",
			`${ladder.earlySaturationRows.length} fixed curve(s) reach their upper target before the overall maximum. A reachable top does not establish that the interior ladder scales with it.`,
			`固定段 ${ladder.earlySaturationRows.length} 個が全体上限より前に上側目標へ到達します。最上段が上限に届いても、中間段が追従するとは限りません。`,
		);
	if (ladder.topResponse.status === "gap")
		add(
			"interior-top-connection-gap",
			"warning",
			`At analysis input ${ladder.topResponse.witnessInput} bps, some permitted fixed rates cannot connect directly under the selected spacing. Forced fallback and direct branches can therefore behave differently inside the interval.`,
			`解析値 ${ladder.topResponse.witnessInput} bps では、許容される固定目標の一部が指定の段間比率で直接接続できません。区間の途中で強制追加と直接接続の挙動が変わり得ます。`,
		);
	const forcedCount =
		proposal.api.global.fixedResolutionAndBitrateConfiguration
			?.forcedRenditionAboveHighestFixedRepresentation ?? 0;
	if (
		ladder.upperSlots &&
		forcedCount > 0 &&
		ladder.upperSlots.maximum > forcedCount
	)
		add(
			"upper-extra-slot-capacity",
			"warning",
			`Minimum spacing permits up to ${ladder.upperSlots.maximum} ordinary upper placements at the high-input hypothesis, more than the ${forcedCount} forced additions. Placement capacity is not a native count prediction.`,
			`上限の想定では、最小の段間比率で上側に ${ladder.upperSlots.maximum} 段を置ける余地があります。強制追加 ${forcedCount} 本の指定だけでは通常段の追加を制限できません。配置余地であり、実際の本数の予測ではありません。`,
		);
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
		!hasPerTitleEvaluationCountEvidence(normalized.goal, proposal)
	)
		add(
			"count-conditional",
			"warning",
			"The requested count remains a constraint, but the current native template selection is not statically proven to satisfy it. Verify the generated ladder with media.",
			"指定した本数は条件として維持しますが、実際に生成される本数は設定だけでは保証できません。素材で出力ラダーを確認してください。",
		);
	if (
		hasPerTitleEvaluationCountEvidence(normalized.goal, proposal) &&
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
	if (
		(intent === "count" || intent === "preserve") &&
		goal.countPolicy.kind === "unrestricted"
	) {
		add(
			"count-required",
			"info",
			"Choose an exact or maximum rendition count in the requirements, then evaluate again.",
			"左の要件で「本数を固定」または「本数の上限」を指定して、再評価してください。",
		);
		result.decision.message = {
			en: "Choose the rendition count to preserve in the requirements, then evaluate again.",
			ja: "左の要件で維持する本数を指定して、再評価してください。",
		};
		return result;
	}
	if (
		intent === "preserve" &&
		!hasPerTitleEvaluationCountEvidence(normalized.goal, proposal)
	) {
		add(
			"preserve-count-unverified",
			"warning",
			"Evaluation uses the requested count as a requirement even when the current generated count is unresolved. Conditional proposals retain that requirement and the template roles; they do not certify that the native output count is unchanged.",
			"現在の生成本数が未確定でも、指定した本数を要件として評価します。調整案はその要件とテンプレート構成を維持し、実際の本数は現設定と候補の出力で確認します。",
		);
	}
	if (
		intent === "preserve" &&
		goal.strategy !== "fixed-ranges" &&
		!hasPerTitleEvaluationCountEvidence(normalized.goal, proposal)
	) {
		result.decision.message = {
			en: "The automatic template does not establish an output structure to retain. Use the count-focused goal to inspect spacing proposals for the requested count.",
			ja: "現在の自動テンプレートからは、維持する出力構成を定められません。「本数の条件を優先」で、指定本数に向けた段間隔の案を確認してください。",
		};
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
	const reject = (reason: string) => {
		result.search.rejected[reason] = (result.search.rejected[reason] ?? 0) + 1;
	};
	const candidates = [
		...perTitleAnalysisCandidates(goal, proposal, reach, intent, context),
		...(intent === "cap" || intent === "preserve"
			? perTitleCountDirectedCandidates(goal, proposal, context)
			: []),
		...(intent === "cap" || intent === "preserve"
			? perTitleWholeLadderCandidates(goal, proposal, context)
			: []),
	];
	for (const candidate of candidates) {
		result.search.generated++;
		const item = createPerTitleEvaluationAdvice(goal, candidate, context);
		if (!item) {
			reject("api-or-held-constraint");
			continue;
		}
		const checked = assessPerTitleReach(item.goal, item.proposal);
		const checkedLadder = assessPerTitleLadder(item.goal, item.proposal);
		const checkedStructure = assessPerTitleCountStructure(
			item.goal,
			item.proposal,
		);
		if (
			item.goal.minBitrate !== goal.minBitrate ||
			item.goal.maxBitrate !== goal.maxBitrate ||
			JSON.stringify(item.goal.countPolicy) !== JSON.stringify(goal.countPolicy)
		) {
			reject("requirements-changed");
			continue;
		}
		if (
			assessPerTitleValidity(item.goal, item.proposal).some(
				(finding) => finding.severity === "conflict",
			)
		) {
			reject("invalid-candidate");
			continue;
		}
		if (
			reach.count.status === "model-checked" &&
			checked.count.status !== "model-checked"
		) {
			reject("count-proof-lost");
			continue;
		}
		const currentIntervals = ladder.intervals;
		const nextIntervals = checkedLadder.intervals;
		const connected = (
			value: PerTitleLadderAssessment,
			minimum: number,
			maximum: number,
		) =>
			!!value.intervals &&
			value.intervals.maximumWithinRowRatio < minimum &&
			(value.intervals.minimumAdjacentRatio ?? Infinity) >= minimum &&
			(value.intervals.maximumAdjacentRatio ?? 0) <= maximum;
		if (
			connected(
				ladder,
				proposal.api.global.minBitrateStepSize,
				proposal.api.global.maxBitrateStepSize,
			) &&
			!connected(
				checkedLadder,
				item.proposal.api.global.minBitrateStepSize,
				item.proposal.api.global.maxBitrateStepSize,
			)
		) {
			reject("fixed-spacing-regression");
			continue;
		}
		if (
			ladder.lowerConnection?.fitsMaximum &&
			checkedLadder.lowerConnection?.fitsMaximum === false
		) {
			reject("lower-connection-regression");
			continue;
		}
		if (
			ladder.topResponse.status === "tracked" &&
			checkedLadder.topResponse.status !== "tracked"
		) {
			reject("top-tracking-regression");
			continue;
		}
		const wholeImprovement =
			connected(
				checkedLadder,
				item.proposal.api.global.minBitrateStepSize,
				item.proposal.api.global.maxBitrateStepSize,
			) &&
			checkedLadder.lowerConnection?.fitsMaximum !== false &&
			((checkedLadder.topResponse.status === "tracked" &&
				ladder.topResponse.status !== "tracked") ||
				(ladder.lowerSlots !== null &&
					checkedLadder.lowerSlots !== null &&
					checkedLadder.lowerSlots.maximum < ladder.lowerSlots.maximum) ||
				(ladder.upperSlots !== null &&
					checkedLadder.upperSlots !== null &&
					checkedLadder.upperSlots.maximum < ladder.upperSlots.maximum) ||
				(checkedLadder.earlySaturationRows.length <
					ladder.earlySaturationRows.length &&
					!!currentIntervals &&
					!!nextIntervals &&
					nextIntervals.maximumWithinRowRatio <
						item.proposal.api.global.minBitrateStepSize));
		if (intent === "cap") {
			if (
				checked.status !== "conditional-reachable" ||
				checked.adaptation !== "conditional" ||
				reachRank(checked) < reachRank(reach) ||
				(reachRank(checked) === reachRank(reach) && !wholeImprovement)
			) {
				reject("no-objective-improvement");
				continue;
			}
		} else if (intent === "preserve") {
			const declaredMixed =
				countStructure.status === "declared-compatible" &&
				checkedStructure.status === "declared-compatible" &&
				checkedStructure.declaredCount === countStructure.declaredCount &&
				checkedStructure.required === countStructure.required;
			if (
				(item.proof !== "model-count" && !declaredMixed) ||
				(!wholeImprovement &&
					(item.proof !== "model-count" ||
						hasPerTitleEvaluationCountEvidence(normalized.goal, proposal))) ||
				reachRank(checked) < reachRank(reach)
			) {
				reject("count-or-objective-not-certified");
				continue;
			}
			// A declared output budget is not permission to make a known source of
			// additional placements worse, even when native selection is unresolved.
			if (
				item.proof !== "model-count" &&
				(["lowerSlots", "upperSlots"] as const).some(
					(side) =>
						ladder[side] !== null &&
						(checkedLadder[side] === null ||
							checkedLadder[side].maximum > ladder[side].maximum),
				)
			) {
				reject("declared-count-placement-regression");
				continue;
			}
		} else if (
			item.proof !== "model-count" ||
			(!proposal.diagnostics.some(
				(diagnostic) => diagnostic.severity === "conflict",
			) &&
				hasPerTitleEvaluationCountEvidence(normalized.goal, proposal))
		) {
			reject("count-or-objective-not-certified");
			continue;
		}
		if (
			intent === "preserve" &&
			goal.strategy === "fixed-ranges" &&
			reach.count.status === "model-checked" &&
			(checked.count.minimum !== reach.count.minimum ||
				checked.count.maximum !== reach.count.maximum)
		) {
			reject("count-changed");
			continue;
		}
		const key = JSON.stringify(item.proposal.api);
		if (seen.has(key)) continue;
		seen.add(key);
		item.facts = {
			...item.facts,
			reachRank: reachRank(checked),
			maximum: goal.maxBitrate,
			wholeLadderImprovement: Number(wholeImprovement),
			tracked: Number(checkedLadder.topResponse.status === "tracked"),
			capacityIncrease:
				ladder.globalCapacity !== null && checkedLadder.globalCapacity !== null
					? Math.max(0, checkedLadder.globalCapacity - ladder.globalCapacity)
					: item.proposal.api.global.minBitrateStepSize <
							proposal.api.global.minBitrateStepSize
						? Number.MAX_SAFE_INTEGER
						: 0,
			capacityUnresolved: Number(
				(ladder.globalCapacity === null ||
					checkedLadder.globalCapacity === null) &&
					item.proposal.api.global.minBitrateStepSize <
						proposal.api.global.minBitrateStepSize,
			),
			upperSlots: checkedLadder.upperSlots?.maximum ?? 256,
			lowerSlots: checkedLadder.lowerSlots?.maximum ?? 256,
			earlySaturation: checkedLadder.earlySaturationRows.length,
			preservedCount:
				intent === "preserve" && reach.count.status === "model-checked"
					? (reach.count.maximum ?? 0)
					: 0,
			requiredCount:
				intent === "preserve" && goal.countPolicy.kind !== "unrestricted"
					? goal.countPolicy.count
					: 0,
			countIsMaximum: Number(goal.countPolicy.kind === "maximum"),
		};
		item.explanation = explainPlacementRisk(
			explanation(item, checked, ladder, checkedLadder),
			item.facts,
		);
		result.advice.push(item);
		result.search.certified++;
	}
	result.advice.sort(
		(a, b) =>
			(intent === "preserve"
				? (a.facts.lowerSlots ?? 256) +
					(a.facts.upperSlots ?? 256) -
					(b.facts.lowerSlots ?? 256) -
					(b.facts.upperSlots ?? 256)
				: 0) ||
			(b.facts.reachRank ?? 0) - (a.facts.reachRank ?? 0) ||
			(a.facts.capacityIncrease ?? 0) - (b.facts.capacityIncrease ?? 0) ||
			(b.facts.tracked ?? 0) - (a.facts.tracked ?? 0) ||
			(a.facts.upperSlots ?? 256) - (b.facts.upperSlots ?? 256) ||
			(a.facts.earlySaturation ?? 0) - (b.facts.earlySaturation ?? 0) ||
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
	if (result.advice.length)
		result.decision = {
			status: "proposal",
			message: {
				en: "A configuration adjustment passed the selected goal and constraint checks. Review its changes and tradeoffs before adoption.",
				ja: "目的と制約の検証を通った調整案があります。変更内容と影響を確認してから反映できます。",
			},
		};
	else if (
		(intent === "count" || intent === "preserve") &&
		hasPerTitleEvaluationCountEvidence(normalized.goal, proposal) &&
		!findings.some(
			(finding) =>
				finding.severity !== "info" && finding.code !== "cap-blocked",
		)
	)
		result.decision = {
			status: "keep-current",
			message: {
				en: "The checked count and spacing constraints require no repair. This does not establish a quality or bandwidth optimum.",
				ja: "確認した本数と段間隔の条件には修正が必要な点はありません。画質や転送量が最適という判定ではありません。",
			},
		};
	else
		result.decision = {
			status: "no-certified-candidate",
			message: {
				en: "The search did not certify an improving adjustment under the current constraints. This is not a finding that the settings are optimal.",
				ja: "現在の制約を守る改善案は今回の探索では検証できませんでした。現設定が最適という判定ではありません。",
			},
		};
	if (!result.advice.length && intent === "bandwidth")
		result.decision = {
			status: "inspect-only",
			message: {
				en: "No quality-preserving bitrate reduction can be established without representative-media results. The configuration checks are available below.",
				ja: "画質を保った削減案の判断には素材での比較が必要です。設定の整合性は以下で確認できます。",
			},
		};
	if (result.decision.status === "no-certified-candidate")
		add(
			"no-checked-candidate",
			"info",
			"The bounded search found no certified improvement with the held values. This does not establish impossibility; review the fixed constraints and media-dependent settings below.",
			"固定した値を守る調整案は、今回の探索では検証できませんでした。実現不可能という意味ではありません。固定条件と素材に依存する設定を確認してください。",
		);
	return result;
}
