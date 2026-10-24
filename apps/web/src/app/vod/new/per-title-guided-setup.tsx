"use client";

import type {
	PerTitleCodec,
	PerTitleGoal,
	PerTitleStrategy,
} from "@bitovp/core";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input, SelectNative } from "@/components/ui/input";
import { useT } from "@/lib/i18n/context";
import {
	buildPerTitleSetup,
	type PerTitleSetupInput,
	type PerTitleSetupIssue,
} from "./per-title-guided-setup-model";
import { PerTitleLadder } from "./per-title-simulator-ladder";

const strategies: readonly PerTitleStrategy[] = [
	"automatic",
	"count",
	"required-resolutions",
	"fixed-resolutions",
	"fixed-ranges",
];
const codecNames: Record<PerTitleCodec, string> = {
	H264: "H.264",
	H265: "HEVC",
	H265V2: "HEVC v2",
	VP9: "VP9",
	AV1: "AV1",
};
const copy = {
	en: {
		title: "New Per-Title setup",
		steps: ["Choose a setup", "Requirements", "Review"],
		strategies: [
			"Let the encoder choose",
			"Specify only the count",
			"Require some resolutions",
			"Specify every resolution",
			"Specify resolutions and bitrate ranges",
		],
		next: "Next",
		back: "Back",
		cancel: "Cancel",
		complete: "Inspect in simulator",
		codec: "Video codec",
		minimum: "Minimum bitrate (kbps)",
		maximum: "Maximum bitrate (kbps)",
		source: "Source height (px, optional)",
		count: "Requested video outputs",
		optionalCount: "Requested video outputs (optional)",
		rendition: (index: number) => `Rendition ${index}`,
		remove: (index: number) => `Remove rendition ${index}`,
		height: "Height (px)",
		rowMinimum: "Minimum bitrate (kbps, optional)",
		rowMaximum: "Maximum bitrate (kbps, optional)",
		lowerHeight: "Lower automatic rendition height (px, optional)",
		upperHeights: "Upper rendition candidates (px, optional)",
		upperHint:
			"Separate heights with commas; choose candidates for one upper output.",
		upperChoice:
			"These candidates share one requested upper output. Confirm the actual count by encoding.",
		add: "Add rendition",
		removeLabel: "Remove",
		rangesHint: "Leave bitrate limits blank to calculate a starting range.",
		issues: "Check these requirements",
		proposal: "Proposed configuration",
		automatic: "The encoder chooses the resolutions and bitrates.",
		countSummary: (count: number) => `Requested video outputs: ${count}`,
		rowsSummary: (count: number) => `Required renditions: ${count}`,
		unverified: "Some conditions still need checking in the simulator.",
		nativeCheck: "Confirm output count and quality by encoding your source.",
		reasoning: "Why these settings",
		api: "API settings",
		unavailable: "Select an available video codec to continue.",
	},
	ja: {
		title: "Per-Title を新しく設定",
		steps: ["設定方法", "条件", "確認"],
		strategies: [
			"すべて任せる",
			"本数だけ指定",
			"必要な解像度だけ指定",
			"解像度をすべて指定",
			"解像度とビットレート幅を指定",
		],
		next: "次へ",
		back: "戻る",
		cancel: "キャンセル",
		complete: "シミュレーターで確認",
		codec: "映像コーデック",
		minimum: "最小ビットレート (kbps)",
		maximum: "最大ビットレート (kbps)",
		source: "入力の高さ (px・任意)",
		count: "希望する映像出力数",
		optionalCount: "希望する映像出力数（任意）",
		rendition: (index: number) => `レンディション ${index}`,
		remove: (index: number) => `レンディション ${index} を削除`,
		height: "高さ (px)",
		rowMinimum: "最小ビットレート (kbps・任意)",
		rowMaximum: "最大ビットレート (kbps・任意)",
		lowerHeight: "下位の自動段の高さ (px・任意)",
		upperHeights: "上位段の候補 (px・任意)",
		upperHint: "上位1段の候補となる高さをカンマで区切ります。",
		upperChoice:
			"上位の希望本数は、候補を合わせて1本です。実際の本数はエンコードして確認してください。",
		add: "レンディションを追加",
		removeLabel: "削除",
		rangesHint: "ビットレートを空欄にすると、初期案を計算します。",
		issues: "条件を確認してください",
		proposal: "作成する設定",
		automatic: "解像度とビットレートはエンコーダーが選びます。",
		countSummary: (count: number) => `希望する映像出力数：${count}本`,
		rowsSummary: (count: number) => `必須のレンディション（${count}本）`,
		unverified: "シミュレーターで確認が必要な条件があります。",
		nativeCheck: "本数と画質は、素材をエンコードして確認してください。",
		reasoning: "設定の根拠",
		api: "API 設定",
		unavailable: "利用できる映像コーデックを選んでください。",
	},
};
type Text = (typeof copy)["en"];
type SetupRow = {
	id: string;
	height: string;
	minimum: string;
	maximum: string;
};
function requiredBitrate(value: string): number {
	const match = /^([+-]?)(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(
		value.trim(),
	);
	if (!match || !(match[2] || match[3])) return Number.NaN;
	const fraction = match[3] ?? "";
	const digits = `${match[2]}${fraction}`.replace(/^0+/, "");
	if (!digits) return 0;
	const exponent = Number(match[4] ?? 0);
	const shift = 3 + exponent - fraction.length;
	if (!Number.isSafeInteger(exponent) || !Number.isSafeInteger(shift))
		return Number.NaN;
	// Check the decimal digits before Number can discard fractional bits/s.
	if (
		shift < 0 &&
		(-shift > digits.length || !/^0*$/.test(digits.slice(shift)))
	)
		return Number.NaN;
	return Number(`${match[1]}${digits}e${shift}`);
}
const optionalBitrate = (value: string) =>
	value.trim() === "" ? undefined : requiredBitrate(value);
const requiredNumber = (value: string) =>
	value.trim() === "" ? Number.NaN : Number(value);
const hint = (value: number | undefined, fallback: string, divisor = 1) =>
	value !== undefined && Number.isSafeInteger(value) && value > 0
		? String(value / divisor)
		: fallback;
const starterRows = (inputHeight: number | undefined): SetupRow[] => {
	const ceiling =
		inputHeight !== undefined &&
		Number.isSafeInteger(inputHeight) &&
		inputHeight > 0
			? inputHeight
			: 1080;
	const heights = [360, 720, 1080].filter((height) => height <= ceiling);
	return (heights.length ? heights : [ceiling]).map((height, index) => ({
		id: `setup-row-${index + 1}`,
		height: String(height),
		minimum: "",
		maximum: "",
	}));
};

function issueLabel(
	issue: PerTitleSetupIssue,
	rows: readonly SetupRow[],
	text: Text,
) {
	const rowIndex = issue.rowId
		? rows.findIndex((row) => row.id === issue.rowId)
		: -1;
	const fields: Record<string, string> = {
		codec: text.codec,
		minBitrate: text.minimum,
		maxBitrate: text.maximum,
		inputHeight: text.source,
		count: text.count,
		height: text.height,
		lowerHeight: text.lowerHeight,
		upperHeights: text.upperHeights,
	};
	return [
		rowIndex >= 0 ? text.rendition(rowIndex + 1) : undefined,
		issue.field ? fields[issue.field] : undefined,
	]
		.filter(Boolean)
		.join(" · ");
}

function SetupNumber({
	id,
	label,
	value,
	onChange,
	min = 10,
	step = 0.001,
}: {
	id: string;
	label: string;
	value: string;
	onChange: (value: string) => void;
	min?: number;
	step?: number;
}) {
	return (
		<Field htmlFor={id} label={label}>
			<Input
				id={id}
				type="number"
				inputMode="decimal"
				min={min}
				step={step}
				value={value}
				onChange={(event) => onChange(event.target.value)}
			/>
		</Field>
	);
}

function SetupRows({
	id,
	rows,
	ranges,
	text,
	onChange,
	onAdd,
	onRemove,
}: {
	id: string;
	rows: readonly SetupRow[];
	ranges: boolean;
	text: Text;
	onChange: (rowId: string, patch: Partial<SetupRow>) => void;
	onAdd: () => void;
	onRemove: (rowId: string) => void;
}) {
	return (
		<div className="min-w-0 space-y-3">
			{ranges ? (
				<p className="text-xs text-zinc-400">{text.rangesHint}</p>
			) : null}
			{rows.map((row, index) => (
				<fieldset
					key={row.id}
					className="min-w-0 rounded-md border border-zinc-800 p-3"
				>
					<legend className="px-1 text-xs text-zinc-300">
						{text.rendition(index + 1)}
					</legend>
					<div className="grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-3">
						<SetupNumber
							id={`${id}-${row.id}-height`}
							label={text.height}
							value={row.height}
							min={1}
							step={1}
							onChange={(height) => onChange(row.id, { height })}
						/>
						{ranges ? (
							<>
								<SetupNumber
									id={`${id}-${row.id}-minimum`}
									label={text.rowMinimum}
									value={row.minimum}
									onChange={(minimum) => onChange(row.id, { minimum })}
								/>
								<SetupNumber
									id={`${id}-${row.id}-maximum`}
									label={text.rowMaximum}
									value={row.maximum}
									onChange={(maximum) => onChange(row.id, { maximum })}
								/>
							</>
						) : null}
					</div>
					<div className="mt-2 flex justify-end">
						<Button
							size="sm"
							variant="ghost"
							aria-label={text.remove(index + 1)}
							onClick={() => onRemove(row.id)}
						>
							{text.removeLabel}
						</Button>
					</div>
				</fieldset>
			))}
			<Button
				size="sm"
				variant="secondary"
				disabled={rows.length >= 64}
				onClick={onAdd}
			>
				{text.add}
			</Button>
		</div>
	);
}

export function PerTitleGuidedSetup({
	initialGoal,
	allowedCodecs,
	onComplete,
	onCancel,
}: {
	initialGoal: PerTitleGoal;
	allowedCodecs: readonly PerTitleCodec[];
	onComplete: (goal: PerTitleGoal) => void;
	onCancel: () => void;
}) {
	const { locale } = useT();
	const text = copy[locale];
	const id = useId();
	const [step, setStep] = useState(0);
	const [strategy, setStrategy] = useState<PerTitleStrategy>("automatic");
	const [codec, setCodec] = useState<PerTitleCodec>(() =>
		allowedCodecs.includes(initialGoal.codec)
			? initialGoal.codec
			: (allowedCodecs[0] ?? "H264"),
	);
	const [minimum, setMinimum] = useState(() =>
		hint(initialGoal.minBitrate, "150", 1000),
	);
	const [maximum, setMaximum] = useState(() =>
		hint(initialGoal.maxBitrate, "4000", 1000),
	);
	const [sourceHeight, setSourceHeight] = useState(() =>
		hint(initialGoal.inputHeight, ""),
	);
	const [count, setCount] = useState("5");
	const [requiredCount, setRequiredCount] = useState("");
	const [lowerHeight, setLowerHeight] = useState("");
	const [upperHeights, setUpperHeights] = useState("");
	const [rows, setRows] = useState(() => starterRows(initialGoal.inputHeight));
	const [submitted, setSubmitted] = useState(false);
	const completed = useRef(false);
	const nextRowId = useRef(4);
	useEffect(() => {
		document.getElementById(`${id}-step-${step}`)?.focus();
	}, [id, step]);
	const usesRows = strategy !== "automatic" && strategy !== "count";
	const input = useMemo<PerTitleSetupInput>(
		() => ({
			strategy,
			codec,
			minBitrate: requiredBitrate(minimum),
			maxBitrate: requiredBitrate(maximum),
			...(strategy === "count"
				? { count: requiredNumber(count) }
				: strategy === "required-resolutions" && requiredCount.trim() !== ""
					? { count: requiredNumber(requiredCount) }
					: {}),
			...(sourceHeight.trim() !== ""
				? { inputHeight: requiredNumber(sourceHeight) }
				: {}),
			...(strategy === "fixed-ranges" &&
			(lowerHeight.trim() !== "" || upperHeights.trim() !== "")
				? {
						automaticEdges: {
							...(lowerHeight.trim() !== ""
								? { lowerHeight: requiredNumber(lowerHeight) }
								: {}),
							...(upperHeights.trim() !== ""
								? { upperHeights: upperHeights.split(",").map(requiredNumber) }
								: {}),
						},
					}
				: {}),
			rows: usesRows
				? rows.map((row) => {
						const minBitrate = optionalBitrate(row.minimum);
						const maxBitrate = optionalBitrate(row.maximum);
						return {
							id: row.id,
							height: requiredNumber(row.height),
							...(strategy === "fixed-ranges"
								? {
										...(minBitrate !== undefined ? { minBitrate } : {}),
										...(maxBitrate !== undefined ? { maxBitrate } : {}),
									}
								: {}),
						};
					})
				: [],
		}),
		[
			strategy,
			codec,
			minimum,
			maximum,
			count,
			requiredCount,
			sourceHeight,
			lowerHeight,
			upperHeights,
			usesRows,
			rows,
		],
	);
	const result = useMemo(
		() => buildPerTitleSetup(input, allowedCodecs),
		[input, allowedCodecs],
	);
	const available = allowedCodecs.includes(codec);
	const canReview =
		available &&
		result.status !== "conflict" &&
		result.goal !== null &&
		result.proposal !== null;
	const complete = () => {
		if (step !== 2 || !canReview || !result.goal || completed.current) return;
		completed.current = true;
		setSubmitted(true);
		onComplete(result.goal);
	};
	const numberField = (
		name: string,
		label: string,
		value: string,
		onChange: (value: string) => void,
		integer = false,
	) => (
		<SetupNumber
			id={`${id}-${name}`}
			label={label}
			value={value}
			onChange={onChange}
			{...(integer ? { min: 1, step: 1 } : {})}
		/>
	);
	return (
		<section aria-label={text.title} className="min-w-0 space-y-5">
			<ol
				aria-label={text.title}
				className="grid min-w-0 grid-cols-3 gap-2 border-b border-zinc-800 pb-3 text-xs"
			>
				{text.steps.map((label, index) => (
					<li
						key={label}
						aria-current={step === index ? "step" : undefined}
						className={
							step === index ? "font-medium text-blue-300" : "text-zinc-500"
						}
					>
						<span className="mr-1 tabular-nums">{index + 1}.</span>
						{label}
					</li>
				))}
			</ol>
			<h3
				id={`${id}-step-${step}`}
				tabIndex={-1}
				className="text-sm font-medium text-zinc-200 focus:outline-none"
			>
				{text.steps[step]}
			</h3>
			{step === 0 ? (
				<fieldset className="space-y-2">
					<legend className="sr-only">{text.steps[0]}</legend>
					{strategies.map((item, index) => (
						<label
							key={item}
							className={`flex min-w-0 cursor-pointer items-start gap-3 rounded-md border px-3 py-3 text-sm ${strategy === item ? "border-blue-700 bg-blue-950/20 text-zinc-100" : "border-zinc-800 text-zinc-300 hover:bg-zinc-900"}`}
						>
							<input
								className="mt-0.5 shrink-0 accent-blue-500"
								type="radio"
								name={`${id}-strategy`}
								checked={strategy === item}
								onChange={() => setStrategy(item)}
							/>
							<span>{text.strategies[index]}</span>
						</label>
					))}
				</fieldset>
			) : null}
			{step === 1 ? (
				<div className="min-w-0 space-y-4">
					<div className="grid min-w-0 gap-3 sm:grid-cols-2">
						<Field htmlFor={`${id}-codec`} label={text.codec}>
							<SelectNative
								id={`${id}-codec`}
								value={codec}
								onChange={(event) =>
									setCodec(event.target.value as PerTitleCodec)
								}
							>
								{!available ? (
									<option value={codec} disabled>
										{codecNames[codec]}
									</option>
								) : null}
								{[...new Set(allowedCodecs)].map((item) => (
									<option key={item} value={item}>
										{codecNames[item]}
									</option>
								))}
							</SelectNative>
						</Field>
						{numberField(
							"source",
							text.source,
							sourceHeight,
							setSourceHeight,
							true,
						)}
						{numberField("minimum", text.minimum, minimum, setMinimum)}
						{numberField("maximum", text.maximum, maximum, setMaximum)}
						{strategy === "count"
							? numberField("count", text.count, count, setCount, true)
							: strategy === "required-resolutions"
								? numberField(
										"count",
										text.optionalCount,
										requiredCount,
										setRequiredCount,
										true,
									)
								: null}
					</div>
					{usesRows ? (
						<SetupRows
							id={id}
							rows={rows}
							ranges={strategy === "fixed-ranges"}
							text={text}
							onChange={(rowId, patch) =>
								setRows((current) =>
									current.map((row) =>
										row.id === rowId ? { ...row, ...patch, id: row.id } : row,
									),
								)
							}
							onAdd={() => {
								const rowId = `setup-row-${nextRowId.current++}`;
								setRows((current) => [
									...current,
									{ id: rowId, height: "720", minimum: "", maximum: "" },
								]);
							}}
							onRemove={(rowId) =>
								setRows((current) => current.filter((row) => row.id !== rowId))
							}
						/>
					) : null}
					{strategy === "fixed-ranges" ? (
						<div className="grid min-w-0 gap-3 sm:grid-cols-2">
							{numberField(
								"lower-height",
								text.lowerHeight,
								lowerHeight,
								setLowerHeight,
								true,
							)}
							<Field
								htmlFor={`${id}-upper-heights`}
								label={text.upperHeights}
								hint={text.upperHint}
							>
								<Input
									id={`${id}-upper-heights`}
									value={upperHeights}
									onChange={(event) => setUpperHeights(event.target.value)}
								/>
							</Field>
						</div>
					) : null}
				</div>
			) : null}
			{step > 0 &&
			(!available ||
				result.status === "conflict" ||
				result.issues.length > 0) ? (
				<div
					role={result.status === "conflict" || !available ? "alert" : "status"}
					className={`min-w-0 space-y-1 rounded-md border p-3 text-xs ${result.status === "conflict" || !available ? "border-red-900 text-red-300" : "border-amber-900 text-amber-200"}`}
				>
					<p className="font-medium">{text.issues}</p>
					<ul className="list-disc space-y-1 pl-4">
						{!available ? <li>{text.unavailable}</li> : null}
						{result.issues.map((issue, index) => (
							<li key={`${issue.code}-${issue.rowId ?? ""}-${index}`}>
								{issueLabel(issue, rows, text)
									? `${issueLabel(issue, rows, text)}: `
									: ""}
								{issue.message[locale]}
							</li>
						))}
					</ul>
				</div>
			) : null}
			{step === 2 && canReview && result.proposal && result.goal ? (
				<div className="min-w-0 space-y-4">
					<section
						aria-label={text.proposal}
						className="min-w-0 space-y-3 rounded-md border border-zinc-800 p-3"
					>
						<p className="text-sm text-zinc-200">
							{codecNames[codec]} ·{" "}
							{new Intl.NumberFormat(locale).format(
								result.goal.minBitrate / 1000,
							)}
							–
							{new Intl.NumberFormat(locale).format(
								result.goal.maxBitrate / 1000,
							)}{" "}
							kbps
						</p>
						<p className="text-xs text-zinc-400">
							{strategy === "automatic"
								? text.automatic
								: strategy === "count" || input.automaticEdges
									? text.countSummary(
											result.goal.countPolicy.kind === "unrestricted"
												? Number(count)
												: result.goal.countPolicy.count,
										)
									: text.rowsSummary(result.goal.rows?.length ?? 0)}
						</p>
						{input.automaticEdges?.upperHeights?.length ? (
							<p className="text-xs text-zinc-400">{text.upperChoice}</p>
						) : null}
						<PerTitleLadder proposal={result.proposal} />
					</section>
					{result.status === "unverified" ? (
						<p role="status" className="text-xs text-amber-200">
							{text.unverified}
						</p>
					) : null}
					<p className="text-xs text-zinc-400">{text.nativeCheck}</p>
					{result.reasoning.length ? (
						<details className="min-w-0 text-xs text-zinc-400">
							<summary className="cursor-pointer text-zinc-300">
								{text.reasoning}
							</summary>
							<ul className="mt-2 list-disc space-y-1 pl-4">
								{result.reasoning.map((reason, index) => (
									<li key={`${reason.en}-${index}`}>{reason[locale]}</li>
								))}
							</ul>
						</details>
					) : null}
					<details className="min-w-0 text-xs text-zinc-400">
						<summary className="cursor-pointer text-zinc-300">
							{text.api}
						</summary>
						<pre className="mt-2 max-h-64 max-w-full overflow-auto rounded-md bg-zinc-950 p-3 text-xs">
							{JSON.stringify(result.proposal.api, null, 2)}
						</pre>
					</details>
				</div>
			) : null}
			<div className="flex min-w-0 flex-wrap items-center justify-between gap-2 border-t border-zinc-800 pt-4">
				<Button variant="ghost" onClick={onCancel}>
					{text.cancel}
				</Button>
				<div className="flex flex-wrap justify-end gap-2">
					{step > 0 ? (
						<Button
							variant="secondary"
							onClick={() => setStep((value) => value - 1)}
						>
							{text.back}
						</Button>
					) : null}
					{step < 2 ? (
						<Button
							disabled={step === 1 && !canReview}
							onClick={() => {
								if (step === 0 || canReview) setStep((value) => value + 1);
							}}
						>
							{text.next}
						</Button>
					) : (
						<Button disabled={!canReview || submitted} onClick={complete}>
							{text.complete}
						</Button>
					)}
				</div>
			</div>
		</section>
	);
}
