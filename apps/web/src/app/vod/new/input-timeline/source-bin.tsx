"use client";

import {
	MAX_VOD_TIMELINE_SOURCES,
	type VodInputTimelineSourceFacts,
} from "@bitovp/core/vod-input-timeline";
import { FileAudio2, FileVideo2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { baseName } from "@/lib/format";
import type { WizardInputFile } from "../build-plan";
import { useTimelineLabels } from "./labels";
import { formatTime } from "./timeline-state";

export function SourceBin({
	sources,
	facts,
	selectedKey,
	disabled,
	full,
	onSelect,
	onAdd,
	onAddSource,
}: {
	sources: WizardInputFile[];
	facts: VodInputTimelineSourceFacts[];
	selectedKey: string | null;
	disabled: boolean;
	full: boolean;
	onSelect: (key: string) => void;
	onAdd: (source: VodInputTimelineSourceFacts) => void;
	onAddSource: () => void;
}) {
	const l = useTimelineLabels();
	return (
		<section aria-label={l.sources} className="min-w-0 space-y-2">
			<div className="flex items-center justify-between gap-2">
				<h3 className="font-medium text-sm text-zinc-200">{l.sources}</h3>
				<Button
					size="sm"
					variant="ghost"
					disabled={disabled || sources.length >= MAX_VOD_TIMELINE_SOURCES}
					onClick={onAddSource}
				>
					<Plus aria-hidden className="h-3.5 w-3.5" />
					{l.addSource}
				</Button>
			</div>
			<ul className="max-h-64 space-y-1 overflow-y-auto lg:max-h-80">
				{sources
					.filter((source) => source.path)
					.map((source) => {
						const fact = facts.find((item) => item.key === source.key);
						const name = baseName(source.path);
						const Icon = fact?.video === null ? FileAudio2 : FileVideo2;
						return (
							<li
								key={source.key}
								className="flex min-w-0 items-center gap-1 rounded border border-zinc-800 p-1"
							>
								<button
									type="button"
									aria-pressed={selectedKey === source.key}
									aria-label={l.previewNamed.replace("{name}", name)}
									onClick={() => onSelect(source.key)}
									className="flex min-w-0 flex-1 items-center gap-2 rounded px-1 py-2 text-left text-xs hover:bg-zinc-900 focus-visible:outline-2 focus-visible:outline-emerald-400"
								>
									<Icon
										aria-hidden
										className="h-7 w-7 shrink-0 text-zinc-500"
									/>
									<span className="min-w-0">
										<span
											className="block truncate font-medium text-zinc-200"
											title={source.path}
										>
											{name}
										</span>
										<span className="block truncate text-zinc-400">
											{fact
												? `${formatTime(fact.durationMs)} · ${fact.video ? `${fact.video.width}×${fact.video.height}` : l.audio}`
												: l.unknown}
										</span>
									</span>
								</button>
								<Button
									size="icon"
									variant="ghost"
									aria-label={l.addNamed.replace("{name}", name)}
									title={l.appendWhole}
									disabled={disabled || !fact || full}
									onClick={() => fact && onAdd(fact)}
								>
									<Plus aria-hidden className="h-4 w-4" />
								</Button>
							</li>
						);
					})}
			</ul>
			{!sources.some((source) => source.path) && (
				<p className="text-xs text-zinc-400">{l.empty}</p>
			)}
		</section>
	);
}
