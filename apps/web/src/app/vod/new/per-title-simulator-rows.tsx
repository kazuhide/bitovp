"use client";

import {
	type PerTitleGoal,
	perTitleDimensionAxis,
	resolvePerTitleFixedMode,
} from "@bitovp/core";
import { useId, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { SelectNative } from "@/components/ui/input";
import { useT } from "@/lib/i18n/context";
import {
	autoTunePerTitleGoal,
	type PerTitleManualBounds,
} from "./per-title-simulator-auto";
import { PerTitleSimulatorBitrateField } from "./per-title-simulator-bitrate-field";
import {
	type PerTitleControlContext,
	PerTitleSettingControl,
	PerTitleStreamControls,
} from "./per-title-simulator-controls";
import { PerTitleSimulatorNumberField as NumberField } from "./per-title-simulator-fields";
import {
	changePerTitleStreamChoice,
	editablePerTitleStreams,
	withPerTitleStreamRows,
} from "./per-title-simulator-row-mode";
import {
	getPerTitleAdjustment,
	perTitleStreamFields,
} from "./per-title-simulator-tuning";
import {
	PER_TITLE_STREAM_CHOICES,
	type PerTitleStreamChoice,
	perTitleStreamChoice,
	perTitleStreamChoiceLabel,
} from "./per-title-stream-mode";

const texts = {
	en: {
		title: "Renditions",
		mode: "Stream mode",
		auto: "Auto",
		manual: "Manual",
		minimum: "Minimum bitrate (kbps)",
		maximum: "Maximum bitrate (kbps)",
		minimumSlider: "Minimum bitrate slider (kbps)",
		maximumSlider: "Maximum bitrate slider (kbps)",
		short: { min: "Min", max: "Max" },
		height: "Height (px)",
		optionalHeight: "Height hint (px, optional)",
		width: "Width (px)",
		optionalWidth: "Width hint (px, optional)",
		rendition: "rendition",
		row: "Rendition",
		add: "Add rendition",
		remove: "Remove",
		removeRendition: "Remove rendition",
		reset: "Reset to automatic",
	},
	ja: {
		title: "レンディション",
		mode: "Streamモード",
		auto: "自動",
		manual: "手動",
		minimum: "最小ビットレート (kbps)",
		maximum: "最大ビットレート (kbps)",
		minimumSlider: "最小ビットレートのスライダー (kbps)",
		maximumSlider: "最大ビットレートのスライダー (kbps)",
		short: { min: "下限", max: "上限" },
		height: "高さ (px)",
		optionalHeight: "高さのヒント (px・任意)",
		width: "幅 (px)",
		optionalWidth: "幅のヒント (px・任意)",
		rendition: "レンディション",
		row: "レンディション",
		add: "レンディションを追加",
		remove: "削除",
		removeRendition: "レンディションを削除",
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

function withoutRowPolicies(goal: PerTitleGoal, rowId: string): PerTitleGoal {
	const next = { ...goal };
	if (goal.adjustments?.streams) {
		const streams = { ...goal.adjustments.streams };
		delete streams[rowId];
		next.adjustments = { ...goal.adjustments, streams };
	}
	if (goal.settingLocks?.streams) {
		const streams = { ...goal.settingLocks.streams };
		delete streams[rowId];
		next.settingLocks = { ...goal.settingLocks, streams };
	}
	return next;
}

export function PerTitleSimulatorRows({
	id,
	goal,
	onChange,
	manualBounds,
	onBitrateChange,
	onResetBitrates,
	tuning,
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
	tuning?: PerTitleControlContext;
}) {
	const { locale } = useT();
	const counter = useRef(0);
	const mountId = useId();
	const aspectHistory = useRef(new Map<string, AspectHistory>());
	const rowOrder = useRef(new Map<string, number>());
	const copy = texts[locale];
	const { fixed: rows, ordinary: automatic } = editablePerTitleStreams(
		goal,
		tuning?.proposal,
	);
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
	const entries = [
		...rows.map((row, index) => ({ kind: "required" as const, row, index })),
		...automatic.map((row, index) => ({
			kind: "automatic" as const,
			row,
			index,
		})),
	];
	const dimensionAxis = perTitleDimensionAxis(
		entries
			.filter(({ row }) => row.height !== undefined || row.width !== undefined)
			.map(({ row }) => row),
	);
	if (dimensionAxis)
		entries.sort(
			(a, b) =>
				(a.row[dimensionAxis] ?? Infinity) -
					(b.row[dimensionAxis] ?? Infinity) || 0,
		);
	for (const entry of entries)
		if (!rowOrder.current.has(entry.row.id))
			rowOrder.current.set(entry.row.id, rowOrder.current.size);
	entries.sort(
		(a, b) =>
			(rowOrder.current.get(a.row.id) ?? 0) -
			(rowOrder.current.get(b.row.id) ?? 0),
	);
	const nextId = () => {
		const reserved = new Set([...rows, ...automatic].map((row) => row.id));
		let next: string;
		do {
			counter.current++;
			next = `${id}-${mountId}-new-${counter.current}`;
		} while (reserved.has(next));
		return next;
	};
	const changeMode = (rowId: string, choice: PerTitleStreamChoice) => {
		let next = changePerTitleStreamChoice(
			goal,
			rowId,
			choice,
			tuning?.proposal,
		);
		if (choice === "fixed-range") {
			const changed = next.rows?.find((row) => row.id === rowId);
			if (
				changed &&
				(changed.minBitrate === undefined || changed.maxBitrate === undefined)
			) {
				const manual = Object.fromEntries(
					(next.rows ?? [])
						.filter((row) => row.id !== rowId)
						.map((row) => [row.id, { min: true, max: true }]),
				);
				const seeded = autoTunePerTitleGoal(
					next,
					tuning?.anchor ?? next,
					manual,
				).rows?.find((row) => row.id === rowId);
				if (seeded)
					next = {
						...next,
						rows: next.rows?.map((row) =>
							row.id === rowId
								? {
										...row,
										minBitrate: seeded.minBitrate,
										maxBitrate: seeded.maxBitrate,
									}
								: row,
						),
					};
			}
		}
		onChange(next);
	};
	return (
		<section className="space-y-3" aria-labelledby={`${id}-renditions`}>
			<h3 id={`${id}-renditions`} className="font-medium text-sm text-zinc-200">
				{copy.title}
			</h3>
			<ul className="space-y-3">
				{entries.map(({ kind, row, index }, position) => {
					const manual = tuning
						? {
								min:
									getPerTitleAdjustment(
										tuning.draft,
										tuning.anchor,
										"stream",
										"minBitrate",
										row.id,
									).mode === "fixed",
								max:
									getPerTitleAdjustment(
										tuning.draft,
										tuning.anchor,
										"stream",
										"maxBitrate",
										row.id,
									).mode === "fixed",
							}
						: manualBounds[row.id];
					const isAutomatic = kind === "automatic";
					const mode = isAutomatic
						? "PER_TITLE_TEMPLATE"
						: resolvePerTitleFixedMode(
								goal,
								row as NonNullable<PerTitleGoal["rows"]>[number],
							);
					const choice = perTitleStreamChoice({ ...row, mode });
					const rowRanged =
						mode === "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE";
					const widthOnly = row.height === undefined && row.width !== undefined;
					const dimension = widthOnly ? "width" : "height";
					const dimensionLabel = widthOnly
						? isAutomatic
							? copy.optionalWidth
							: copy.width
						: isAutomatic
							? copy.optionalHeight
							: copy.height;
					const number = position + 1;
					return (
						<li
							key={row.id}
							aria-label={`${copy.row} ${number}`}
							className="space-y-2 border-b border-zinc-800 pb-3"
						>
							<div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-400">
								<span>
									{copy.row} {number}
								</span>
								{rowRanged && !tuning
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
											aria-label={`${copy.reset}, ${copy.rendition} ${number}`}
											onClick={() => onResetBitrates(row.id)}
										>
											{copy.reset}
										</Button>
									) : null}
									<Button
										variant="ghost"
										size="sm"
										aria-label={`${copy.removeRendition} ${number}`}
										disabled={entries.length === 1}
										onClick={() =>
											onChange(
												withoutRowPolicies(
													withPerTitleStreamRows(
														goal,
														isAutomatic
															? rows
															: rows.filter((_, i) => i !== index),
														isAutomatic
															? automatic.filter((_, i) => i !== index)
															: automatic,
													),
													row.id,
												),
											)
										}
									>
										{copy.remove}
									</Button>
								</div>
							</div>
							<Field htmlFor={`${id}-${row.id}-mode`} label={copy.mode}>
								<SelectNative
									id={`${id}-${row.id}-mode`}
									aria-label={`${copy.mode}, ${copy.rendition} ${number}`}
									value={choice}
									onChange={(event) =>
										changeMode(
											row.id,
											event.target.value as PerTitleStreamChoice,
										)
									}
								>
									{PER_TITLE_STREAM_CHOICES.map((option) => (
										<option key={option} value={option}>
											{perTitleStreamChoiceLabel(option)}
										</option>
									))}
								</SelectNative>
							</Field>
							<div
								className={`grid items-start gap-2 ${rowRanged ? "sm:grid-cols-3" : "sm:max-w-xs"}`}
							>
								<div
									data-setting-scope="stream"
									data-setting-key={dimension}
									data-setting-row={row.id}
									data-setting-control={`${id}-${row.id}-${dimension}`}
								>
									<NumberField
										id={`${id}-${row.id}-${dimension}`}
										label={dimensionLabel}
										accessibleLabel={`${dimensionLabel}, ${copy.rendition} ${number}`}
										value={row[dimension]}
										optional={isAutomatic}
										integer
										minimum={1}
										onChange={(size) => {
											if (widthOnly) {
												onChange({
													...goal,
													...(isAutomatic
														? {
																automaticTemplates: automatic.map((item, i) =>
																	i === index ? { ...item, width: size } : item,
																),
															}
														: {
																rows: rows.map((item, i) =>
																	i === index ? { ...item, width: size } : item,
																),
															}),
												});
												return;
											}
											const height = size;
											if (isAutomatic && height === undefined)
												aspectHistory.current.delete(row.id);
											onChange({
												...goal,
												...(isAutomatic
													? {
															automaticTemplates: automatic.map((item, i) =>
																i === index
																	? {
																			...item,
																			height,
																			...(height === undefined
																				? { width: undefined }
																				: widthForHeight(
																						item,
																						height,
																						aspectHistory.current,
																					)),
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
											});
										}}
									/>
								</div>
								{rowRanged
									? (["min", "max"] as const).map((bound) => {
											const field = perTitleStreamFields(goal.codec).find(
												(item) =>
													item.key ===
													(bound === "min" ? "minBitrate" : "maxBitrate"),
											);
											const minimum = validGlobal
												? bound === "max" &&
													manual?.min &&
													inGlobal(row.minBitrate)
													? row.minBitrate
													: goal.minBitrate
												: 1;
											const maximum = validGlobal
												? bound === "min" &&
													manual?.max &&
													inGlobal(row.maxBitrate)
													? row.maxBitrate
													: goal.maxBitrate
												: 2_147_483_647;
											if (tuning && field)
												return (
													<PerTitleSettingControl
														key={bound}
														id={`${id}-${row.id}-${bound}`}
														context={tuning}
														scope="stream"
														field={field}
														rowId={row.id}
														label={
															bound === "min" ? copy.minimum : copy.maximum
														}
														accessibleLabel={`${bound === "min" ? copy.minimum : copy.maximum}, ${copy.rendition} ${number}`}
														slider={{
															label: `${bound === "min" ? copy.minimumSlider : copy.maximumSlider}, ${copy.rendition} ${number}`,
															minimum,
															maximum,
															disabled: !validGlobal,
														}}
													/>
												);
											return (
												<PerTitleSimulatorBitrateField
													key={bound}
													id={`${id}-${row.id}-${bound}`}
													label={bound === "min" ? copy.minimum : copy.maximum}
													accessibleLabel={`${bound === "min" ? copy.minimum : copy.maximum}, ${copy.rendition} ${number}`}
													sliderLabel={`${bound === "min" ? copy.minimumSlider : copy.maximumSlider}, ${copy.rendition} ${number}`}
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
											);
										})
									: null}
							</div>
							{tuning ? (
								<PerTitleStreamControls
									id={`${id}-${row.id}-settings`}
									context={tuning}
									rowId={row.id}
									omitBounds={rowRanged}
									suffix={`${copy.rendition} ${number}`}
								/>
							) : null}
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
						if (full) return;
						if (goal.strategy === "automatic" || goal.strategy === "count") {
							onChange({
								...goal,
								automaticTemplates: [...automatic, { id: nextId() }],
							});
							return;
						}
						let added: NonNullable<PerTitleGoal["rows"]>[number] = {
							id: nextId(),
							...(dimensionAxis === "width"
								? { width: 1280 }
								: { height: 720, ...widthForNewRow(goal, 720) }),
							mode: ranged
								? "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE"
								: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION",
						};
						if (ranged) {
							const manual = Object.fromEntries(
								rows.map((row) => [row.id, { min: true, max: true }]),
							);
							const seeded = autoTunePerTitleGoal(
								{ ...goal, rows: [...rows, added] },
								tuning?.anchor ?? goal,
								manual,
							).rows?.find((row) => row.id === added.id);
							if (seeded)
								added = {
									...added,
									minBitrate: seeded.minBitrate,
									maxBitrate: seeded.maxBitrate,
								};
						}
						onChange(withPerTitleStreamRows(goal, [...rows, added], automatic));
					}}
				>
					{copy.add}
				</Button>
			</div>
		</section>
	);
}
