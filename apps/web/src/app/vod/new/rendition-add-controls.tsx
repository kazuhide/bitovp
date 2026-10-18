"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { InfoHint } from "@/components/ui/info-hint";
import { SelectNative } from "@/components/ui/input";
import { useT } from "@/lib/i18n/context";

export function RenditionAddControls({
	kind,
	label,
	choices,
	onAdd,
}: {
	kind: "video" | "audio";
	label: string;
	choices: { key: string; index: number; label: string }[];
	onAdd: (sourceIndex: number | undefined) => void;
}) {
	const { t } = useT();
	const [selected, setSelected] = useState<string | null>(null);
	const source = choices.find((choice) => choice.key === selected);
	const value =
		selected === "" ? "" : (source?.key ?? choices.at(-1)?.key ?? "");
	const sourceLabel = t(
		kind === "video" ? "ladder.videoCopySource" : "ladder.audioCopySource",
	);
	return (
		<div className="ml-auto flex w-full min-w-0 max-w-full shrink-0 items-center justify-end gap-2 sm:w-auto [&>span]:shrink-0">
			{choices.length > 0 ? (
				<>
					<SelectNative
						aria-label={sourceLabel}
						className="h-8 w-44 min-w-0 flex-1 py-1 text-xs sm:flex-initial"
						value={value}
						onChange={(event) => setSelected(event.target.value)}
					>
						<option value="">{t("ladder.defaultSettings")}</option>
						{choices.map((choice) => (
							<option key={choice.key} value={choice.key}>
								{choice.label}
							</option>
						))}
					</SelectNative>
					<InfoHint labelFor={sourceLabel} text={t("ladder.copyHelp")} />
				</>
			) : null}
			<Button
				variant="secondary"
				size="sm"
				className="shrink-0"
				onClick={() =>
					onAdd(choices.find((choice) => choice.key === value)?.index)
				}
			>
				{label}
			</Button>
		</div>
	);
}

export function videoCopyLabel(
	video: {
		codec?: string;
		height: number | null;
		bitrate: number | null;
		extras?: { name?: string; key?: string };
	},
	index: number,
): string {
	return `${index + 1}. ${video.extras?.name ? `${video.extras.name} · ` : ""}${video.codec ?? "H264"} · ${video.height === null ? "Auto" : `${video.height}p`} · ${video.bitrate === null ? "Auto" : `${Math.round(video.bitrate / 1000)}k`}`;
}

export function audioCopyLabel(
	audio: {
		codec?: string;
		bitrate: number;
		rate: number;
		extras?: { name?: string; key?: string };
	},
	index: number,
): string {
	return `${index + 1}. ${audio.extras?.name ? `${audio.extras.name} · ` : ""}${audio.codec ?? "AAC"} · ${Math.round(audio.bitrate / 1000)}k · ${audio.rate / 1000}kHz`;
}
