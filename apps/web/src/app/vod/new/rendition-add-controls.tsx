"use client";

import { useEffect, useState } from "react";
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
	const [selected, setSelected] = useState<
		| {
				key: string;
				index: number;
				count: number;
				byPosition?: boolean;
		  }
		| ""
		| null
	>(null);
	const options = choices.map((choice) => ({
		...choice,
		value: JSON.stringify([choice.key, choice.index]),
	}));
	const matches = selected
		? options.filter((choice) => choice.key === selected.key)
		: [];
	const position =
		selected && selected.count === choices.length
			? options.find((choice) => choice.index === selected.index)
			: undefined;
	// Derived keys can change on every row entering a collision. Observe the
	// selected position too, so resolving that collision cannot pick its sibling.
	const collision =
		matches.length > 1 ||
		(matches.length === 0 &&
			position !== undefined &&
			options.filter((choice) => choice.key === position.key).length > 1);
	const matchedIndex = matches[0]?.index;
	const positionKey = position?.key;
	const positionIsUnique =
		position !== undefined &&
		options.filter((choice) => choice.key === position.key).length === 1;
	const selectedSource =
		(selected !== "" && selected?.byPosition) || collision
			? position
			: matches[0];
	const source =
		selected === "" ? undefined : (selectedSource ?? options.at(-1));
	const value = source?.value ?? "";
	useEffect(() => {
		if (!selected) return;
		if (selected.byPosition || collision) {
			// A colliding row has only its position as UI identity. If rows were
			// added/removed, return to the last-row default instead of guessing.
			if (selected.count !== choices.length) setSelected(null);
			else if (
				selected.byPosition &&
				positionIsUnique &&
				positionKey !== undefined
			) {
				// The repaired key is unambiguous again, so subsequent reordering
				// must follow that key instead of the old collision position.
				setSelected({
					key: positionKey,
					index: selected.index,
					count: choices.length,
				});
			} else if (!selected.byPosition)
				setSelected({ ...selected, byPosition: true });
		} else if (
			matchedIndex !== undefined &&
			(matchedIndex !== selected.index || selected.count !== choices.length)
		) {
			// Unique domain keys still follow their row through reordering.
			setSelected({ ...selected, index: matchedIndex, count: choices.length });
		}
	}, [
		selected,
		collision,
		choices.length,
		matchedIndex,
		positionKey,
		positionIsUnique,
	]);
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
						onChange={(event) => {
							const choice = options.find(
								(option) => option.value === event.target.value,
							);
							setSelected(
								choice
									? {
											key: choice.key,
											index: choice.index,
											count: choices.length,
										}
									: "",
							);
						}}
					>
						<option value="">{t("ladder.defaultSettings")}</option>
						{options.map((choice) => (
							<option key={choice.value} value={choice.value}>
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
				onClick={() => onAdd(source?.index)}
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
		rate?: number;
		extras?: { name?: string; key?: string };
	},
	index: number,
): string {
	return `${index + 1}. ${audio.extras?.name ? `${audio.extras.name} · ` : ""}${audio.codec ?? "AAC"} · ${Math.round(audio.bitrate / 1000)}k${audio.rate ? ` · ${audio.rate / 1000}kHz` : ""}`;
}
