"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input, SelectNative } from "@/components/ui/input";
import { useT } from "@/lib/i18n/context";
import {
	videoKeys,
	type WizardState,
	type WizardThumbnail,
} from "./build-plan";

/**
 * Parses a comma-separated position list, dropping blank/non-numeric tokens so
 * a trailing comma or stray space doesn't become a spurious 0 position.
 */
export function parsePositions(raw: string): number[] {
	return raw
		.split(",")
		.map((token) => token.trim())
		.filter((token) => token !== "")
		.map(Number)
		.filter((n) => Number.isFinite(n));
}

function PositionsInput({
	id,
	positions,
	onChange,
}: {
	id: string;
	positions: number[];
	onChange: (positions: number[]) => void;
}) {
	// Keep commas and decimal points while typing; the plan stays numeric.
	const [draft, setDraft] = useState<string | null>(null);
	return (
		<Input
			id={id}
			value={draft ?? positions.join(", ")}
			placeholder="0, 10, 30"
			onChange={(e) => {
				setDraft(e.target.value);
				onChange(parsePositions(e.target.value));
			}}
			onBlur={() => setDraft(null)}
		/>
	);
}

/** A `thumbN` key not already used (length+1 can collide after a removal). */
function nextThumbnailKey(thumbnails: WizardThumbnail[]): string {
	const used = new Set(thumbnails.map((t) => t.key));
	let n = thumbnails.length + 1;
	while (used.has(`thumb${n}`)) {
		n += 1;
	}
	return `thumb${n}`;
}

/**
 * Per-stream JPEG thumbnails (encodings.streams.thumbnails). Each row targets
 * a video rendition by its stream key and extracts frames at the given
 * positions. Thumbnails are video-only (validate rejects non-video targets).
 */
export function ThumbnailsSection({
	state,
	onPatch,
}: {
	state: WizardState;
	onPatch: (partial: Partial<WizardState>) => void;
}) {
	const { t } = useT();
	const thumbnails = state.thumbnails ?? [];
	const streamKeys = videoKeys(state.videos);

	const patchThumb = (index: number, partial: Partial<WizardThumbnail>) => {
		const next = [...thumbnails];
		const current = next[index];
		if (!current) {
			return;
		}
		next[index] = { ...current, ...partial };
		onPatch({ thumbnails: next });
	};

	const add = () =>
		onPatch({
			thumbnails: [
				...thumbnails,
				{
					key: nextThumbnailKey(thumbnails),
					streamKey: streamKeys[0] ?? "",
					height: 360,
					positions: [0],
					path: "thumbnail",
				},
			],
		});

	return (
		<section className="space-y-3">
			<div className="flex items-center justify-between">
				<h2 className="font-medium text-sm text-zinc-200">
					{t("wizard.thumbnails")}
				</h2>
				<Button
					variant="secondary"
					size="sm"
					disabled={streamKeys.length === 0}
					onClick={add}
				>
					{t("wizard.addThumbnail")}
				</Button>
			</div>
			{thumbnails.length === 0 ? (
				<p className="text-xs text-zinc-500">
					{t("wizard.noneAddOneToExtractJpegThumbnails")}
				</p>
			) : null}
			{thumbnails.map((thumb, index) => (
				<div
					key={thumb.key}
					className="space-y-3 rounded-md border border-zinc-800 p-3"
				>
					<div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
						<Field label={t("wizard.stream")} htmlFor={`wz-th-${index}-stream`}>
							<SelectNative
								id={`wz-th-${index}-stream`}
								value={thumb.streamKey}
								onChange={(e) =>
									patchThumb(index, { streamKey: e.target.value })
								}
							>
								{!streamKeys.includes(thumb.streamKey) ? (
									<option value={thumb.streamKey}>
										{thumb.streamKey || "—"} {t("wizardX.missingParen")}
									</option>
								) : null}
								{streamKeys.map((k) => (
									<option key={k} value={k}>
										{k}
									</option>
								))}
							</SelectNative>
						</Field>
						<Field
							label={t("wizard.heightPx")}
							htmlFor={`wz-th-${index}-height`}
						>
							<Input
								id={`wz-th-${index}-height`}
								type="number"
								value={thumb.height}
								onChange={(e) =>
									patchThumb(index, { height: Number(e.target.value) })
								}
							/>
						</Field>
						<Field label={t("wizard.unit")} htmlFor={`wz-th-${index}-unit`}>
							<SelectNative
								id={`wz-th-${index}-unit`}
								value={thumb.unit ?? "SECONDS"}
								onChange={(e) =>
									patchThumb(index, {
										unit: e.target.value as WizardThumbnail["unit"],
									})
								}
							>
								<option value="SECONDS">SECONDS</option>
								<option value="PERCENTS">PERCENTS</option>
							</SelectNative>
						</Field>
						<Field
							label={t("wizard.positions")}
							htmlFor={`wz-th-${index}-pos`}
							help={t("wizard.commaSeparatedInTheChosenUnit")}
						>
							<PositionsInput
								id={`wz-th-${index}-pos`}
								positions={thumb.positions}
								onChange={(positions) =>
									patchThumb(index, {
										positions,
									})
								}
							/>
						</Field>
						<Field
							label={t("wizard.outputPath")}
							htmlFor={`wz-th-${index}-path`}
							help={t("wizard.relativeToTheBaseOutputPath")}
						>
							<Input
								id={`wz-th-${index}-path`}
								value={thumb.path ?? ""}
								placeholder={t("wizard.thumbnail")}
								onChange={(e) =>
									patchThumb(index, { path: e.target.value || undefined })
								}
							/>
						</Field>
						<Field
							label={t("wizard.filenamePattern")}
							htmlFor={`wz-th-${index}-pattern`}
							help={t("wizard.defaultThumbnailNumberJpg")}
						>
							<Input
								id={`wz-th-${index}-pattern`}
								value={thumb.pattern ?? ""}
								placeholder={t("wizard.thumbnailNumberJpg")}
								onChange={(e) =>
									patchThumb(index, { pattern: e.target.value || undefined })
								}
							/>
						</Field>
					</div>
					<Button
						variant="secondary"
						size="sm"
						onClick={() =>
							onPatch({ thumbnails: thumbnails.filter((_, i) => i !== index) })
						}
					>
						{t("wizard.remove")}
					</Button>
				</div>
			))}
		</section>
	);
}
