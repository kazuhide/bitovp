"use client";

import type { SemanticEvidence } from "@bitovp/core";
import { useT } from "@/lib/i18n/context";
import { EditingDetails } from "../../editing-help";

const en = {
	title: "Why these moments were selected",
	context:
		"Selection record based on the AISA descriptions available when this project was created.",
	profile: "Inferred content type",
	elements: "Key elements",
	moments: "Selected moments",
	insufficient:
		"There were few useful description cues, so scene continuity was preferred.",
	budget:
		"The search limit was reached, so a validated consecutive window was used.",
	profiles: {
		NARRATIVE: "Narrative",
		PRODUCT: "Product",
		INSTRUCTION: "How-to",
		SPORT: "Sport",
		CONVERSATION: "Conversation",
		GENERAL: "General",
	},
};
const ja = {
	title: "自動選定時の根拠",
	context: "プロジェクト作成時のAISA記述に基づく選定記録です。",
	profile: "内容の傾向（推定）",
	elements: "登場する主な要素",
	moments: "選んだ場面",
	insufficient: "場面を選ぶ情報が少ないため、シーンのまとまりを優先しました。",
	budget: "探索の上限に達したため、確保できた連続区間を使いました。",
	profiles: {
		NARRATIVE: "物語",
		PRODUCT: "商品紹介",
		INSTRUCTION: "手順・制作",
		SPORT: "スポーツ",
		CONVERSATION: "対話",
		GENERAL: "一般",
	},
};

/** Immutable selection provenance, kept separate from the current edited timeline. */
export function SemanticSelectionRationale({
	evidence,
}: {
	evidence?: SemanticEvidence;
}) {
	const c = useT().locale === "ja" ? ja : en;
	if (!evidence) return null;
	return (
		<EditingDetails summary={c.title}>
			<p>{c.context}</p>
			<p>
				{c.profile}: {c.profiles[evidence.profile]}
			</p>
			{evidence.selectionReason === "INSUFFICIENT_METADATA" && (
				<p>{c.insufficient}</p>
			)}
			{evidence.selectionReason === "SEARCH_BUDGET" && <p>{c.budget}</p>}
			{evidence.keyEntities.length > 0 && (
				<section className="space-y-1">
					<h3 className="font-medium text-zinc-300">{c.elements}</h3>
					<ul className="list-disc space-y-1 pl-4 [overflow-wrap:anywhere]">
						{evidence.keyEntities.map((entity) => (
							<li key={`${entity.kind}:${entity.label}`}>{entity.label}</li>
						))}
					</ul>
				</section>
			)}
			<section className="space-y-1">
				<h3 className="font-medium text-zinc-300">{c.moments}</h3>
				<ol className="list-decimal space-y-2 pl-4 [overflow-wrap:anywhere]">
					{evidence.selectedMoments.map((moment) => (
						<li key={`${moment.sceneId}:${moment.shotIndex ?? "scene"}`}>
							{moment.label}
						</li>
					))}
				</ol>
			</section>
		</EditingDetails>
	);
}
