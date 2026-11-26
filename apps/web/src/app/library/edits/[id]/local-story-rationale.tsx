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
		trailer: "予告編で採用した場面",
		sourceRanges: "作成時の元映像の範囲",
		reviewTrailer: "公開前に映像と音声を確認してください。",
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
		trailer: "Trailer selection",
		sourceRanges: "Original source ranges",
		reviewTrailer: "Review picture and audio before publication.",
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
	const trailer = evidence.trailer;
	return (
		<EditingDetails summary={trailer ? c.trailer : c.title}>
			<p className="text-xs text-zinc-500">{c.context}</p>
			{trailer && (
				<div className="space-y-1 text-xs text-zinc-400">
					<p>{c.reviewTrailer}</p>
					<p className="font-medium">{c.sourceRanges}</p>
					<ul className="flex flex-wrap gap-x-4 gap-y-1 tabular-nums">
						{trailer.windows.map(({ sourceInUs, durationFrames }) => {
							const start = sourceInUs / 1_000_000;
							const end = start + durationFrames / 30;
							return (
								<li key={sourceInUs}>
									{start.toFixed(2)}–{end.toFixed(2)} s
								</li>
							);
						})}
					</ul>
				</div>
			)}
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
