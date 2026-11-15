"use client";
import type { CaptionOmission } from "@bitovp/core";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n/context";

function sourceTime(us: number) {
	const seconds = us / 1_000_000;
	return `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(2).padStart(5, "0")}`;
}

export function CaptionOmissions({
	omissions,
	onEdit,
}: {
	omissions?: readonly CaptionOmission[];
	onEdit: () => void;
}) {
	const { locale } = useT();
	if (!omissions?.length) return null;
	const ja = locale === "ja";
	return (
		<details className="rounded-lg bg-zinc-900 px-3 py-2 text-sm text-zinc-400">
			<summary className="cursor-pointer">
				{ja ? "省略した字幕" : "Omitted captions"} · {omissions.length}
			</summary>
			<div className="mt-3 space-y-3">
				<p>
					{ja
						? "表示時刻を確定できない発話は字幕に含めていません。必要な場合は、再生位置を合わせて字幕を追加できます。"
						: "Speech without a verified timing is left out of the captions. Position the playhead and add a caption manually if needed."}
				</p>
				<p className="text-xs">
					{ja
						? "元映像の発話区間（字幕の表示時刻ではありません）"
						: "Source speech ranges (not caption display times)"}
				</p>
				<ul className="max-h-48 space-y-2 overflow-y-auto">
					{omissions.map((omitted) => (
						<li key={omitted.segmentIndex} className="break-words">
							<span className="block text-xs tabular-nums">
								{sourceTime(omitted.sourceStartUs)}–
								{sourceTime(omitted.sourceEndUs)}
							</span>
							<span>{omitted.textPreview}</span>
						</li>
					))}
				</ul>
				<Button size="sm" variant="secondary" onClick={onEdit}>
					{ja ? "字幕を編集" : "Edit captions"}
				</Button>
			</div>
		</details>
	);
}
