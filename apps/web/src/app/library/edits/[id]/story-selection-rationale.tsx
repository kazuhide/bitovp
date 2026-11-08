"use client";

import type { StoryEvidence } from "@bitovp/core";
import { useT } from "@/lib/i18n/context";
import { EditingDetails } from "../../editing-help";

const en = {
	title: "Why this story passage was selected",
	context:
		"A selection record inferred from the available AISA descriptions when this project was created.",
	summary: "Inferred story context",
	elements: "Key elements in the selected events",
	chain: "Selected event sequence",
	details: "Source descriptions and model",
	source: "AISA description",
	model: "Analysis model",
	partial:
		"The requested length includes part of the identified event sequence.",
	insufficient:
		"The descriptions did not establish a clear story arc, so a consecutive scene passage was selected.",
	budget:
		"The search was bounded, and an available consecutive passage was selected.",
	coverage: "The analysis used a portion of the available descriptions",
	roles: {
		SETUP: "Setup",
		CHANGE: "Change",
		OUTCOME: "Outcome",
		REACTION: "Reaction",
		CONTEXT: "Context",
	},
};
const ja = {
	title: "物語に基づく選定理由",
	context:
		"プロジェクト作成時に取得できたAISA記述から、モデルが推定した出来事と選定の記録です。",
	summary: "内容の理解（推定）",
	elements: "選んだ出来事に関わる主な要素",
	chain: "選んだ出来事の流れ",
	details: "根拠の記述と使用モデル",
	source: "AISA記述",
	model: "解析モデル",
	partial: "見つかった出来事の流れから、希望尺に収まる一部を選びました。",
	insufficient:
		"記述から物語のまとまりを十分に特定できず、連続した場面を選びました。",
	budget: "候補の探索を区切り、確保できた連続区間を選びました。",
	coverage: "取得できた記述の一部を使って解析しました",
	roles: {
		SETUP: "導入",
		CHANGE: "変化",
		OUTCOME: "結果",
		REACTION: "反応",
		CONTEXT: "背景",
	},
};

/** Creation provenance remains unchanged when the operator edits the timeline. */
export function StorySelectionRationale({
	evidence,
}: {
	evidence?: StoryEvidence;
}) {
	const c = useT().locale === "ja" ? ja : en;
	if (!evidence) return null;
	const events = evidence.selection.selectedEventIds.flatMap((id) => {
		const event = evidence.graph.events.find((item) => item.id === id);
		return event ? [event] : [];
	});
	const entityIds = new Set(events.flatMap((event) => event.entityIds));
	const entities = evidence.graph.keyEntities.filter((entity) =>
		entityIds.has(entity.id),
	);
	const arc = evidence.graph.arcs.find(
		(item) => item.id === evidence.selection.selectedArcId,
	);
	return (
		<EditingDetails summary={c.title}>
			<p>{c.context}</p>
			<section className="space-y-1">
				<h3 className="font-medium text-zinc-300">{c.summary}</h3>
				<p>{evidence.graph.summary}</p>
			</section>
			{evidence.selection.reason === "PARTIAL_ARC" && <p>{c.partial}</p>}
			{evidence.selection.reason === "METADATA_INSUFFICIENT" && (
				<p>{c.insufficient}</p>
			)}
			{evidence.selection.reason === "SEARCH_BUDGET" && <p>{c.budget}</p>}
			{evidence.inputCoverage.truncated && (
				<p>
					{c.coverage} ({evidence.inputCoverage.includedIntervals} /{" "}
					{evidence.inputCoverage.totalIntervals})
				</p>
			)}
			{events.length > 0 && (
				<section className="space-y-1">
					<h3 className="font-medium text-zinc-300">{c.chain}</h3>
					{arc && <p>{arc.title}</p>}
					<ol className="list-decimal space-y-2 pl-4 [overflow-wrap:anywhere]">
						{events.map((event) => (
							<li key={event.id}>
								<span className="text-zinc-500">{c.roles[event.role]}</span>
								<p>{event.label}</p>
							</li>
						))}
					</ol>
				</section>
			)}
			{entities.length > 0 && (
				<section className="space-y-1">
					<h3 className="font-medium text-zinc-300">{c.elements}</h3>
					<ul className="list-disc space-y-1 pl-4 [overflow-wrap:anywhere]">
						{entities.map((entity) => (
							<li key={entity.id}>{entity.label}</li>
						))}
					</ul>
				</section>
			)}
			<EditingDetails summary={c.details}>
				<dl className="space-y-1 [overflow-wrap:anywhere]">
					<dt className="font-medium text-zinc-300">{c.model}</dt>
					<dd>{evidence.model.model}</dd>
				</dl>
				<ul className="space-y-3 [overflow-wrap:anywhere]">
					{events.flatMap((event) =>
						event.evidence.map((source, index) => (
							<li key={`${event.id}:${source.ref}:${index}`}>
								<blockquote className="border-zinc-700 border-l-2 pl-3">
									{source.quote}
								</blockquote>
								<p className="text-zinc-500">
									{c.source}: {source.ref}
								</p>
							</li>
						)),
					)}
				</ul>
			</EditingDetails>
		</EditingDetails>
	);
}
