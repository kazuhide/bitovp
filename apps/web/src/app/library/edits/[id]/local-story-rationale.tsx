"use client";

import {
	describeLocalStorySelection,
	type LocalStoryEvidence,
} from "@bitovp/core";
import { useT } from "@/lib/i18n/context";
import { EditingDetails } from "../../editing-help";

const copy = {
	ja: {
		title: "ストーリー案で採用した場面",
		context:
			"作成時の選定記録です。編集後のタイムラインとは異なる場合があります。",
		legacy: "当初の構成とは役割が異なる場面です。",
		roles: {
			CONTEXT: "背景",
			ACTION: "行動",
			CHANGE: "変化",
			OUTCOME: "結果",
			POINT: "要点",
		},
	},
	en: {
		title: "Moments selected for this story",
		context:
			"Selection record at creation time. Later timeline edits may differ.",
		legacy: "This moment has a different role from the original proposal.",
		roles: {
			CONTEXT: "Context",
			ACTION: "Action",
			CHANGE: "Change",
			OUTCOME: "Outcome",
			POINT: "Point",
		},
	},
};

export function LocalStoryRationale({
	evidence,
}: {
	evidence?: LocalStoryEvidence;
}) {
	const c = copy[useT().locale];
	if (!evidence) return null;
	const selected = describeLocalStorySelection(evidence);
	return (
		<EditingDetails summary={c.title}>
			<p className="text-xs text-zinc-500">{c.context}</p>
			<ol className="list-decimal space-y-3 pl-4 [overflow-wrap:anywhere]">
				{selected.events.map((event) => (
					<li key={event.beatId}>
						<p className="leading-relaxed">
							<span className="mr-2 text-xs text-zinc-500">
								{c.roles[event.role]}
							</span>
							{event.label}
						</p>
						{!event.roleMatchesBeat && (
							<p className="text-xs text-zinc-500">{c.legacy}</p>
						)}
					</li>
				))}
			</ol>
		</EditingDetails>
	);
}
