"use client";

import type { CfrTimeMap, EditDocument } from "@bitovp/core";
import { useId } from "react";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n/context";
import { moveClip, removeClip, splitClip } from "../edit-model";
import { timelinePoint } from "../timeline-model";

export function TimelineActions({
	document,
	map,
	positionFrame,
	selectedClipId,
	blocked,
	selectionDisabled = false,
	onChange,
	onSelectClip,
}: {
	document: EditDocument;
	map: CfrTimeMap | null;
	positionFrame: number;
	selectedClipId: string | null;
	blocked: boolean;
	selectionDisabled?: boolean;
	onChange: (next: EditDocument) => void;
	onSelectClip: (id: string) => void;
}) {
	const { t } = useT();
	const helpId = useId();
	const point = map ? timelinePoint(document, positionFrame, map) : null;
	const found = document.clips.findIndex((clip) => clip.id === selectedClipId);
	const selected = found >= 0 ? found : (point?.index ?? 0);
	const splitUnavailable =
		blocked || !point || point.localFrame === 0 || document.clips.length >= 20;
	return (
		<div className="space-y-2" aria-describedby={helpId}>
			<label className="flex flex-wrap items-center gap-2 text-sm">
				{t("editing.rangeToEdit")}
				<select
					className="min-w-0 rounded border border-zinc-700 bg-zinc-900 px-2 py-1"
					value={document.clips[selected]?.id ?? ""}
					disabled={selectionDisabled}
					onChange={(event) => onSelectClip(event.target.value)}
				>
					{document.clips.map((clip, index) => (
						<option key={clip.id} value={clip.id}>
							{t("editing.range", { number: index + 1 })}
						</option>
					))}
				</select>
			</label>
			<div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
				<span className="text-emerald-300">
					{t("editing.selectedRange", { number: selected + 1 })}
				</span>
				{point && (
					<span className="text-amber-200">
						{t("editing.cursorRange", { number: point.index + 1 })}
					</span>
				)}
			</div>
			<div className="flex flex-wrap gap-2">
				<Button
					size="sm"
					variant="secondary"
					disabled={splitUnavailable}
					onClick={() => {
						if (splitUnavailable || !point || !map) return;
						const id = crypto.randomUUID();
						onChange(
							splitClip(document, point.index, point.localFrame, id, map),
						);
						onSelectClip(id);
					}}
				>
					{t("editing.splitAtCursor")}
				</Button>
				<Button
					size="sm"
					variant="ghost"
					disabled={blocked || selected <= 0}
					onClick={() => onChange(moveClip(document, selected, -1))}
				>
					{t("editing.moveSelectedEarlier")}
				</Button>
				<Button
					size="sm"
					variant="ghost"
					disabled={blocked || selected >= document.clips.length - 1}
					onClick={() => onChange(moveClip(document, selected, 1))}
				>
					{t("editing.moveSelectedLater")}
				</Button>
				<Button
					size="sm"
					variant="ghost"
					disabled={blocked || document.clips.length <= 1}
					onClick={() => {
						const next = removeClip(document, selected);
						onChange(next);
						const clip = next.clips[Math.min(selected, next.clips.length - 1)];
						if (clip) onSelectClip(clip.id);
					}}
				>
					{t("editing.removeSelected")}
				</Button>
			</div>
			<p id={helpId} className="text-xs text-zinc-400">
				{t("editing.selectionHelp")}
			</p>
		</div>
	);
}
