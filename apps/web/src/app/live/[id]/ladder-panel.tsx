"use client";

import {
	type LiveChannelPlan,
	type PlanRendition,
	renditionFamily,
} from "@bitovp/core";
import { formatBitrate } from "@/app/vod/jobs/[id]/rendition-tables";
import { DetailPopover, KeyValueRows } from "@/components/ui/detail-popover";
import { useT } from "@/lib/i18n/context";

/**
 *  item 2 — the live channel's LADDER, which the detail page never
 * rendered: `plan.renditions` was parsed for the DVR calculator and the
 * feeders and then thrown away, while the VOD sibling has full
 * RenditionTables. The channel's whole point is this ladder.
 *
 * INTENT, not measurement: live channels have no per-title results or
 * captured artefacts — the table shows what the channel encodes, straight
 * from the plan. Each row's full parameters open in a DetailPopover
 * (the #80 pattern: a count or label whose content exists must make that
 * content reachable in place).
 */

function heightOf(rendition: PlanRendition): string {
	const h = (rendition as { height?: number }).height;
	return typeof h === "number" ? `${h}p` : "—";
}

function bitrateOf(rendition: PlanRendition): string {
	const b = (rendition as { bitrate?: number }).bitrate;
	return formatBitrate(typeof b === "number" ? b : undefined);
}

function Row({ rendition }: { rendition: PlanRendition }) {
	const { t } = useT();
	return (
		<tr className="border-zinc-800 border-t">
			<td className="px-3 py-1.5 font-mono text-xs text-zinc-300">
				{rendition.key}
			</td>
			<td className="px-3 py-1.5 text-xs text-zinc-400 uppercase">
				{rendition.codec}
			</td>
			<td className="px-3 py-1.5 text-xs text-zinc-300">
				{heightOf(rendition)}
			</td>
			<td className="px-3 py-1.5 text-xs text-zinc-300">
				{bitrateOf(rendition)}
			</td>
			<td className="px-3 py-1.5 text-xs">
				<DetailPopover
					summary={t("live.ladderParams", {
						count: Object.keys(rendition).length,
					})}
					label={t("live.ladderParamsLabel", { key: rendition.key })}
				>
					<KeyValueRows record={rendition as Record<string, unknown>} />
				</DetailPopover>
			</td>
		</tr>
	);
}

export function LadderPanel({ plan }: { plan: LiveChannelPlan }) {
	const { t } = useT();
	// renditionFamily is CORE's, importing the schema's own codec sets — the
	// first cut forked them in lowercase against UPPERCASE wire literals, so
	// grouping never fired on a real plan and everything rendered as "other"
	// (review of PR #177, C1; codec-families.test.ts exists against exactly
	// this fork and could not see a private copy).
	const video = plan.renditions.filter((r) => renditionFamily(r) === "video");
	const audio = plan.renditions.filter((r) => renditionFamily(r) === "audio");
	const other = plan.renditions.filter(
		(r) => renditionFamily(r) === "subtitle",
	);
	const groups: [string, string, PlanRendition[]][] = [
		["video", t("live.ladderVideo"), video],
		["audio", t("live.ladderAudio"), audio],
		...(other.length > 0
			? ([["other", t("live.ladderOther"), other]] as [
					string,
					string,
					PlanRendition[],
				][])
			: []),
	];
	return (
		<div className="mt-2 space-y-3">
			{groups.map(([id, label, renditions]) =>
				renditions.length > 0 ? (
					<div key={id}>
						<h4 className="mb-1 text-xs text-zinc-500">{label}</h4>
						<div className="overflow-x-auto rounded-md border border-zinc-800">
							<table className="w-full text-left">
								<thead>
									<tr className="text-xs text-zinc-500">
										<th className="px-3 py-1.5 font-medium">
											{t("live.ladderKey")}
										</th>
										<th className="px-3 py-1.5 font-medium">
											{t("live.ladderCodec")}
										</th>
										<th className="px-3 py-1.5 font-medium">
											{t("live.ladderHeight")}
										</th>
										<th className="px-3 py-1.5 font-medium">
											{t("live.ladderBitrate")}
										</th>
										<th className="px-3 py-1.5 font-medium">
											{t("live.ladderDetail")}
										</th>
									</tr>
								</thead>
								<tbody>
									{renditions.map((rendition) => (
										<Row key={rendition.key} rendition={rendition} />
									))}
								</tbody>
							</table>
						</div>
					</div>
				) : null,
			)}
		</div>
	);
}
