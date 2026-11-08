"use client";

import {
	type EditClip,
	type EditFraming,
	positionCropRect,
	suggestFixedCrop,
} from "@bitovp/core";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input, SelectNative } from "@/components/ui/input";
import { useT } from "@/lib/i18n/context";
import type { EditingMediaView } from "@/lib/library-editing";
import { clipOutUs, secondsLabel } from "../edit-model";

export function ClipControls({
	clip,
	index,
	count,
	media,
	canvas,
	disabled,
	onChange,
	onRange,
	onSplit,
	onPending,
	onMove,
	onRemove,
	onInspect,
}: {
	clip: EditClip;
	index: number;
	count: number;
	media: EditingMediaView;
	canvas: { width: number; height: number };
	disabled: boolean;
	onChange: (clip: EditClip) => void;
	onRange: (from: number, to: number) => void;
	onSplit: (atFrame: number) => void;
	onPending: (id: string, pending: boolean) => void;
	onMove: (direction: -1 | 1) => void;
	onRemove: () => void;
	onInspect: (part: number) => void;
}) {
	const { t } = useT();
	const sourceStartUs = media.timeMap?.sourceStartUs ?? 0;
	const [from, setFrom] = useState(secondsLabel(clip.sourceInUs));
	const [to, setTo] = useState(secondsLabel(clipOutUs(clip, sourceStartUs)));
	const [error, setError] = useState("");
	const [partIndex, setPartIndex] = useState(0);
	const [splitAtFrame, setSplitAtFrame] = useState(
		Math.floor(clip.durationFrames / 2),
	);
	const sourceOutUs = clipOutUs(clip, sourceStartUs);
	const [previousRange, setPreviousRange] = useState({
		sourceInUs: clip.sourceInUs,
		sourceOutUs,
		durationFrames: clip.durationFrames,
	});
	// Adjust before commit: a passive reset can overwrite the first input
	// after mounting, trimming, or restoring an earlier edit.
	if (
		previousRange.sourceInUs !== clip.sourceInUs ||
		previousRange.sourceOutUs !== sourceOutUs ||
		previousRange.durationFrames !== clip.durationFrames
	) {
		setPreviousRange({
			sourceInUs: clip.sourceInUs,
			sourceOutUs,
			durationFrames: clip.durationFrames,
		});
		if (
			previousRange.sourceInUs !== clip.sourceInUs ||
			previousRange.sourceOutUs !== sourceOutUs
		) {
			setFrom(secondsLabel(clip.sourceInUs));
			setTo(secondsLabel(sourceOutUs));
			setError("");
		}
		if (previousRange.durationFrames !== clip.durationFrames)
			setSplitAtFrame(Math.floor(clip.durationFrames / 2));
	}
	const rangeUnapplied =
		from !== secondsLabel(clip.sourceInUs) || to !== secondsLabel(sourceOutUs);
	const splitUnavailable =
		disabled ||
		count >= 20 ||
		clip.durationFrames < 2 ||
		!media.timeMap ||
		rangeUnapplied;
	const selected = Math.min(partIndex, clip.framing.length - 1);
	const part = clip.framing[selected];
	const geometry =
		media.width && media.height
			? {
					sourceWidth: media.width,
					sourceHeight: media.height,
					targetWidth: canvas.width,
					targetHeight: canvas.height,
				}
			: null;
	const baseCrop = geometry
		? suggestFixedCrop({ ...geometry, centerX: 0.5, centerY: 0.5 })
		: null;
	const maximumZoom =
		geometry && baseCrop
			? Math.min(
					3,
					baseCrop.w /
						suggestFixedCrop({
							...geometry,
							centerX: 0.5,
							centerY: 0.5,
							zoom: 3,
						}).w,
				)
			: 1;
	const cropZoom =
		part?.mode === "CROP" && baseCrop ? baseCrop.w / part.rect.w : 1;
	function updateRangeText(nextFrom: string, nextTo: string) {
		setFrom(nextFrom);
		setTo(nextTo);
		onPending(
			clip.id,
			nextFrom !== secondsLabel(clip.sourceInUs) ||
				nextTo !== secondsLabel(sourceOutUs),
		);
	}
	function apply() {
		try {
			if (!from.trim() || !to.trim()) throw new Error();
			onRange(Number(from), Number(to));
			onPending(clip.id, false);
			setError("");
		} catch {
			setError(t("editing.rangeInvalid"));
		}
	}
	function frame(next: EditFraming) {
		onChange({
			...clip,
			framing: clip.framing.map((current, position) =>
				position === selected
					? { ...next, origin: "MANUAL", manualOverride: true }
					: current,
			),
		});
	}
	function crop(x: number, y: number, zoom?: number) {
		if (!part || !media.width || !media.height) return;
		const rect =
			zoom === undefined && part.mode === "CROP"
				? positionCropRect({
						sourceWidth: media.width,
						sourceHeight: media.height,
						rect: part.rect,
						centerX: x,
						centerY: y,
					})
				: suggestFixedCrop({
						sourceWidth: media.width,
						sourceHeight: media.height,
						targetWidth: canvas.width,
						targetHeight: canvas.height,
						centerX: x,
						centerY: y,
						zoom: zoom ?? 1,
					});
		frame({
			fromFrame: part.fromFrame,
			toFrame: part.toFrame,
			mode: "CROP",
			origin: "MANUAL",
			rect,
		});
	}
	const fieldId = `clip-${clip.id}`;
	return (
		<section className="space-y-3 rounded-md border border-zinc-800 p-3">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<h3 className="font-medium text-sm">
					<button
						type="button"
						className="text-emerald-400 underline"
						onClick={() => onInspect(selected)}
					>
						{t("editing.range", { number: index + 1 })}
					</button>
				</h3>
				<div className="flex gap-1">
					<Button
						size="sm"
						variant="ghost"
						disabled={disabled || rangeUnapplied || index === 0}
						onClick={() => onMove(-1)}
						aria-label={t("editing.moveUp")}
					>
						↑
					</Button>
					<Button
						size="sm"
						variant="ghost"
						disabled={disabled || rangeUnapplied || index === count - 1}
						onClick={() => onMove(1)}
						aria-label={t("editing.moveDown")}
					>
						↓
					</Button>
					<Button
						size="sm"
						variant="ghost"
						disabled={disabled || rangeUnapplied || count === 1}
						onClick={onRemove}
					>
						{t("editing.remove")}
					</Button>
				</div>
			</div>
			<div className="grid grid-cols-2 gap-2">
				<Field label={t("editing.in")} htmlFor={`${fieldId}-in`}>
					<Input
						id={`${fieldId}-in`}
						type="number"
						min={0}
						step="any"
						value={from}
						disabled={disabled}
						onChange={(e) => updateRangeText(e.target.value, to)}
					/>
				</Field>
				<Field label={t("editing.out")} htmlFor={`${fieldId}-out`}>
					<Input
						id={`${fieldId}-out`}
						type="number"
						min={0}
						step="any"
						value={to}
						disabled={disabled}
						onChange={(e) => updateRangeText(from, e.target.value)}
					/>
				</Field>
			</div>
			<p className="text-xs text-zinc-500">{t("editing.rangeHelp")}</p>
			<div className="flex flex-wrap gap-2">
				<Button
					size="sm"
					variant="secondary"
					disabled={disabled}
					onClick={apply}
				>
					{t("editing.applyRange")}
				</Button>
				<Button
					size="sm"
					variant="ghost"
					disabled={disabled}
					onClick={() => {
						updateRangeText(
							secondsLabel(clip.sourceInUs),
							secondsLabel(sourceOutUs),
						);
						setError("");
					}}
				>
					{t("editing.resetRange")}
				</Button>
			</div>
			<div className="grid grid-cols-2 items-end gap-2">
				<Field label={t("editing.splitAt")} htmlFor={`${fieldId}-split`}>
					<Input
						id={`${fieldId}-split`}
						type="number"
						min={1}
						max={Math.max(1, clip.durationFrames - 1)}
						step={1}
						value={splitAtFrame}
						disabled={splitUnavailable}
						onChange={(event) => setSplitAtFrame(Number(event.target.value))}
					/>
				</Field>
				<Button
					size="sm"
					variant="secondary"
					disabled={
						splitUnavailable ||
						!Number.isSafeInteger(splitAtFrame) ||
						splitAtFrame <= 0 ||
						splitAtFrame >= clip.durationFrames
					}
					onClick={() => onSplit(splitAtFrame)}
				>
					{t("editing.split")}
				</Button>
			</div>
			{error && (
				<p role="alert" className="text-xs text-amber-300">
					{error}
				</p>
			)}
			<Field label={t("editing.audio")} htmlFor={`${fieldId}-audio`}>
				<SelectNative
					id={`${fieldId}-audio`}
					value={clip.audio.mode}
					disabled={disabled || rangeUnapplied}
					onChange={(e) =>
						onChange({
							...clip,
							audio: { mode: e.target.value === "MUTE" ? "MUTE" : "SOURCE" },
						})
					}
				>
					<option value="SOURCE">{t("editing.sourceAudio")}</option>
					<option value="MUTE">{t("editing.mute")}</option>
				</SelectNative>
			</Field>
			{part && (
				<>
					{clip.framing.length > 1 && (
						<Field label={t("editing.segment")} htmlFor={`${fieldId}-segment`}>
							<SelectNative
								id={`${fieldId}-segment`}
								value={selected}
								onChange={(e) => {
									setPartIndex(Number(e.target.value));
									onInspect(Number(e.target.value));
								}}
							>
								{clip.framing.map((segment, position) => (
									<option key={segment.fromFrame} value={position}>
										{(segment.fromFrame / 30).toFixed(2)}–
										{(segment.toFrame / 30).toFixed(2)}s
									</option>
								))}
							</SelectNative>
						</Field>
					)}
					<Field label={t("editing.framing")} htmlFor={`${fieldId}-framing`}>
						<SelectNative
							id={`${fieldId}-framing`}
							value={part.mode}
							disabled={disabled || rangeUnapplied}
							onChange={(e) =>
								e.target.value === "FIT"
									? frame({
											fromFrame: part.fromFrame,
											toFrame: part.toFrame,
											mode: "FIT",
											origin: "MANUAL",
										})
									: crop(0.5, 0.5)
							}
						>
							<option value="FIT">{t("editing.fit")}</option>
							<option value="CROP" disabled={!media.width || !media.height}>
								{t("editing.crop")}
							</option>
						</SelectNative>
					</Field>
					{part.mode === "CROP" && (
						<div className="grid grid-cols-2 gap-3">
							<div className="col-span-2 space-y-1">
								<Field
									label={t("editing.cropZoom")}
									htmlFor={`${fieldId}-zoom`}
								>
									<div className="flex items-center gap-3">
										<Input
											id={`${fieldId}-zoom`}
											type="range"
											min={1}
											max={Math.max(maximumZoom, cropZoom)}
											step={0.01}
											value={cropZoom}
											aria-valuetext={`${cropZoom.toFixed(2)}×`}
											disabled={disabled || rangeUnapplied}
											onChange={(e) =>
												crop(
													part.rect.x + part.rect.w / 2,
													part.rect.y + part.rect.h / 2,
													Math.min(maximumZoom, Number(e.target.value)),
												)
											}
										/>
										<span className="shrink-0 text-xs text-zinc-300 tabular-nums">
											{cropZoom.toFixed(2)}×
										</span>
									</div>
								</Field>
								<p className="text-xs text-zinc-400">
									{t("editing.cropZoomHelp")}
								</p>
							</div>
							<Field label={t("editing.centerX")} htmlFor={`${fieldId}-x`}>
								<Input
									id={`${fieldId}-x`}
									type="range"
									min={0}
									max={100}
									step={0.1}
									value={(part.rect.x + part.rect.w / 2) * 100}
									disabled={disabled || rangeUnapplied}
									onChange={(e) =>
										crop(
											Number(e.target.value) / 100,
											part.rect.y + part.rect.h / 2,
										)
									}
								/>
							</Field>
							<Field label={t("editing.centerY")} htmlFor={`${fieldId}-y`}>
								<Input
									id={`${fieldId}-y`}
									type="range"
									min={0}
									max={100}
									step={0.1}
									value={(part.rect.y + part.rect.h / 2) * 100}
									disabled={disabled || rangeUnapplied}
									onChange={(e) =>
										crop(
											part.rect.x + part.rect.w / 2,
											Number(e.target.value) / 100,
										)
									}
								/>
							</Field>
						</div>
					)}
				</>
			)}
		</section>
	);
}
