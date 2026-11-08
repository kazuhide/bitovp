"use client";

import type { AisaResultSnapshot } from "@/lib/aisa-live/contracts";
import { formatMomentTime } from "@/lib/aisa-live/timeline-layout";
import { useT } from "@/lib/i18n/context";

export type AisaTimelineItem = {
	moment: AisaResultSnapshot["keyMoments"][number];
	playable: boolean | null;
	descriptions: {
		id: string;
		text: string;
		language: "ja" | "en";
		pending: boolean;
	}[];
};

export function AisaMomentInfo({
	item,
	compact = false,
}: {
	item: AisaTimelineItem;
	compact?: boolean;
}) {
	const { t } = useT();
	const { moment } = item;
	return (
		<div className="min-w-0 space-y-2">
			<div className="flex flex-wrap items-center justify-between gap-2 text-xs">
				<span className="tabular-nums text-zinc-400">
					{formatMomentTime(moment.startInSeconds)}–
					{formatMomentTime(moment.endInSeconds)}
				</span>
				<span className="shrink-0 text-zinc-200">
					{t("aisaLive.importance", { level: moment.importanceLevel })}
				</span>
			</div>
			{item.descriptions.map((description) => (
				<div key={description.id}>
					<p
						lang={description.language}
						className={`break-words text-sm text-zinc-200 ${compact ? "line-clamp-4" : ""}`}
					>
						{description.text}
					</p>
					{description.pending ? (
						<p className="mt-1 text-xs text-zinc-500">
							{t("aisaLive.translationPending")}
						</p>
					) : null}
				</div>
			))}
			{moment.categories.length ? (
				<p className="break-words text-xs text-zinc-500">
					{moment.categories.join(", ")}
				</p>
			) : null}
		</div>
	);
}
