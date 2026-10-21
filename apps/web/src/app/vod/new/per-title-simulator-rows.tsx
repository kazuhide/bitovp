"use client";

import type { PerTitleGoal } from "@bitovp/core";
import { useId, useRef } from "react";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n/context";
import type { PerTitleManualBounds } from "./per-title-simulator-auto";
import { PerTitleSimulatorBitrateField } from "./per-title-simulator-bitrate-field";
import { PerTitleSimulatorNumberField as NumberField } from "./per-title-simulator-fields";

const texts = {
	en: {
		title: "Renditions",
		required: "Required",
		automatic: "Automatic",
		auto: "Auto",
		manual: "Manual",
		minimum: "Minimum bitrate (kbps)",
		maximum: "Maximum bitrate (kbps)",
		minimumSlider: "Minimum bitrate slider (kbps)",
		maximumSlider: "Maximum bitrate slider (kbps)",
		short: { min: "Min", max: "Max" },
		height: "Height (px)",
		optionalHeight: "Height (px, optional)",
		rendition: "rendition",
		row: "Rendition",
		candidate: "automatic template",
		candidateRow: "Automatic template",
		add: "Add rendition",
		addAutomatic: "Add automatic template",
		remove: "Remove",
		removeRendition: "Remove rendition",
		removeAutomatic: "Remove automatic template",
		reset: "Reset to automatic",
	},
	ja: {
		title: "レンディション",
		required: "必須",
		automatic: "自動",
		auto: "自動",
		manual: "手動",
		minimum: "最小ビットレート (kbps)",
		maximum: "最大ビットレート (kbps)",
		minimumSlider: "最小ビットレートのスライダー (kbps)",
		maximumSlider: "最大ビットレートのスライダー (kbps)",
		short: { min: "下限", max: "上限" },
		height: "高さ (px)",
		optionalHeight: "高さ (px、省略可)",
		rendition: "レンディション",
		row: "レンディション",
		candidate: "自動生成の候補",
		candidateRow: "自動生成の候補",
		add: "レンディションを追加",
		addAutomatic: "自動生成の候補を追加",
		remove: "削除",
		removeRendition: "レンディションを削除",
		removeAutomatic: "自動生成の候補を削除",
		reset: "自動設定に戻す",
	},
};

type AspectHistory = { ratio: number; height?: number; width?: number };
const positiveInteger = (value: number | undefined): value is number =>
	value !== undefined && Number.isSafeInteger(value) && value > 0;

function widthForNewRow(goal: PerTitleGoal, height: number) {
	const rows = goal.rows ?? [];
	const known = rows.flatMap((row) =>
		positiveInteger(row.height) && positiveInteger(row.width)
			? [{ height: row.height, width: row.width }]
			: [],
	);
	// Keep height-based ladders height-based rather than introducing a mixed-width row.
	if (known.length !== rows.length) return {};
	const fits = (ratio: number) =>
		Number.isFinite(ratio) &&
		ratio > 0 &&
		known.every(
			(row) => Math.abs(Math.round(row.height * ratio) - row.width) <= 1,
		);
	let ratio =
		positiveInteger(goal.inputWidth) && positiveInteger(goal.inputHeight)
			? goal.inputWidth / goal.inputHeight
			: undefined;
	if (ratio === undefined || !fits(ratio)) {
		const first = known[0];
		if (!first) return {};
		const lower = Math.max(...known.map((row) => (row.width - 1) / row.height));
		const upper = Math.min(...known.map((row) => (row.width + 1) / row.height));
		if (lower > upper) return {};
		ratio = first.width / first.height;
		if (!fits(ratio)) ratio = (lower + upper) / 2;
	}
	const width = Math.round(ratio * height);
	return positiveInteger(width) && fits(ratio) ? { width } : {};
}

function widthForHeight(
	row: { id: string; height?: number; width?: number },
	height: number | undefined,
	history: Map<string, AspectHistory>,
) {
	const previous = history.get(row.id);
	// Partial input keeps the source ratio; externally replaced dimensions establish a new one.
	const ratio =
		previous &&
		Object.is(previous.height, row.height) &&
		Object.is(previous.width, row.width)
			? previous.ratio
			: positiveInteger(row.height) && positiveInteger(row.width)
				? row.width / row.height
				: undefined;
	if (ratio === undefined) {
		history.delete(row.id);
		return {};
	}
	const resized =
		height === row.height || !positiveInteger(height)
			? row.width
			: Math.max(1, Math.round(ratio * height));
	const width =
		resized !== undefined && positiveInteger(resized) ? resized : row.width;
	history.set(row.id, { ratio, height, width });
	return width === row.width ? {} : { width };
}

export function PerTitleSimulatorRows({
	id,
	goal,
	onChange,
	manualBounds,
	onBitrateChange,
	onResetBitrates,
}: {
	id: string;
	goal: PerTitleGoal;
	onChange: (goal: PerTitleGoal) => void;
	manualBounds: PerTitleManualBounds;
	onBitrateChange: (
		rowId: string,
		bound: "min" | "max",
		value: number | undefined,
	) => void;
	onResetBitrates: (rowId: string) => void;
}) {
	const { locale } = useT();
	const counter = useRef(0);
	const mountId = useId();
	const aspectHistory = useRef(new Map<string, AspectHistory>());
	if (goal.strategy === "automatic" || goal.strategy === "count") return null;
	const copy = texts[locale];
	const rows = goal.rows ?? [];
	const automatic = goal.automaticTemplates ?? [];
	const ranged = goal.strategy === "fixed-ranges";
	const full = rows.length + automatic.length >= 64;
	const inGlobal = (value: number | undefined): value is number =>
		positiveInteger(value) &&
		value >= goal.minBitrate &&
		value <= goal.maxBitrate;
	const validGlobal =
		positiveInteger(goal.minBitrate) &&
		positiveInteger(goal.maxBitrate) &&
		goal.minBitrate <= goal.maxBitrate &&
		goal.maxBitrate <= 2_147_483_647;
	const heightOrder = (row: { height?: number }) =>
		row.height !== undefined && Number.isFinite(row.height)
			? row.height
			: Infinity;
	const entries = [
		...rows.map((row, index) => ({ kind: "required" as const, row, index })),
		...automatic.map((row, index) => ({
			kind: "automatic" as const,
			row,
			index,
		})),
	].sort((a, b) => heightOrder(a.row) - heightOrder(b.row) || 0);
	const nextId = () => {
		const reserved = new Set([...rows, ...automatic].map((row) => row.id));
		let next: string;
		do {
			counter.current++;
			next = `${id}-${mountId}-new-${counter.current}`;
		} while (reserved.has(next));
		return next;
	};
	return (
		<section className="space-y-3" aria-labelledby={`${id}-renditions`}>
			<h3 id={`${id}-renditions`} className="font-medium text-sm text-zinc-200">
				{copy.title}
			</h3>
			<ul className="space-y-3">
				{entries.map(({ kind, row, index }) => {
					const manual = manualBounds[row.id];
					const isAutomatic = kind === "automatic";
					const rowRanged = ranged && !isAutomatic;
					return (
						<li
							key={row.id}
							aria-label={`${isAutomatic ? copy.candidateRow : copy.row} ${index + 1}`}
							className="space-y-2 border-b border-zinc-800 pb-3"
						>
							<div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-400">
								<span>{isAutomatic ? copy.automatic : copy.required}</span>
								{rowRanged
									? (["min", "max"] as const).map((bound) => (
											<span
												key={bound}
												title={`${bound === "min" ? copy.minimum : copy.maximum}: ${manual?.[bound] ? copy.manual : copy.auto}`}
												className="rounded border border-zinc-800 px-1.5 py-0.5"
											>
												{copy.short[bound]}{" "}
												{manual?.[bound] ? copy.manual : copy.auto}
											</span>
										))
									: null}
								<div className="ml-auto flex flex-wrap items-center gap-1">
									{rowRanged && (manual?.min || manual?.max) ? (
										<Button
											variant="ghost"
											size="sm"
											aria-label={`${copy.reset}, ${copy.rendition} ${index + 1}`}
											onClick={() => onResetBitrates(row.id)}
										>
											{copy.reset}
										</Button>
									) : null}
									<Button
										variant="ghost"
										size="sm"
										aria-label={`${isAutomatic ? copy.removeAutomatic : copy.removeRendition} ${index + 1}`}
										onClick={() =>
											onChange({
												...goal,
												...(isAutomatic
													? {
															automaticTemplates: automatic.filter(
																(_, i) => i !== index,
															),
														}
													: { rows: rows.filter((_, i) => i !== index) }),
											})
										}
									>
										{copy.remove}
									</Button>
								</div>
							</div>
							<div
								className={`grid items-start gap-2 ${rowRanged ? "sm:grid-cols-3" : "sm:max-w-xs"}`}
							>
								<NumberField
									id={`${id}-${row.id}-height`}
									label={isAutomatic ? copy.optionalHeight : copy.height}
									accessibleLabel={`${isAutomatic ? copy.optionalHeight : copy.height}, ${isAutomatic ? copy.candidate : copy.rendition} ${index + 1}`}
									value={row.height}
									optional={isAutomatic}
									integer
									minimum={1}
									onChange={(height) =>
										onChange({
											...goal,
											...(isAutomatic
												? {
														automaticTemplates: automatic.map((item, i) =>
															i === index
																? {
																		...item,
																		height,
																		...widthForHeight(
																			item,
																			height,
																			aspectHistory.current,
																		),
																	}
																: item,
														),
													}
												: {
														rows: rows.map((item, i) =>
															i === index
																? {
																		...item,
																		height: height ?? Number.NaN,
																		...widthForHeight(
																			item,
																			height,
																			aspectHistory.current,
																		),
																	}
																: item,
														),
													}),
										})
									}
								/>
								{rowRanged
									? (["min", "max"] as const).map((bound) => (
											<PerTitleSimulatorBitrateField
												key={bound}
												id={`${id}-${row.id}-${bound}`}
												label={bound === "min" ? copy.minimum : copy.maximum}
												accessibleLabel={`${bound === "min" ? copy.minimum : copy.maximum}, ${copy.rendition} ${index + 1}`}
												sliderLabel={`${bound === "min" ? copy.minimumSlider : copy.maximumSlider}, ${copy.rendition} ${index + 1}`}
												value={
													bound === "min" ? row.minBitrate : row.maxBitrate
												}
												minimum={
													validGlobal
														? bound === "max" &&
															manual?.min &&
															inGlobal(row.minBitrate)
															? row.minBitrate
															: goal.minBitrate
														: 1
												}
												maximum={
													validGlobal
														? bound === "min" &&
															manual?.max &&
															inGlobal(row.maxBitrate)
															? row.maxBitrate
															: goal.maxBitrate
														: 2_147_483_647
												}
												disabled={!validGlobal}
												onChange={(value) =>
													onBitrateChange(row.id, bound, value)
												}
											/>
										))
									: null}
							</div>
						</li>
					);
				})}
			</ul>
			<div className="flex flex-wrap gap-2">
				<Button
					variant="secondary"
					size="sm"
					disabled={full}
					onClick={() => {
						if (!full)
							onChange({
								...goal,
								rows: [
									...rows,
									{ id: nextId(), height: 720, ...widthForNewRow(goal, 720) },
								],
							});
					}}
				>
					{copy.add}
				</Button>
				<Button
					variant="secondary"
					size="sm"
					disabled={full}
					onClick={() => {
						if (!full)
							onChange({
								...goal,
								automaticTemplates: [...automatic, { id: nextId() }],
							});
					}}
				>
					{copy.addAutomatic}
				</Button>
			</div>
		</section>
	);
}
